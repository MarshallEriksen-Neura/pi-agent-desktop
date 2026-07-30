"use client";

import { create } from "zustand";
import { getPiClient, isTauri } from "./client";
import { useChat, type ChatMessage } from "./chat";
import { useExtUi } from "./ext-ui";
import { t } from "../i18n";
import type { PiState } from "./protocol";

/**
 * Chat-session history — zustand in front, SQLite (Tauri/Rust) behind.
 * In the browser preview (mock transport) it falls back to localStorage so a
 * refresh still restores the conversation.
 *
 * Each record stores the desktop-side transcript (messages JSON) plus pi's
 * `sessionPath`, so switching a session both repaints the UI instantly and
 * points the pi process back at the matching session file.
 */

export interface ChatSessionMeta {
  id: string;
  name: string;
  sessionPath: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionsStore {
  sessions: ChatSessionMeta[];
  activeId: string | null;
  initialized: boolean;

  init: () => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

/* ── persistence backend: Tauri SQLite, or localStorage in browser preview ── */

interface StoredSession extends ChatSessionMeta {
  messages: ChatMessage[];
}

const LS_KEY = "pi-desktop.chat-sessions";

function lsRead(): StoredSession[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function lsWrite(all: StoredSession[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable (private mode) — history lives in memory only
  }
}

async function backendList(): Promise<ChatSessionMeta[]> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ChatSessionMeta[]>("chat_sessions_list");
  }
  return lsRead()
    .map(({ messages: _messages, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Read only the newest session's `sessionPath` without touching the store —
 * used at app launch (before `connect`) so pi can be spawned with
 * `--session <path>` and resume the full prior context in-process, instead of
 * starting blank and trying to catch up via a post-start `switch_session` RPC.
 * Returns "" when there is no prior session, the newest one has no pinned path
 * yet, or in browser preview.
 */
export async function peekLatestSessionPath(): Promise<string> {
  const list = await backendList();
  return list[0]?.sessionPath?.trim() ?? "";
}

async function backendLoad(id: string): Promise<ChatMessage[]> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const json = await invoke<string | null>("chat_session_load", { id });
    if (!json) return [];
    try {
      const arr = JSON.parse(json);
      return Array.isArray(arr) ? (arr as ChatMessage[]) : [];
    } catch {
      return [];
    }
  }
  return lsRead().find((s) => s.id === id)?.messages ?? [];
}

async function backendSave(meta: ChatSessionMeta, messages: ChatMessage[]) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("chat_session_save", {
      session: {
        id: meta.id,
        name: meta.name,
        sessionPath: meta.sessionPath,
        preview: meta.preview,
        messages: JSON.stringify(messages),
        createdAt: meta.createdAt,
      },
    });
    return;
  }
  const rest = lsRead().filter((s) => s.id !== meta.id);
  lsWrite([{ ...meta, updatedAt: Date.now(), messages }, ...rest]);
}

async function backendRename(id: string, name: string) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("chat_session_rename", { id, name });
    return;
  }
  lsWrite(lsRead().map((s) => (s.id === id ? { ...s, name } : s)));
}

async function backendDelete(id: string) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("chat_session_delete", { id });
    return;
  }
  lsWrite(lsRead().filter((s) => s.id !== id));
}

/* ── helpers ── */

const nowId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function createMeta(): ChatSessionMeta {
  const now = Date.now();
  return { id: nowId(), name: "", sessionPath: "", preview: "", createdAt: now, updatedAt: now };
}

function deriveName(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.text.trim());
  return first ? first.text.trim().slice(0, 40) : "";
}

function derivePreview(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.text.trim());
  return last ? last.text.trim().slice(0, 80) : "";
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** true while load() repaints the chat — the autosave listener must not fire */
let restoring = false;

/** Persist the active session with the current chat transcript right now. */
async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const { activeId, sessions } = useSessions.getState();
  if (!activeId) return;
  const current = sessions.find((s) => s.id === activeId);
  if (!current) return;
  const messages = useChat.getState().messages;
  const meta: ChatSessionMeta = {
    ...current,
    name: current.name || deriveName(messages),
    preview: derivePreview(messages),
    updatedAt: Date.now(),
  };
  useSessions.setState((s) => ({
    sessions: s.sessions
      .map((x) => (x.id === meta.id ? meta : x))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
  try {
    await backendSave(meta, messages);
  } catch {
    // persistence failure must never break the conversation flow
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 800);
}

/** Ask pi for its current session file path and pin it on the active record. */
async function syncSessionPath() {
  if (!isTauri()) return;
  try {
    const r = await getPiClient().request<PiState>({ type: "get_state" });
    const path = r.data?.sessionPath;
    const { activeId } = useSessions.getState();
    if (!path || !activeId) return;
    useSessions.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === activeId ? { ...x, sessionPath: path } : x
      ),
    }));
    const meta = useSessions
      .getState()
      .sessions.find((x) => x.id === activeId);
    if (meta) await backendSave(meta, useChat.getState().messages);
  } catch {
    // pi not ready yet — the next flushSave will still persist the transcript
  }
}

/* ── store ── */

export const useSessions = create<SessionsStore>((set, get) => ({
  sessions: [],
  activeId: null,
  initialized: false,

  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });

    const sessions = await backendList();
    set({ sessions });

    const latest = sessions[0];
    if (latest) {
      // refresh-restore: repaint the newest conversation…
      restoring = true;
      try {
        useChat.getState().load(await backendLoad(latest.id));
      } finally {
        restoring = false;
      }
      set({ activeId: latest.id });
      // …and point pi back at the matching session file. This is a fallback:
      // pi should already have resumed this session at startup via
      // `--session <path>`. If the RPC fails or pi refuses, warn loudly instead
      // of silently letting the agent run with no context while the UI shows
      // history (the exact "AI forgot" symptom this guards against).
      if (isTauri() && latest.sessionPath) {
        try {
          const r = await getPiClient().request({
            type: "switch_session",
            sessionPath: latest.sessionPath,
          });
          if (!r.success) {
            // pi refused the switch (file moved/invalid) — surface it so the
            // user knows the agent below is running without prior context.
            useExtUi.getState().pushToast(
              t("session.restoreRefused", { error: r.error ?? "" }),
              "warning",
            );
          }
        } catch {
          // pi unavailable / rpc timeout — UI history still works from the local
          // store, but the agent has no context. Tell the user, not just the console.
          useExtUi.getState().pushToast(t("session.restoreFailed"), "warning");
        }
      }
    } else {
      const meta = createMeta();
      set({ sessions: [meta], activeId: meta.id });
      void backendSave(meta, []);
    }
    void syncSessionPath();

    // autosave — every chat change lands in the active session (debounced)
    useChat.subscribe((s, prev) => {
      if (restoring || s.messages === prev.messages) return;
      scheduleSave();
    });

    // best-effort flush on refresh/close (localStorage path is synchronous)
    window.addEventListener("beforeunload", () => void flushSave());
  },

  newSession: async () => {
    const { activeId, sessions } = get();
    const active = sessions.find((s) => s.id === activeId);
    // reuse an untouched session instead of stacking empty ones
    if (active && useChat.getState().messages.length === 0) return;
    await flushSave();

    useChat.getState().clear();
    const meta = createMeta();
    set((s) => ({ sessions: [meta, ...s.sessions], activeId: meta.id }));
    void backendSave(meta, []);
    getPiClient()
      .request({ type: "new_session" })
      .then(() => syncSessionPath())
      .catch(() => {});
  },

  switchSession: async (id) => {
    if (id === get().activeId) return;
    await flushSave();

    restoring = true;
    try {
      useChat.getState().load(await backendLoad(id));
    } finally {
      restoring = false;
    }
    set({ activeId: id });

    const meta = get().sessions.find((s) => s.id === id);
    if (isTauri() && meta?.sessionPath) {
      try {
        const r = await getPiClient().request({
          type: "switch_session",
          sessionPath: meta.sessionPath,
        });
        if (!r.success) {
          useExtUi.getState().pushToast(
            t("session.restoreRefused", { error: r.error ?? "" }),
            "warning",
          );
        }
      } catch {
        // pi couldn't switch (file moved?) — transcript is still visible
        useExtUi.getState().pushToast(t("session.restoreFailed"), "warning");
      }
    }
  },

  renameSession: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, name: trimmed } : x)),
    }));
    try {
      await backendRename(id, trimmed);
    } catch {
      // keep the optimistic rename — it will persist with the next save
    }
  },

  deleteSession: async (id) => {
    try {
      await backendDelete(id);
    } catch {
      return; // deletion failed — keep the row rather than lying about it
    }
    const wasActive = get().activeId === id;
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      ...(wasActive ? { activeId: null } : {}),
    }));
    if (!wasActive) return;

    const next = get().sessions[0];
    if (next) {
      await get().switchSession(next.id);
    } else {
      useChat.getState().clear();
      const meta = createMeta();
      set((s) => ({ sessions: [meta, ...s.sessions], activeId: meta.id }));
      void backendSave(meta, []);
      getPiClient()
        .request({ type: "new_session" })
        .then(() => syncSessionPath())
        .catch(() => {});
    }
  },
}));

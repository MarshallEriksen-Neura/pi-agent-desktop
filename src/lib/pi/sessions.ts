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
 *
 * History is scoped per project root: the sidebar only ever lists conversations
 * belonging to the open project, and switching projects swaps the whole list.
 * Cross-project sessions must stay invisible — resuming one would point pi at a
 * session file recorded under a different cwd.
 */

export interface ChatSessionMeta {
  id: string;
  name: string;
  sessionPath: string;
  preview: string;
  /** Canonical project root this conversation belongs to ("" in browser preview). */
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionsStore {
  sessions: ChatSessionMeta[];
  activeId: string | null;
  initialized: boolean;
  /** Project root the current list is scoped to. */
  projectRoot: string;

  init: (projectRoot: string) => Promise<void>;
  /** Re-scope history to another project (called after the workspace switches). */
  switchProject: (projectRoot: string) => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

/**
 * Canonical project key — forward slashes, no trailing slash. Mirrors
 * `projects::project_key` in Rust so both sides agree on what "same project" is.
 */
export function projectKey(root: string | null | undefined): string {
  return (root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
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

async function backendList(projectRoot: string): Promise<ChatSessionMeta[]> {
  const key = projectKey(projectRoot);
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ChatSessionMeta[]>("chat_sessions_list", {
      projectRoot: key,
    });
  }
  return lsRead()
    .filter((s) => projectKey(s.projectRoot) === key)
    .map(({ messages: _messages, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Read only the newest session's `sessionPath` for `projectRoot`, without
 * touching the store — used at app launch and on project switch (before
 * `connect`/`restart`) so pi can be spawned with `--session <path>` and resume
 * the full prior context in-process, instead of starting blank and trying to
 * catch up via a post-start `switch_session` RPC.
 * Returns "" when the project has no prior session, the newest one has no
 * pinned path yet, or in browser preview.
 */
export async function peekLatestSessionPath(projectRoot: string): Promise<string> {
  const list = await backendList(projectRoot);
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
        projectRoot: projectKey(meta.projectRoot),
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

function createMeta(projectRoot: string): ChatSessionMeta {
  const now = Date.now();
  return {
    id: nowId(),
    name: "",
    sessionPath: "",
    preview: "",
    projectRoot: projectKey(projectRoot),
    createdAt: now,
    updatedAt: now,
  };
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

/** true once syncSessionPath has successfully captured pi's sessionPath */
let sessionPathSynced = false;

/**
 * Retry delays for syncSessionPath when pi isn't ready to answer get_state yet
 * (session resume, extension load, WSL hop can all delay readiness). The
 * initial call in init()/switchProject()/startFresh() may hit this window.
 */
const SYNC_DELAYS_MS = [2_000, 5_000, 10_000];

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

/**
 * Persist the active session right now. Exported for callers that are about to
 * tear down the pi process / swap projects and must not lose the transcript.
 */
export const flushActiveSession = () => flushSave();

/**
 * Ask pi for its current session file path and pin it on the active record.
 *
 * pi's `get_state` RPC returns `sessionFile` (full .jsonl path) and `sessionId`
 * (UUID). It does NOT return a field called `sessionPath` (that was a wrong
 * assumption in the original protocol types), and pi does NOT emit a `session`
 * event in RPC mode — so `client.lastSessionId` is always empty in practice.
 *
 * Both `sessionFile` and `sessionId` are valid for `--session <path|id>` at
 * process startup, which is how context is restored on the next launch.
 *
 * Without one of these, sessionPath stays empty in SQLite and the next app
 * launch spawns pi without `--session` — the agent loses all prior context
 * while the UI still shows history (the "AI forgot" symptom).
 */
async function syncSessionPath(): Promise<void> {
  if (!isTauri()) return;
  for (let attempt = 0; attempt <= SYNC_DELAYS_MS.length; attempt++) {
    let path = "";
    try {
      const r = await getPiClient().request<PiState>({ type: "get_state" });
      // pi returns sessionFile (full path) and sessionId (UUID), NOT sessionPath.
      // Prefer the full file path; fall back to the UUID. Both work with --session.
      path = r.data?.sessionFile ?? r.data?.sessionId ?? r.data?.sessionPath ?? "";
    } catch {
      // get_state not ready yet — will retry
    }
    // Fall back to the session id captured from pi's `session` event (rarely
    // populated in practice — pi RPC mode doesn't emit it — but harmless).
    if (!path) path = getPiClient().lastSessionId;

    const { activeId } = useSessions.getState();
    if (path && activeId) {
      sessionPathSynced = true;
      useSessions.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === activeId ? { ...x, sessionPath: path } : x
        ),
      }));
      const meta = useSessions
        .getState()
        .sessions.find((x) => x.id === activeId);
      if (meta) await backendSave(meta, useChat.getState().messages);
      return; // success
    }
    // Nothing yet — pi may still be booting. Retry.
    if (attempt < SYNC_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, SYNC_DELAYS_MS[attempt]));
    } else {
      console.warn(
        "[syncSessionPath] failed after retries — no sessionFile/sessionId from get_state. " +
          "Next launch will start pi without --session.",
      );
    }
  }
}

/** Repaint the chat from a stored transcript without tripping the autosave. */
async function repaint(id: string) {
  restoring = true;
  try {
    useChat.getState().load(await backendLoad(id));
  } finally {
    restoring = false;
  }
}

/** Begin an empty conversation in `projectRoot` and reset pi's session. */
function startFresh(projectRoot: string) {
  sessionPathSynced = false;
  useChat.getState().clear();
  const meta = createMeta(projectRoot);
  useSessions.setState((s) => ({
    sessions: [meta, ...s.sessions],
    activeId: meta.id,
  }));
  void backendSave(meta, []);
  getPiClient()
    .request({ type: "new_session" })
    .then(() => syncSessionPath())
    .catch(() => {});
}

/* ── store ── */

export const useSessions = create<SessionsStore>((set, get) => ({
  sessions: [],
  activeId: null,
  initialized: false,
  projectRoot: "",

  init: async (projectRoot) => {
    if (get().initialized) return;
    const key = projectKey(projectRoot);
    set({ initialized: true, projectRoot: key });

    const sessions = await backendList(key);
    set({ sessions });

    const latest = sessions[0];
    if (latest) {
      // refresh-restore: repaint this project's newest conversation. Pi was
      // already spawned with --session <path> in AppShell (via
      // peekLatestSessionPath), so the agent loop has the full prior context.
      // No switch_session RPC needed — just sync the path for future saves.
      await repaint(latest.id);
      set({ activeId: latest.id });
    } else {
      const meta = createMeta(key);
      set({ sessions: [meta], activeId: meta.id });
      void backendSave(meta, []);
    }
    void syncSessionPath();

    // Retry sessionPath sync when pi announces it's ready — the call above
    // may run before pi can answer get_state (slow boot, session resume, WSL
    // hop). The `session` event is pi's "ready for requests" signal, so it's
    // the most reliable trigger. The retry loop inside syncSessionPath is the
    // safety net in case this listener misses the event (connect() runs before
    // init()).
    getPiClient().on("session", () => {
      if (!sessionPathSynced) void syncSessionPath();
    });

    // autosave — every chat change lands in the active session (debounced)
    useChat.subscribe((s, prev) => {
      if (restoring || s.messages === prev.messages) return;
      scheduleSave();
    });

    // best-effort flush on refresh/close (localStorage path is synchronous)
    window.addEventListener("beforeunload", () => void flushSave());
  },

  switchProject: async (projectRoot) => {
    const key = projectKey(projectRoot);
    if (get().initialized && key === get().projectRoot) return;
    await flushSave(); // persist the outgoing project's transcript first
    sessionPathSynced = false;

    const sessions = await backendList(key);
    set({ initialized: true, projectRoot: key, sessions, activeId: null });

    const latest = sessions[0];
    if (latest) {
      // returning to a project resumes where it left off
      await repaint(latest.id);
      set({ activeId: latest.id });
      // Restart pi with the new project root and session path — both cwd
      // and context must change for the switched project.
      try {
        const { usePi } = await import("./store");
        await usePi.getState().restart(projectRoot, latest.sessionPath);
      } catch {
        // restart failed — UI still works from local store
      }
      void syncSessionPath();
    } else {
      startFresh(key);
    }
  },

  newSession: async () => {
    const { activeId, sessions, projectRoot } = get();
    const active = sessions.find((s) => s.id === activeId);
    // reuse an untouched session instead of stacking empty ones
    if (active && useChat.getState().messages.length === 0) return;
    await flushSave();
    startFresh(projectRoot);
  },

  switchSession: async (id) => {
    if (id === get().activeId) return;
    await flushSave();
    sessionPathSynced = false;

    await repaint(id);
    set({ activeId: id });

    const meta = get().sessions.find((s) => s.id === id);
    const sessionPath = meta?.sessionPath ?? "";

    if (sessionPath) {
      // Always restart pi with --session <path> to guarantee full context
      // restoration. The switch_session RPC is unreliable — pi may return
      // success without actually loading prior context into its agent loop,
      // leaving the agent with no memory while the UI shows history (the
      // "AI forgot" symptom). --session at spawn time is the only mechanism
      // proven to load the full transcript (past turns, tool results,
      // thinking) into the agent loop.
      try {
        const { usePi } = await import("./store");
        const { useWorkspace } = await import("../workspace");
        const root = useWorkspace.getState().root ?? undefined;
        await usePi.getState().restart(root, sessionPath);
        void syncSessionPath();
      } catch {
        useExtUi.getState().pushToast(t("session.restoreFailed"), "warning");
      }
    } else {
      // No session path was ever persisted for this conversation — pi cannot
      // resume prior context. Create a new session so the sessionPath gets
      // pinned for future launches, and tell the user explicitly.
      useExtUi.getState().pushToast(t("session.contextLost"), "warning", 8000);
      try {
        await getPiClient().request({ type: "new_session" });
        await syncSessionPath();
      } catch {
        // pi unavailable — sessionPath will stay empty, next switch retries
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
      startFresh(get().projectRoot);
    }
  },
}));

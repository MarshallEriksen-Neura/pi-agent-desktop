"use client";

import { create } from "zustand";
import { getPiClient } from "./client";
import type { PiEvent, AssistantMessageEvent, PiImage } from "./protocol";
import { showNotification } from "../notifications";
import { useUI } from "../store";
import { usePi } from "./store";
import { t } from "../i18n";
import { restoreFromTray } from "../window-close";

export interface ChatToolCall {
  id: string;
  name: string;
  args?: unknown;
  status: "running" | "done" | "error";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** pasted image attachments as data URLs — rendered in the bubble, persisted with the transcript */
  images?: string[];
  thinking: string;
  tools: ChatToolCall[];
  streaming: boolean;
  /** true when this message represents a failed run (pi error / crash / not connected) */
  isError?: boolean;
  /** human-readable error detail rendered in a banner */
  errorText?: string;
}

export interface RetryState {
  attempt: number;
  maxAttempts: number;
  reason?: string;
  status: "loading" | "success" | "error";
}

interface ChatStore {
  messages: ChatMessage[];
  streaming: boolean;
  initialized: boolean;
  queuedPrompts: string[];
  activeRetries: Map<string, RetryState>;

  init: () => void;
  send: (text: string, images?: string[]) => Promise<void>;
  abort: () => void;
  clear: () => void;
  /** Replace the conversation with persisted messages (session restore/switch). */
  load: (messages: ChatMessage[]) => void;
  queuePrompt: (text: string) => void;
  clearQueue: () => void;
  addRetry: (id: string, state: RetryState) => void;
  updateRetry: (id: string, updates: Partial<RetryState>) => void;
  removeRetry: (id: string) => void;
}

let seq = 0;
const nid = () => `msg-${++seq}`;

/** "data:image/png;base64,AAAA…" → pi RPC ImageContent, or null if not a base64 data URL */
function dataUrlToPiImage(dataUrl: string): PiImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return m ? { type: "image", data: m[2], mimeType: m[1] } : null;
}

/** immutable update of the last assistant message */
function patchLastAssistant(
  messages: ChatMessage[],
  fn: (m: ChatMessage) => ChatMessage
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const next = [...messages];
      next[i] = fn(messages[i]);
      return next;
    }
  }
  return messages;
}

/** buffer of the most recent pi stderr, used to enrich crash error messages */
let pendingStderr = "";

/** Build a zustand updater that appends (or upgrades the last) assistant message to an error bubble. */
function appendAssistantError(text: string) {
  return (s: ChatStore): Partial<ChatStore> => {
    const hasAssistant = s.messages.some((m) => m.role === "assistant");
    return {
      streaming: false,
      messages: hasAssistant
        ? patchLastAssistant(s.messages, (m) => ({
            ...m,
            streaming: false,
            isError: true,
            errorText: text,
            text: m.text || text,
          }))
        : [
            ...s.messages,
            {
              id: nid(),
              role: "assistant" as const,
              text: "",
              thinking: "",
              tools: [],
              streaming: false,
              isError: true,
              errorText: text,
            },
          ],
    };
  };
}

export const useChat = create<ChatStore>((set, get) => ({
  messages: [],
  streaming: false,
  initialized: false,
  queuedPrompts: [],
  activeRetries: new Map(),

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    const client = getPiClient();

    const ensureAssistant = () =>
      set((s) => {
        const last = s.messages[s.messages.length - 1];
        if (last?.role === "assistant" && last.streaming) return {};
        return {
          messages: [
            ...s.messages,
            {
              id: nid(),
              role: "assistant" as const,
              text: "",
              thinking: "",
              tools: [],
              streaming: true,
            },
          ],
        };
      });

    client.on("agent_start", () => set({ streaming: true }));
    client.on("message_start", () => ensureAssistant());

    // ── pi error / crash surfacing ──
    // All real pi errors land on stderr; an unexpected process exit means the
    // run was interrupted. Capture stderr so we can enrich the crash message,
    // and finalize the run as an error if pi dies mid-stream.
    client.onStderr((line) => {
      pendingStderr += line + "\n";
      if (pendingStderr.length > 8000) pendingStderr = pendingStderr.slice(-8000);
    });

    client.onExit((code) => {
      const s = get();
      if (!s.streaming) return; // not mid-run: a normal exit, ignore
      const detail = pendingStderr.trim();
      let errText: string;
      if (detail) {
        errText = `${t("agent.taskFailed")}\n\n${detail.slice(-2000)}`;
      } else if (typeof code === "number") {
        errText = t("agent.piExited", { code: String(code) });
      } else {
        errText = t("agent.piExitedUnknown");
      }
      useUI.getState().endAgentRun();
      usePi.setState({ status: "disconnected" });
      set(appendAssistantError(errText));
      pendingStderr = "";
      const { notificationSettings } = useUI.getState();
      if (notificationSettings.enabled) {
        showNotification(t("agent.taskFailedTitle"), { body: errText.slice(0, 120) });
      }
    });

    client.on("message_update", (e: PiEvent) => {
      if (e.type !== "message_update") return;
      const ev: AssistantMessageEvent = e.assistantMessageEvent;
      if (!ev?.delta) return;
      ensureAssistant();
      set((s) => ({
        messages: patchLastAssistant(s.messages, (m) =>
          ev.type === "thinking_delta"
            ? { ...m, thinking: m.thinking + ev.delta }
            : ev.type === "text_delta"
              ? { ...m, text: m.text + ev.delta }
              : m
        ),
      }));
    });

    client.on("message_end", () => {
      set((s) => {
        const updated = patchLastAssistant(s.messages, (m) => ({
          ...m,
          streaming: false,
        }));

        // Send notification if enabled and window is hidden
        const { notificationSettings } = useUI.getState();
        if (notificationSettings.enabled) {
          // Find the last assistant message
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === "assistant") {
              const msg = updated[i];
              const body = msg.text.slice(0, 60) + (msg.text.length > 60 ? "…" : "");
              showNotification("Pi finished", {
                body,
                onClick: () => {
                  // Restore the window from the system tray (show + focus).
                  // The DOM window.focus() alone cannot bring back a window
                  // that was hidden via Tauri's hide(), so we use the Tauri
                  // window API via restoreFromTray() instead.
                  void restoreFromTray();
                },
              });
              break;
            }
          }
        }

        return { messages: updated };
      });
    });

    client.on("tool_execution_start", (e: PiEvent) => {
      if (e.type !== "tool_execution_start") return;
      ensureAssistant();
      set((s) => ({
        messages: patchLastAssistant(s.messages, (m) => ({
          ...m,
          tools: [
            ...m.tools,
            {
              id: e.toolCallId,
              name: e.toolName,
              args: e.args,
              status: "running" as const,
            },
          ],
        })),
      }));
    });

    client.on("tool_execution_end", (e: PiEvent) => {
      if (e.type !== "tool_execution_end") return;
      set((s) => ({
        messages: s.messages.map((m) => ({
          ...m,
          tools: m.tools.map((t) =>
            t.id === e.toolCallId
              ? { ...t, status: e.isError ? ("error" as const) : ("done" as const) }
              : t
          ),
        })),
      }));
    });

    client.on("agent_settled", () =>
      set((s) => ({
        streaming: false,
        messages: s.messages.map((m) => ({ ...m, streaming: false })),
      }))
    );

    client.on("queue_update", (e: PiEvent) => {
      if (e.type !== "queue_update") return;
      const followUpCount = Array.isArray(e.followUp) ? e.followUp.length : 0;
      set({ queuedPrompts: Array(followUpCount).fill("") });
    });

    client.on("auto_retry_start", (e: PiEvent) => {
      if (e.type !== "auto_retry_start") return;
      const id = `retry-${Date.now()}`;
      get().addRetry(id, {
        attempt: e.attempt,
        maxAttempts: e.maxAttempts,
        status: "loading",
      });
    });

    client.on("auto_retry_end", (e: PiEvent) => {
      if (e.type !== "auto_retry_end") return;
      // Find the most recent loading retry and update it
      const retries = get().activeRetries;
      for (const [id, state] of retries.entries()) {
        if (state.status === "loading") {
          get().updateRetry(id, {
            status: e.success ? "success" : "error",
            reason: e.finalError,
          });
          break;
        }
      }
    });
  },

  send: async (text, images) => {
    const trimmed = text.trim();
    const piImages = (images ?? [])
      .map(dataUrlToPiImage)
      .filter((x): x is PiImage => x !== null);
    if (!trimmed && piImages.length === 0) return;

    // Fast feedback when pi isn't connected at all — don't leave the user blind.
    const piStatus = usePi.getState().status;
    const piUsable = piStatus === "ready" || piStatus === "running";
    if (!piUsable) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: nid(),
            role: "user" as const,
            text: trimmed,
            ...(images?.length ? { images } : {}),
            thinking: "",
            tools: [],
            streaming: false,
          },
          {
            id: nid(),
            role: "assistant" as const,
            text: "",
            thinking: "",
            tools: [],
            streaming: false,
            isError: true,
            errorText: t("agent.piUnavailable"),
          },
        ],
      }));
      return;
    }

    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: nid(),
          role: "user" as const,
          text: trimmed,
          ...(images?.length ? { images } : {}),
          thinking: "",
          tools: [],
          streaming: false,
        },
      ],
      streaming: true,
    }));

    try {
      const res = await getPiClient().request({
        type: "prompt",
        message: trimmed,
        ...(piImages.length ? { images: piImages } : {}),
      });
      if (!res.success) {
        set(appendAssistantError(res.error || t("agent.taskFailed")));
      }
    } catch {
      // A thrown request means no ack (timeout / pi died mid-send). Only surface
      // it when pi is clearly not connected, and avoid duplicating a crash banner
      // that onExit may have already appended.
      if (usePi.getState().status === "disconnected") {
        const last = get().messages[get().messages.length - 1];
        if (!last || !last.isError) {
          set(appendAssistantError(t("agent.piNoResponse")));
        }
      }
    }
  },

  abort: () => {
    getPiClient().send({ type: "abort" });
    // Reset UI immediately: stop the streaming spinner and drop any in-flight
    // retries so the composer flips back to "send" without waiting for events.
    set((s) => {
      const next = new Map<string, RetryState>();
      for (const [id, st] of s.activeRetries) {
        if (st.status !== "loading") next.set(id, st);
      }
      return {
        streaming: false,
        activeRetries: next,
        messages: s.messages.map((m) => ({ ...m, streaming: false })),
      };
    });
  },

  clear: () => set({ messages: [], streaming: false }),

  load: (messages) => {
    // continue the id sequence past loaded ids so new messages never collide
    for (const m of messages) {
      const n = Number(m.id.replace(/^msg-/, ""));
      if (Number.isFinite(n) && n >= seq) seq = n + 1;
    }
    set({
      streaming: false,
      messages: messages.map((m) => ({
        ...m,
        streaming: false,
        tools: (m.tools ?? []).map((t) =>
          t.status === "running" ? { ...t, status: "done" as const } : t
        ),
      })),
    });
  },

  queuePrompt: (text) => {
    set((s) => ({ queuedPrompts: [...s.queuedPrompts, text] }));
  },

  clearQueue: () => {
    set({ queuedPrompts: [] });
  },

  addRetry: (id, state) => {
    set((s) => {
      const newRetries = new Map(s.activeRetries);
      newRetries.set(id, state);
      return { activeRetries: newRetries };
    });
  },

  updateRetry: (id, updates) => {
    set((s) => {
      const newRetries = new Map(s.activeRetries);
      const existing = newRetries.get(id);
      if (existing) {
        newRetries.set(id, { ...existing, ...updates });
      }
      return { activeRetries: newRetries };
    });
  },

  removeRetry: (id) => {
    set((s) => {
      const newRetries = new Map(s.activeRetries);
      newRetries.delete(id);
      return { activeRetries: newRetries };
    });
  },
}));

"use client";

import { create } from "zustand";
import { getPiClient } from "./client";
import type { PiEvent, AssistantMessageEvent, PiImage } from "./protocol";
import { showNotification } from "../notifications";
import { useUI } from "../store";
import { usePi } from "./store";
import { useExtUi } from "./ext-ui";
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
  /**
   * Set on user messages handed to pi while a turn was already in flight:
   * `steer` was injected into that turn, `followUp` waited for it to end.
   * Absent on ordinary prompts.
   */
  delivery?: DeliveryMode;
}

/** How a message reaches pi when a turn is already running. */
export type DeliveryMode = "steer" | "followUp";

/**
 * A message handed to pi mid-turn that pi has not consumed yet.
 *
 * pi is authoritative about how many of these are still pending (`queue_update`);
 * we are authoritative about their text, because the event's item shape is not
 * pinned down by the protocol types.
 */
export interface QueueEntry {
  id: string;
  kind: DeliveryMode;
  /** original text, or "" for an item pi reported that we never sent ourselves */
  text: string;
}

export interface RetryState {
  attempt: number;
  maxAttempts: number;
  reason?: string;
  status: "loading" | "success" | "error";
  /** how many attempt sequences pi has started for this turn (1 = the first) */
  rounds?: number;
}

interface ChatStore {
  messages: ChatMessage[];
  streaming: boolean;
  initialized: boolean;
  /** messages already handed to pi mid-turn and not consumed yet */
  queue: QueueEntry[];
  activeRetries: Map<string, RetryState>;

  init: () => void;
  send: (text: string, images?: string[]) => Promise<void>;
  /** inject into the running turn — pi picks it up without finishing first */
  steer: (text: string, images?: string[]) => Promise<void>;
  /** hand to pi's queue — it runs once the current turn ends */
  followUp: (text: string, images?: string[]) => Promise<void>;
  abort: () => void;
  clear: () => void;
  /** Replace the conversation with persisted messages (session restore/switch). */
  load: (messages: ChatMessage[]) => void;
  /** drop the local view of pi's queue (abort / session switch) */
  clearQueue: () => void;
  addRetry: (id: string, state: RetryState) => void;
  updateRetry: (id: string, updates: Partial<RetryState>) => void;
  removeRetry: (id: string) => void;
}

let seq = 0;
const nid = () => `msg-${++seq}`;
let qseq = 0;
const qid = () => `q-${++qseq}`;

/**
 * The one retry row. pi retries a request sequentially, so every attempt is the
 * same event in the user's eyes — a fresh key per `auto_retry_start` used to
 * turn a rate-limited provider into a wall of stacked banners.
 */
const RETRY_ID = "retry-active";

/** pull the text out of a `queue_update` item — its shape is not in the spec */
function queueItemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const k of ["message", "text", "content", "prompt"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
  }
  return "";
}

/**
 * Merge pi's pending counts into the local queue view, per lane.
 *
 * Items are consumed FIFO, so a shorter list from pi means the front entries
 * ran — keep the tail and its text. A lane pi does not report at all is left
 * untouched rather than emptied, so a partial event cannot wipe the chip.
 */
function reconcileQueue(
  local: QueueEntry[],
  steering?: unknown[],
  followUp?: unknown[]
): QueueEntry[] {
  const lanes: [DeliveryMode, unknown[] | undefined][] = [
    ["steer", steering],
    ["followUp", followUp],
  ];
  const out: QueueEntry[] = [];
  for (const [kind, items] of lanes) {
    const mine = local.filter((q) => q.kind === kind);
    if (!Array.isArray(items)) {
      out.push(...mine);
      continue;
    }
    const kept = mine.slice(Math.max(0, mine.length - items.length));
    for (let i = 0; i < items.length; i++) {
      out.push(kept[i] ?? { id: qid(), kind, text: queueItemText(items[i]) });
    }
  }
  return out;
}

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

/** stderr lines that look like a real failure rather than ordinary logging */
const STDERR_ERROR =
  /\b(error|exception|failed|fatal|unauthorized|forbidden|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|[45]\d\d)\b/i;

/** last toast time per message, so a stack trace cannot flood the UI */
const stderrToastAt = new Map<string, number>();
const STDERR_TOAST_THROTTLE_MS = 5000;

/**
 * Throttled warning toast for error-looking stderr while pi is still alive.
 * `warning` (not `error`) on purpose: stderr has no defined semantics upstream,
 * so a keyword hit is a hint, not a confirmed failure.
 */
function surfaceStderrLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || !STDERR_ERROR.test(trimmed)) return;
  if (!useChat.getState().streaming) return; // outside a run it is just noise

  const message = trimmed.slice(0, 140);
  const now = Date.now();
  const last = stderrToastAt.get(message);
  if (last !== undefined && now - last < STDERR_TOAST_THROTTLE_MS) return;
  stderrToastAt.set(message, now);
  // bound the throttle map — drop entries older than the window
  for (const [k, ts] of stderrToastAt) {
    if (now - ts > STDERR_TOAST_THROTTLE_MS) stderrToastAt.delete(k);
  }
  useExtUi.getState().pushToast(message, "warning", 6000);
}

/**
 * Provider failures arrive as the raw upstream body — pi passes the response
 * through verbatim, e.g.
 * `429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}`.
 * Keep the status prefix and the human sentence, drop the JSON envelope.
 */
export function formatUpstreamError(raw: string): string {
  const s = raw.trim();
  const at = s.indexOf("{");
  if (at === -1) return s;
  let body: unknown;
  try {
    body = JSON.parse(s.slice(at));
  } catch {
    return s; // truncated body, or prose that just happens to contain a brace
  }
  const detail = upstreamErrorDetail(body);
  if (!detail) return s;
  const prefix = s.slice(0, at).replace(/[\s:—–-]+$/u, "").trim();
  return prefix ? `${prefix} ${detail}` : detail;
}

/** `{message}` / `{error:{message}}` / `{error:"…"}` — the shapes providers use */
function upstreamErrorDetail(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const o = body as Record<string, unknown>;
  for (const k of ["message", "error_description", "detail"]) {
    if (typeof o[k] === "string" && o[k]) return o[k] as string;
  }
  return o.error ? upstreamErrorDetail(o.error) : "";
}

/** drop retry rows that are still spinning — the turn they belong to is over */function dropLoadingRetries(
  retries: Map<string, RetryState>
): Map<string, RetryState> {
  const next = new Map<string, RetryState>();
  for (const [id, r] of retries) if (r.status !== "loading") next.set(id, r);
  return next;
}

/** Build a zustand updater that appends (or upgrades the last) assistant message to an error bubble. */
function appendAssistantError(text: string) {
  return (s: ChatStore): Partial<ChatStore> => {
    // A failed request may not have emitted message_start yet. In that case
    // the last assistant message belongs to the previous turn and must remain
    // untouched; append a new failure bubble for the current user message.
    const last = s.messages[s.messages.length - 1];
    const hasCurrentAssistant = last?.role === "assistant";
    return {
      streaming: false,
      messages: hasCurrentAssistant
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

/**
 * Hand a message to pi while a turn is already in flight.
 *
 * `steer` is injected into the running turn (a real interrupt — pi changes
 * course without finishing first); `follow_up` sits in pi's queue until the
 * turn ends. Either way **pi owns execution from here**, so the frontend must
 * not re-send the text when the run settles.
 *
 * There is no un-queue command in the RPC protocol: once handed over, the only
 * way to take it back is `abort`.
 */
async function deliverMidTurn(
  kind: DeliveryMode,
  text: string,
  images?: string[]
): Promise<void> {
  const trimmed = text.trim();
  const piImages = (images ?? [])
    .map(dataUrlToPiImage)
    .filter((x): x is PiImage => x !== null);
  if (!trimmed && piImages.length === 0) return;

  const entryId = qid();
  const messageId = nid();

  // Optimistic: the bubble and the queue chip appear immediately. pi confirms
  // via `queue_update`, but nothing in the spec promises it will send one.
  useChat.setState((s) => ({
    messages: [
      ...s.messages,
      {
        id: messageId,
        role: "user" as const,
        text: trimmed,
        ...(images?.length ? { images } : {}),
        thinking: "",
        tools: [],
        streaming: false,
        delivery: kind,
      },
    ],
    queue: [...s.queue, { id: entryId, kind, text: trimmed }],
  }));

  /** roll back the optimistic queue entry and mark the bubble undelivered */
  const reject = (detail: string) => {
    useChat.setState((s) => ({
      queue: s.queue.filter((q) => q.id !== entryId),
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, isError: true, errorText: detail } : m
      ),
    }));
    useExtUi.getState().pushToast(detail, "error", 5000);
  };

  const payload = {
    message: trimmed,
    ...(piImages.length ? { images: piImages } : {}),
  };

  try {
    const res = await getPiClient().request(
      kind === "steer"
        ? { type: "steer", ...payload }
        : { type: "follow_up", ...payload }
    );
    if (!res.success) {
      reject(
        res.error ||
          t(kind === "steer" ? "queue.steerFailed" : "queue.followUpFailed")
      );
    }
  } catch {
    // no ack within the rpc timeout — pi is wedged or gone
    reject(t("queue.noAck"));
  }
}

export const useChat = create<ChatStore>((set, get) => ({
  messages: [],
  streaming: false,
  initialized: false,
  queue: [],
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
    // Per the upstream RPC spec every *protocol* error arrives on stdout as a
    // JSONL event (response.error / extension_error / auto_retry_* /
    // compaction_end / message_update type="error"). stderr carries no defined
    // semantics, so it is a diagnostic fallback only: buffered to enrich crash
    // messages, plus a throttled warning toast for error-looking lines so a
    // still-alive pi complaining on stderr is not completely invisible.
    client.onStderr((line) => {
      pendingStderr += line + "\n";
      if (pendingStderr.length > 8000) pendingStderr = pendingStderr.slice(-8000);
      surfaceStderrLine(line);
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

      // Auto-reconnect: pi crashed mid-run. After a short delay, if nobody
      // else has reconnected (restart(), manual action), resume the active
      // session so the user doesn't have to restart the app. The sessionPath
      // ensures pi reloads the full prior context via --session.
      setTimeout(() => {
        if (usePi.getState().status !== "disconnected") return; // already reconnected
        void (async () => {
          try {
            const { useSessions } = await import("./sessions");
            const { useWorkspace } = await import("../workspace");
            const root = useWorkspace.getState().root ?? undefined;
            const activeId = useSessions.getState().activeId;
            const meta = useSessions
              .getState()
              .sessions.find((x) => x.id === activeId);
            useExtUi.getState().pushToast(t("agent.reconnecting"), "info", 4000);
            await usePi.getState().connect({
              cwd: root,
              resumePath: meta?.sessionPath || undefined,
            });
          } catch {
            // auto-reconnect failed — user will need to restart manually
          }
        })();
      }, 3000);
    });

    client.on("message_update", (e: PiEvent) => {
      if (e.type !== "message_update") return;
      const ev: AssistantMessageEvent = e.assistantMessageEvent;
      if (!ev) return;

      // Model-layer failure — the main channel for provider errors that pi does
      // not retry. It carries no `delta`, so it must be handled before the
      // delta guard below or it is silently dropped.
      if (ev.type === "error") {
        const reason = typeof ev.reason === "string" ? ev.reason : "error";
        if (reason === "aborted") {
          // user interrupt, not a failure — just settle the stream
          set((s) => ({
            streaming: false,
            messages: s.messages.map((m) => ({ ...m, streaming: false })),
          }));
          return;
        }
        const extra =
          typeof ev.message === "string"
            ? formatUpstreamError(ev.message)
            : typeof ev.error === "string"
              ? formatUpstreamError(ev.error)
              : "";
        const text = t("agent.modelError", { reason });
        set(appendAssistantError(extra ? `${text}\n\n${extra}` : text));
        useUI.getState().endAgentRun();
        return;
      }

      if (!ev.delta) return;
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
        // pi drains steering and follow-ups before it settles, so nothing can
        // still be pending here. Clearing unconditionally also means a pi build
        // that never emits `queue_update` cannot leave a stuck chip behind.
        queue: [],
        // Same for a retry pi never closed with `auto_retry_end`: the turn is
        // over, so the row must not keep spinning with a live Stop button.
        activeRetries: dropLoadingRetries(s.activeRetries),
      }))
    );

    client.on("queue_update", (e: PiEvent) => {
      if (e.type !== "queue_update") return;
      set((s) => ({ queue: reconcileQueue(s.queue, e.steering, e.followUp) }));
    });

    // This is the real channel for transient provider failures (429 / 5xx /
    // overloaded / token limits) — `errorMessage` carries the upstream text.
    client.on("auto_retry_start", (e: PiEvent) => {
      if (e.type !== "auto_retry_start") return;
      const prev = get().activeRetries.get(RETRY_ID);
      const live = prev?.status === "loading" ? prev : undefined;
      // Retries are sequential, so they share one row. pi also restarts the
      // attempt counter for every request it retries — a provider that keeps
      // rate-limiting sends 1/3, 2/3, 1/3, 2/3, … — so count those rounds
      // instead of stacking a banner per attempt.
      get().addRetry(RETRY_ID, {
        attempt: e.attempt,
        maxAttempts: e.maxAttempts,
        status: "loading",
        rounds: live ? (live.rounds ?? 1) + (e.attempt <= live.attempt ? 1 : 0) : 1,
        ...(e.errorMessage ? { reason: formatUpstreamError(e.errorMessage) } : {}),
      });
    });

    // Context compaction: `aborted` is benign (user/agent cancelled it),
    // `errorMessage` is a real failure. `willRetry` means pi re-sends the prompt
    // by itself, so staying silent there avoids a confusing double signal.
    client.on("compaction_end", (e: PiEvent) => {
      if (e.type !== "compaction_end") return;
      if (e.errorMessage) {
        useExtUi
          .getState()
          .pushToast(
            t("compaction.failed", {
              error: formatUpstreamError(e.errorMessage).slice(0, 120),
            }),
            "error",
            6000
          );
        return;
      }
      if (e.aborted) {
        useExtUi.getState().pushToast(t("compaction.aborted"), "info", 4000);
      }
    });

    client.on("auto_retry_end", (e: PiEvent) => {
      if (e.type !== "auto_retry_end") return;
      // One slot, so this resolves the row the attempts have been updating.
      const retry = get().activeRetries.get(RETRY_ID);
      const finalError = e.finalError
        ? formatUpstreamError(e.finalError)
        : retry?.reason;

      if (retry) {
        get().updateRetry(RETRY_ID, {
          status: e.success ? "success" : "error",
          attempt: e.attempt,
          // keep the auto_retry_start trigger text when pi sends no
          // finalError, otherwise the banner loses its only error detail
          ...(finalError ? { reason: finalError } : {}),
        });
      }

      // The retry banner disappears after five seconds. A terminal provider
      // failure must also live in the transcript, otherwise the user loses the
      // upstream error as soon as that transient status row is gone.
      if (!e.success && get().streaming) {
        const reason = finalError || t("agent.taskFailed");
        set(appendAssistantError(t("retry.failed", { reason })));
        useUI.getState().endAgentRun();
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
      // A thrown request means no ack (rpc timeout / pi died mid-send). Surface
      // it regardless of connection status — a live-but-unresponsive pi used to
      // leave `streaming` stuck on true, spinning the composer forever. The only
      // thing we skip is a duplicate banner when onExit already wrote one.
      const last = get().messages[get().messages.length - 1];
      if (last?.isError) {
        set({ streaming: false }); // banner already there, just settle the UI
      } else {
        set(appendAssistantError(t("agent.piNoResponse")));
      }
      useUI.getState().endAgentRun();
    }
  },

  steer: (text, images) => deliverMidTurn("steer", text, images),

  followUp: (text, images) => deliverMidTurn("followUp", text, images),

  abort: () => {
    const client = getPiClient();
    const s = get();

    // The turn itself.
    client.send({ type: "abort" });

    // Two side-channels `abort` does not reach on its own: a retry waiting out
    // its backoff, and a bash tool that is already running in a child process.
    const retrying = [...s.activeRetries.values()].some((r) => r.status === "loading");
    if (retrying) client.send({ type: "abort_retry" });
    const bashRunning = s.messages.some((m) =>
      m.tools.some((tl) => tl.status === "running" && /^(bash|shell)$/i.test(tl.name))
    );
    if (bashRunning) client.send({ type: "abort_bash" });

    // Reset UI immediately: stop the streaming spinner, drop any in-flight
    // retries, and clear the queue view — aborting is the only way to discard
    // messages already handed to pi, so the chip must not outlive it.
    set((st) => ({
      streaming: false,
      activeRetries: dropLoadingRetries(st.activeRetries),
      queue: [],
      messages: st.messages.map((m) => ({ ...m, streaming: false })),
    }));
  },

  clear: () => set({ messages: [], streaming: false, queue: [] }),

  load: (messages) => {
    // continue the id sequence past loaded ids so new messages never collide
    for (const m of messages) {
      const n = Number(m.id.replace(/^msg-/, ""));
      if (Number.isFinite(n) && n >= seq) seq = n + 1;
    }
    set({
      streaming: false,
      queue: [],
      messages: messages.map((m) => ({
        ...m,
        streaming: false,
        tools: (m.tools ?? []).map((t) =>
          t.status === "running" ? { ...t, status: "done" as const } : t
        ),
      })),
    });
  },

  clearQueue: () => {
    set({ queue: [] });
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

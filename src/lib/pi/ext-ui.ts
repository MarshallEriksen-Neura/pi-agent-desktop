"use client";

import { create } from "zustand";
import { onAnyTaskEvent, onPiClientDisposed, peekPiClient } from "./client";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  PiEvent,
} from "./protocol";
import { t } from "../i18n";
import { piRequestErrorText } from "./request-error";
import { getPort } from "../backend/composition/container";
import { getActiveTaskId, useTaskContext } from "./task-context";

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "warning" | "error";
}

/** A widget is a block of text lines an extension pins around the composer. */
export interface ExtWidget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

/** Methods that need a modal sheet and a response. */
export const MODAL_METHODS = new Set(["confirm", "select", "input", "editor"]);

/** Fallback key when an extension omits statusKey/widgetKey. */
const DEFAULT_KEY = "default";

/**
 * A pending request plus the task whose pi process is blocked on it. pi holds
 * the turn open until the harness writes back on *that* process's stdin, so the
 * task id has to survive until the user answers — answering the focused task
 * instead would leave the real one hung and inject a stray reply id elsewhere.
 */
export type QueuedExtRequest = ExtensionUiRequest & { taskId: string };

interface ExtUiStore {
  /** modal requests across every task, oldest first; `queue[0]` is on screen */
  queue: QueuedExtRequest[];
  toasts: Toast[];
  /** taskId → statusKey → text, rendered in that task's agent panel header */
  statuses: Record<string, Record<string, string>>;
  /** taskId → widgetKey → lines + placement, rendered around the composer */
  widgets: Record<string, Record<string, ExtWidget>>;
  /** text an extension wants dropped into the composer; null once consumed */
  editorText: string | null;
  initialized: boolean;

  init: () => void;
  respond: (
    req: QueuedExtRequest,
    payload:
      | { value: string }
      | { confirmed: boolean }
      | { cancelled: true },
    /**
     * Drop the prompt even if the write to pi fails.
     *
     * Set this for the user's way out (Cancel, Escape). A failed write means the
     * pipe is gone, so the extension is blocked no matter what we do — and since
     * Cancel routes through this same write, leaving the sheet up on failure
     * would wedge it permanently with no remaining escape. An *answer* keeps the
     * old behaviour: the sheet stays so the choice can be retried rather than
     * silently lost.
     */
    opts?: { closing?: boolean }
  ) => void;
  dismissToast: (id: string) => void;
  /**
   * Push an app-level toast (not from a pi extension). Auto-dismisses after
   * `ms` (default 5000). Used for non-extension surfaces such as the
   * session-restore fallback warning.
   */
  pushToast: (message: string, kind?: Toast["kind"], ms?: number) => void;
  /** AgentPanel calls this once it has moved editorText into its draft. */
  clearEditorText: () => void;
}

let toastSeq = 0;

/** setTitle — reflect in the document and, under Tauri, the native window. */
function applyTitle(title: string) {
  if (typeof document !== "undefined") document.title = title;
  void getPort("window")
    .setTitle(title)
    .catch(() => {
      // window handle unavailable — the document title still updated
    });
}

/**
 * Write a reply to the pi process that asked. Deliberately uses `peekPiClient`:
 * if that task's client is already gone (project switch, deleted session) there
 * is nobody to answer, and spawning a fresh process to write into would be
 * worse than dropping the reply.
 *
 * `write`, not `request`: pi's dispatcher intercepts `extension_ui_response`,
 * resolves the extension's promise and returns without emitting a `response`.
 * Awaiting an ack here meant every answered dialog sat on screen for the full
 * 15s request timeout and then reported a failure — while pi had in fact taken
 * the answer and moved on. A rejected *write* is still worth surfacing, since
 * then the answer really did not land.
 */
async function sendExtensionResponse(
  taskId: string,
  response: ExtensionUiResponse
): Promise<string | null> {
  const client = peekPiClient(taskId);
  if (!client) return null;
  try {
    await client.write(response);
    return null;
  } catch (error) {
    return piRequestErrorText(error);
  }
}

export const useExtUi = create<ExtUiStore>((set, get) => ({
  queue: [],
  toasts: [],
  statuses: {},
  widgets: {},
  editorText: null,
  initialized: false,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });

    /* Subscribed across *all* tasks, not to one client. This runs at boot,
       before `useSessions.init()` has resolved the first conversation, so there
       is no task id to bind to yet — and every real task id is a UUID, so a
       plain `getPiClient()` here silently bound to the `"default"` task that no
       conversation ever uses. Every extension surface was dead as a result, and
       a blocking `select`/`editor` hung its turn forever. */
    onAnyTaskEvent("extension_ui_request", (taskId: string, e: PiEvent) => {
      if (e.type !== "extension_ui_request") return;
      const req = e as ExtensionUiRequest;

      switch (req.method) {
        case "notify":
          get().pushToast(req.message ?? "", req.notifyType ?? "info", 3800);
          return;

        case "setStatus": {
          // omitted statusText clears the entry for that key
          const key = req.statusKey ?? DEFAULT_KEY;
          set((s) => {
            const forTask = { ...(s.statuses[taskId] ?? {}) };
            if (req.statusText) forTask[key] = req.statusText;
            else delete forTask[key];
            const statuses = { ...s.statuses };
            if (Object.keys(forTask).length > 0) statuses[taskId] = forTask;
            else delete statuses[taskId];
            return { statuses };
          });
          return;
        }

        case "setWidget": {
          // omitted widgetLines clears the widget for that key
          const key = req.widgetKey ?? DEFAULT_KEY;
          set((s) => {
            const forTask = { ...(s.widgets[taskId] ?? {}) };
            if (req.widgetLines?.length) {
              forTask[key] = {
                lines: req.widgetLines,
                placement: req.widgetPlacement ?? "aboveEditor",
              };
            } else {
              delete forTask[key];
            }
            const widgets = { ...s.widgets };
            if (Object.keys(forTask).length > 0) widgets[taskId] = forTask;
            else delete widgets[taskId];
            return { widgets };
          });
          return;
        }

        // Both of these target a single shared surface — the OS window title
        // and the one composer on screen — so only the focused conversation may
        // drive them. A background task retitling the window or pasting into
        // the composer the user is typing in would be a regression, and before
        // this file listened cross-task it could not happen.
        case "setTitle":
          if (req.title && taskId === getActiveTaskId()) applyTitle(req.title);
          return;

        case "set_editor_text":
          if (taskId === getActiveTaskId()) set({ editorText: req.text ?? "" });
          return;
      }

      if (MODAL_METHODS.has(req.method)) {
        set((s) => ({ queue: [...s.queue, { ...req, taskId }] }));
        // pi only arms a timeout when the extension passed one; when it does, it
        // resolves its own side on expiry without telling us, so drop the sheet
        // rather than leave a prompt whose answer goes nowhere.
        if (req.timeout && req.timeout > 0) {
          setTimeout(() => {
            set((s) => ({ queue: s.queue.filter((q) => q.id !== req.id) }));
          }, req.timeout);
        }
        return;
      }

      // unknown future method — cancel politely so extensions never hang on us
      void sendExtensionResponse(taskId, {
        type: "extension_ui_response",
        id: req.id,
        cancelled: true,
      }).then((error) => {
        if (error) get().pushToast(error, "error", 6000);
      });
    });

    /* A disposed client can never answer, and its surfaces belong to a task
       that no longer exists. Drop both so a dead prompt cannot sit on screen
       blocking the sheet behind it. */
    onPiClientDisposed((taskId: string) => {
      set((s) => {
        const statuses = { ...s.statuses };
        const widgets = { ...s.widgets };
        delete statuses[taskId];
        delete widgets[taskId];
        return {
          queue: s.queue.filter((q) => q.taskId !== taskId),
          statuses,
          widgets,
        };
      });
    });

    // An extension threw. Previously dropped on the floor: the event was typed
    // but never subscribed. The raw `error` can be a full stack trace, so the
    // toast carries only extension + event name and the detail goes to console.
    onAnyTaskEvent("extension_error", (_taskId: string, e: PiEvent) => {
      if (e.type !== "extension_error") return;
      const name = e.extensionPath.split(/[\\/]/).pop() || e.extensionPath;
      console.error(`[pi extension] ${e.extensionPath} failed on ${e.event}:`, e.error);
      get().pushToast(t("ext.error", { name, event: e.event }), "error", 6000);
    });
  },

  respond: (req, payload, opts) => {
    const drop = () =>
      set((s) => ({ queue: s.queue.filter((q) => q.id !== req.id) }));
    if (opts?.closing) drop();
    void sendExtensionResponse(req.taskId, {
      type: "extension_ui_response",
      id: req.id,
      ...payload,
    } as ExtensionUiResponse).then((error) => {
      if (error) {
        // Keep the sheet open so a failed write does not look like the extension
        // accepted the user's choice — unless this *was* the way out, in which
        // case it is already gone.
        get().pushToast(error, "error", 6000);
        return;
      }
      drop();
    });
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  pushToast: (message, kind = "info", ms = 5000) => {
    const id = `toast-${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => get().dismissToast(id), ms);
  },

  clearEditorText: () => set({ editorText: null }),
}));

/**
 * The focused conversation's `setStatus` entries. Statuses are stored per task
 * because two parallel conversations running the same extension would otherwise
 * overwrite each other under a shared `statusKey`.
 */
export function useActiveExtStatuses(): Record<string, string> {
  const taskId = useTaskContext((s) => s.activeTaskId);
  return useExtUi((s) => s.statuses[taskId] ?? EMPTY_STATUSES);
}

/** The focused conversation's `setWidget` blocks. Same per-task reasoning. */
export function useActiveExtWidgets(): Record<string, ExtWidget> {
  const taskId = useTaskContext((s) => s.activeTaskId);
  return useExtUi((s) => s.widgets[taskId] ?? EMPTY_WIDGETS);
}

/* Stable empty references — a fresh `{}` per render would make these selectors
   return a new object every time and re-render the surfaces on any store
   change. */
const EMPTY_STATUSES: Record<string, string> = {};
const EMPTY_WIDGETS: Record<string, ExtWidget> = {};

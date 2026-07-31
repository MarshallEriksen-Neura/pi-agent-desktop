"use client";

import { create } from "zustand";
import { getPiClient, isTauri } from "./client";
import type { ExtensionUiRequest, PiEvent } from "./protocol";
import { t } from "../i18n";

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
const MODAL_METHODS = new Set(["confirm", "select", "input", "editor"]);

/** Fallback key when an extension omits statusKey/widgetKey. */
const DEFAULT_KEY = "default";

interface ExtUiStore {
  queue: ExtensionUiRequest[];
  toasts: Toast[];
  /** statusKey → text, rendered in the agent panel header */
  statuses: Record<string, string>;
  /** widgetKey → lines + placement, rendered around the composer */
  widgets: Record<string, ExtWidget>;
  /** text an extension wants dropped into the composer; null once consumed */
  editorText: string | null;
  initialized: boolean;

  init: () => void;
  respond: (
    req: ExtensionUiRequest,
    payload:
      | { value: string }
      | { confirmed: boolean }
      | { cancelled: true }
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
  if (!isTauri()) return;
  void import("@tauri-apps/api/window")
    .then((m) => m.getCurrentWindow().setTitle(title))
    .catch(() => {
      // window handle unavailable — the document title still updated
    });
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
    const client = getPiClient();

    client.on("extension_ui_request", (e: PiEvent) => {
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
            const statuses = { ...s.statuses };
            if (req.statusText) statuses[key] = req.statusText;
            else delete statuses[key];
            return { statuses };
          });
          return;
        }

        case "setWidget": {
          // omitted widgetLines clears the widget for that key
          const key = req.widgetKey ?? DEFAULT_KEY;
          set((s) => {
            const widgets = { ...s.widgets };
            if (req.widgetLines?.length) {
              widgets[key] = {
                lines: req.widgetLines,
                placement: req.widgetPlacement ?? "aboveEditor",
              };
            } else {
              delete widgets[key];
            }
            return { widgets };
          });
          return;
        }

        case "setTitle":
          if (req.title) applyTitle(req.title);
          return;

        case "set_editor_text":
          set({ editorText: req.text ?? "" });
          return;
      }

      if (MODAL_METHODS.has(req.method)) {
        set((s) => ({ queue: [...s.queue, req] }));
        // pi auto-resolves timed-out dialogs on its side without telling us,
        // so drop the sheet ourselves instead of leaving a dead prompt up.
        if (req.timeout && req.timeout > 0) {
          setTimeout(() => {
            set((s) => ({ queue: s.queue.filter((q) => q.id !== req.id) }));
          }, req.timeout);
        }
        return;
      }

      // unknown future method — cancel politely so extensions never hang on us
      client.send({ type: "extension_ui_response", id: req.id, cancelled: true });
    });

    // An extension threw. Previously dropped on the floor: the event was typed
    // but never subscribed. The raw `error` can be a full stack trace, so the
    // toast carries only extension + event name and the detail goes to console.
    client.on("extension_error", (e: PiEvent) => {
      if (e.type !== "extension_error") return;
      const name = e.extensionPath.split(/[\\/]/).pop() || e.extensionPath;
      console.error(`[pi extension] ${e.extensionPath} failed on ${e.event}:`, e.error);
      get().pushToast(t("ext.error", { name, event: e.event }), "error", 6000);
    });
  },

  respond: (req, payload) => {
    getPiClient().send({
      type: "extension_ui_response",
      id: req.id,
      ...payload,
    } as never);
    set((s) => ({ queue: s.queue.filter((q) => q.id !== req.id) }));
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

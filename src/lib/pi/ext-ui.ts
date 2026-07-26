"use client";

import { create } from "zustand";
import { getPiClient } from "./client";
import type { ExtensionUiRequest, PiEvent } from "./protocol";

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "warning" | "error";
}

/** Methods that need a modal sheet and a response. */
const MODAL_METHODS = new Set(["confirm", "select", "input", "editor"]);

interface ExtUiStore {
  queue: ExtensionUiRequest[];
  toasts: Toast[];
  statusText: string | null;
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
}

let toastSeq = 0;

export const useExtUi = create<ExtUiStore>((set, get) => ({
  queue: [],
  toasts: [],
  statusText: null,
  initialized: false,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    const client = getPiClient();

    client.on("extension_ui_request", (e: PiEvent) => {
      if (e.type !== "extension_ui_request") return;
      const req = e as ExtensionUiRequest;

      if (req.method === "notify") {
        const id = `toast-${++toastSeq}`;
        set((s) => ({
          toasts: [
            ...s.toasts,
            { id, message: req.message ?? "", kind: req.notifyType ?? "info" },
          ],
        }));
        setTimeout(() => get().dismissToast(id), 3800);
        return;
      }

      if (req.method === "setStatus") {
        set({ statusText: req.statusText ?? null });
        return;
      }

      if (MODAL_METHODS.has(req.method)) {
        set((s) => ({ queue: [...s.queue, req] }));
        return;
      }

      // unsupported methods (setWidget/setTitle/set_editor_text for now):
      // cancel politely so extensions never hang waiting on us
      client.send({ type: "extension_ui_response", id: req.id, cancelled: true });
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
}));

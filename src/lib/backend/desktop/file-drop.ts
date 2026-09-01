import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FileDropPort } from "../ports/file-drop";

/**
 * Desktop drag-and-drop, read from Tauri's own drag session helper.
 *
 * `onDragDropEvent` is used rather than four raw `listen("tauri://drag-*")`
 * calls because the event target that matches depends on how the window was
 * created — a config-declared window is a *webview window*, and Tauri emits its
 * drag events to a label-only target so both window and webview subscriptions
 * match. Going through the helper means that detail stays Tauri's problem, and
 * one unlisten covers all four events.
 *
 * `PhysicalPosition` is unwrapped to plain numbers here so no Tauri class
 * escapes the adapter.
 */
export const desktopFileDropPort = {
  onDrag: (handler) =>
    getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        handler({ type: "leave" });
        return;
      }
      const position = { x: payload.position.x, y: payload.position.y };
      if (payload.type === "over") {
        handler({ type: "over", position });
        return;
      }
      handler({ type: payload.type, paths: [...payload.paths], position });
    }),
} satisfies FileDropPort;

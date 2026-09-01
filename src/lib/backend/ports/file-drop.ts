/**
 * OS drag-and-drop over the app window.
 *
 * This is a port rather than a DOM listener because the webview never sees the
 * drop. Tauri installs its own drop target on the window (`dragDropEnabled`
 * defaults to true, and turning it off is what would hand HTML5 drag-and-drop
 * back to the frontend on Windows), so `dragover`/`drop` do not fire for files
 * and `DataTransfer` carries no filesystem paths even where they do.
 *
 * Two consequences shape the contract below:
 *
 * - Events are window-scoped. There is no target element, so a caller that wants
 *   an element-sized drop zone has to hit-test `position` itself — see
 *   `isDropInside` in [terminal-drop.ts](../../terminal-drop.ts).
 * - `position` is in physical device pixels relative to the window's client
 *   area, which is what the platform reports. Comparing it against a
 *   `getBoundingClientRect()` means dividing by `devicePixelRatio` first.
 *
 * Paths are plain strings and positions plain numbers on purpose: no Tauri type
 * (`PhysicalPosition`) may cross this boundary.
 */

export interface FileDropPosition {
  /** Physical pixels from the left edge of the window's client area. */
  x: number;
  /** Physical pixels from the top edge of the window's client area. */
  y: number;
}

/**
 * One step of a drag session. `enter` and `drop` carry paths; `over` fires
 * repeatedly while the cursor moves and carries only a position; `leave` means
 * the drag left the window or was cancelled.
 */
export type FileDropEvent =
  | { type: "enter"; paths: string[]; position: FileDropPosition }
  | { type: "over"; position: FileDropPosition }
  | { type: "drop"; paths: string[]; position: FileDropPosition }
  | { type: "leave" };

export type FileDropUnlisten = () => void;

export interface FileDropPort {
  /** Subscribe to the whole drag session. Resolves to an unlisten function. */
  onDrag(handler: (event: FileDropEvent) => void): Promise<FileDropUnlisten>;
}

/**
 * Browser preview cannot implement this: a page only ever receives `File`
 * objects, and a `File` has no path. Resolving to a no-op unlisten (rather than
 * throwing, as the unavailable transports do) keeps the drop zone inert instead
 * of turning a mounted terminal into an error.
 */
export function createUnsupportedFileDropPort(): FileDropPort {
  return {
    onDrag: async () => () => {},
  };
}

"use client";

/**
 * Clipboard access for the terminal drawer.
 *
 * The terminal cannot inherit the webview's copy/paste the way a text field
 * does, for two reasons that both have to be answered in code:
 *
 * - `Ctrl-C` belongs to the shell. xterm sends it as SIGINT and deliberately
 *   leaves clipboard bindings to the embedder, so "copy" has to be bound here
 *   or it does not exist.
 * - [AppShell.tsx](../components/AppShell.tsx) suppresses `contextmenu`
 *   app-wide, which also removes WebView2's own Copy/Paste items — the fallback
 *   a user reaches for when a keyboard binding is missing.
 *
 * Async clipboard API only. `writeText` is already how the rest of the app
 * copies. `readText` matters because a native `paste` event is not dependable
 * here: macOS webviews only deliver Cmd+V editing commands when the app ships a
 * native Edit menu, and this app has a tray menu and nothing else.
 */

/** Whether an explicit paste (menu item, Ctrl-V) can read the clipboard. */
export function canReadClipboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.readText === "function"
  );
}

/** Put `text` on the clipboard. Resolves false instead of throwing. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the clipboard as text.
 *
 * Null covers every uninteresting outcome the same way — no permission, no
 * clipboard API, or something on it that is not text — because the caller's
 * response to all of them is the same: say so and change nothing.
 */
export async function readClipboardText(): Promise<string | null> {
  if (!canReadClipboard()) return null;
  try {
    const text = await navigator.clipboard.readText();
    return text || null;
  } catch {
    return null;
  }
}

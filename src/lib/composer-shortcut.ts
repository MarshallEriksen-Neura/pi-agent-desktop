/**
 * Which key combination sends a chat message.
 *
 * The composer is a multi-line textarea, so send and newline compete for the
 * same key — picking one implies the other:
 *
 *   mod-enter    ⌘/Ctrl+↩ sends · ↩ newline    (default, unchanged behaviour)
 *   enter        ↩ sends · ⇧↩ newline          (the habit from most chat apps)
 *   shift-enter  ⇧↩ sends · ↩ newline
 *
 * Only Enter-based combos are offered, on purpose. Every other key has to stay
 * typeable inside the composer, so an arbitrary binding would either shadow
 * text entry or collide with the app's global shortcuts (⌘K, ⌘⇧C).
 *
 * App-local preference: it describes this UI, not pi's behaviour, so it lives in
 * the UI store / localStorage rather than pi's settings.json.
 */
export type SendShortcut = "mod-enter" | "enter" | "shift-enter";

export const SEND_SHORTCUTS = ["mod-enter", "enter", "shift-enter"] as const;

/** what the composer used before this preference existed */
export const SEND_SHORTCUT_DEFAULT: SendShortcut = "mod-enter";

export function isSendShortcut(value: unknown): value is SendShortcut {
  return (
    typeof value === "string" &&
    (SEND_SHORTCUTS as readonly string[]).includes(value)
  );
}

/** the slice of a keyboard event the matcher reads — keeps it testable in node */
export interface SendKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * `send`    deliver with the composer's current steer/queue mode
 * `altSend` deliver with the *other* mode, for this one message
 * `null`    not a send combo — let the key through (usually inserts a newline)
 */
export type SendIntent = "send" | "altSend" | null;

export function matchSendIntent(
  event: SendKeyEvent,
  shortcut: SendShortcut
): SendIntent {
  if (event.key !== "Enter") return null;

  // ⌘/Ctrl+↩ sends under every preference. No keyboard layout produces a
  // newline with it, so it stays a reliable escape hatch for a user who forgot
  // which mode they picked — and it keeps ⌘⇧↩ meaning "flip steer↔queue" in all
  // three modes instead of only in the default one.
  if (event.metaKey || event.ctrlKey) return event.shiftKey ? "altSend" : "send";

  if (shortcut === "enter") return event.shiftKey ? null : "send";
  if (shortcut === "shift-enter") return event.shiftKey ? "send" : null;
  return null; // mod-enter: a bare ↩ is a newline
}

/**
 * Compact glyph for the hint in the composer's corner. `mac` only changes the
 * mod-enter label — ↩ and ⇧↩ read the same on every platform.
 */
export function formatSendShortcut(shortcut: SendShortcut, mac: boolean): string {
  if (shortcut === "enter") return "↩";
  if (shortcut === "shift-enter") return "⇧↩";
  return mac ? "⌘↩" : "Ctrl↩";
}

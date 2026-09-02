/**
 * Turning dropped filesystem paths into text a shell can read.
 *
 * The interesting problems are all at this seam, which is why it is a module of
 * pure functions with no imports:
 *
 * - Paths contain spaces, and a bare path with a space is two arguments.
 * - The drop is window-scoped (see [file-drop.ts](./backend/ports/file-drop.ts)),
 *   so deciding whether it landed on the terminal is arithmetic on a physical
 *   pixel position, not a DOM hit test.
 */

/** A `DOMRect`-shaped box, in CSS pixels. */
export interface DropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DropFormatOptions {
  /**
   * The line already being edited, when it is known. `null` means "cannot tell"
   * — a remote PTY owns its line and does not report it — in which case no
   * separator is added, matching what other terminals do on drop.
   */
  precedingLine?: string | null;
}

/**
 * Whether a drag position falls inside `rect`.
 *
 * `position` arrives in physical device pixels relative to the window's client
 * area while `rect` comes from `getBoundingClientRect()` in CSS pixels, so the
 * ratio has to be divided out before the two can be compared at all.
 */
export function isDropInside(
  position: { x: number; y: number },
  rect: DropRect,
  devicePixelRatio = 1
): boolean {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Quote one path for a command line.
 *
 * Unquoted when nothing in it needs quoting, which keeps the common case
 * readable. Otherwise double quotes: they are the one form both a POSIX shell
 * and `cmd.exe` read the same way, and inside them a Windows path's backslashes
 * stay literal in bash (only `$`, a backtick, `"` and `\` are special there).
 * A path containing one of those three falls back to POSIX single quotes, which
 * are literal without exception — the trade is deliberate, since a path with a
 * dollar sign or a backtick in it is rare and silently expanding it is worse.
 */
export function quotePathForShell(path: string): string {
  if (/^[A-Za-z0-9_@%+=:,.\/\\-]+$/.test(path)) return path;
  if (!/["$`]/.test(path)) return `"${path}"`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render dropped paths as text to insert at the prompt.
 *
 * Always ends with a space so a second drop lands as a second argument rather
 * than welding onto the first, and never contains a newline: a drop types a
 * path, it does not run a command.
 */
export function formatDroppedPaths(
  paths: readonly string[],
  options: DropFormatOptions = {}
): string {
  const { precedingLine = null } = options;
  const quoted = paths
    .filter((path) => path.trim().length > 0)
    .map(quotePathForShell);
  if (quoted.length === 0) return "";
  const separator = precedingLine && !/\s$/.test(precedingLine) ? " " : "";
  return `${separator}${quoted.join(" ")} `;
}

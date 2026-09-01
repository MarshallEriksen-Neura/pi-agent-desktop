/**
 * Turning dropped filesystem paths into text a shell can read.
 *
 * The interesting problems are all at this seam, which is why it is a module of
 * pure functions with no imports:
 *
 * - A dropped path is an *OS* path. The shell it is being typed into may not
 *   share that namespace: in WSL mode the commands run inside the distro, where
 *   `D:\src` does not exist and `/mnt/d/src` is the same directory.
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
   * Distro name when the shell runs inside WSL, otherwise null/undefined.
   *
   * Doubles as the translation switch: only a shell inside the distro wants
   * `/mnt/...`, and a remote shell wants neither that nor the Windows path
   * rewritten behind the user's back.
   */
  wslDistro?: string | null;
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
 * Rewrite a Windows path as the distro sees it.
 *
 * Two shapes matter. A drive-letter path is mounted under `/mnt/<drive>` (the
 * default `automount.root`; a distro that has moved it in `/etc/wsl.conf` is not
 * something a drop can discover). A `\\wsl$\...` or `\\wsl.localhost\...` UNC
 * path is a file *inside* a distro, and is only expressible as a plain path when
 * that distro is the one the shell is running in — for any other distro the path
 * is left alone, because a made-up translation would silently point at the wrong
 * filesystem.
 */
export function toWslPath(path: string, distro?: string | null): string {
  const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/i.exec(path);
  if (unc) {
    const [, pathDistro, rest = ""] = unc;
    if (distro && pathDistro.toLowerCase() !== distro.toLowerCase()) return path;
    return `/${rest.replace(/\\/g, "/")}`;
  }
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(path);
  if (drive) {
    const [, letter, rest = ""] = drive;
    const tail = rest.replace(/\\/g, "/");
    return `/mnt/${letter.toLowerCase()}${tail ? `/${tail}` : ""}`;
  }
  return path;
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
  const { wslDistro = null, precedingLine = null } = options;
  const quoted = paths
    .filter((path) => path.trim().length > 0)
    .map((path) => (wslDistro === null ? path : toWslPath(path, wslDistro)))
    .map(quotePathForShell);
  if (quoted.length === 0) return "";
  const separator = precedingLine && !/\s$/.test(precedingLine) ? " " : "";
  return `${separator}${quoted.join(" ")} `;
}

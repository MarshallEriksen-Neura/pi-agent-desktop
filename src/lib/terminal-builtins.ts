"use client";

import { termBus } from "./terminal-bus";
import { useTerminalBlocks } from "./terminal-blocks";

/**
 * Commands the drawer answers itself instead of sending to pi.
 *
 * `clear` has to be one of them. Every command here is a separate `bash` RPC whose
 * output is *captured*, not a write to a live PTY, so the escape sequence `clear`
 * emits would arrive as text in a response body — there is no terminal on the far
 * end for it to act on. Three separate things each independently stop it working:
 *
 * - No `TERM` is set for pi's shell, and `clear` reads terminfo to know what to
 *   emit. Without it the command fails instead of printing anything.
 * - Block mode renders through `ansi_up`, which implements SGR (colour) and
 *   ignores every other CSI code — cursor and erase commands included. It could
 *   not act on the sequence even if it received it.
 * - Classic mode would only erase whatever xterm had already painted *below* the
 *   command, since the output arrives after the echoed command line.
 *
 * So this is not a shim for a missing feature; a captured-output shell has no
 * other place for `clear` to live.
 */

/** Matches the clear-screen builtins, with optional surrounding whitespace. */
export function isClearCommand(command: string): boolean {
  // `cls` is a cmd.exe builtin rather than a bash one, but it is what a Windows
  // user types, and under captured output it would not clear the view either.
  return /^(clear|cls)$/.test(command.trim());
}

/**
 * Empty the terminal view for whichever mode is showing, and reprint the prompt.
 *
 * @param reprompt false when the caller paints its own prompt afterwards, so the
 *   drawer does not end up with two.
 */
export function clearTerminalView(reprompt = true) {
  const blocks = useTerminalBlocks.getState();
  if (blocks.viewMode === "blocks") {
    blocks.clearBlocks();
    return;
  }
  // 2J erases the screen, 3J the scrollback, H homes the cursor. Dropping 3J
  // leaves the "cleared" output one scroll wheel away.
  termBus.reset("\x1b[3J\x1b[2J\x1b[H");
  if (reprompt) termBus.write("\x1b[2m$\x1b[0m ");
}

/**
 * Splitting pasted text into commands.
 *
 * Shared by both terminal views because both got this wrong in the same way, for
 * the same reason: a paste is delivered as one string, and code written for
 * single keystrokes reads it as one enormous keystroke. Classic mode echoed the
 * embedded carriage returns into the line buffer; block mode let `<input>` strip
 * the newlines and weld the lines together. One command ran, wrong, either way.
 *
 * No imports on purpose — this is the piece worth testing on its own.
 */

/** A paste split at its newlines. */
export interface SplitPaste {
  /** Lines that were newline-terminated, in order. Each one is a command. */
  lines: string[];
  /**
   * Text after the last newline, which the user has not committed. It belongs in
   * the line editor as an editable command, not in the run queue.
   */
  tail: string;
}

/**
 * Split on any newline convention.
 *
 * xterm has already folded `\n` to `\r` by the time a paste reaches `onData`,
 * while `clipboardData` hands over the platform's own line endings untouched, so
 * all three forms have to be accepted at this seam.
 */
export function splitPastedLines(text: string): SplitPaste {
  const parts = text.replace(/\r\n?|\n/g, "\n").split("\n");
  const tail = parts.pop() ?? "";
  return { lines: parts, tail };
}

/**
 * Drop control characters a line editor has no meaning for, keeping tab.
 *
 * Newlines are handled by the split above, so anything left in this range is
 * either a stray escape sequence or a NUL from a binary paste — bytes that would
 * move the cursor or corrupt the buffer if echoed.
 */
export function printableOnly(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

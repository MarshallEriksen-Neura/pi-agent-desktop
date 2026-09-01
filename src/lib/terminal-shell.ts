"use client";

import { getPiClient } from "./pi/client";
import type { BashResult } from "./pi/protocol";
import { termBus, ansi } from "./terminal-bus";
import { piRequestErrorText } from "./pi/request-error";
import { printableOnly, splitPastedLines } from "./terminal-paste";
import { clearTerminalView, isClearCommand } from "./terminal-builtins";

/**
 * Interactive shell line-discipline for the terminal drawer.
 * Local line editing (xterm gives us raw keys), then each entered line is
 * sent to pi's `bash` RPC.
 *
 * Output arrives twice over: as `bash_execution_update` events while the command
 * runs (each carrying an incremental `delta` and the `id` we sent), and once more
 * in the response `data` as a BashResult. We render the live stream and then
 * write only the tail the events did not cover — the response `output` can be
 * truncated while the event stream is complete, so the events are the better
 * source when both are available.
 *
 * A paste is not a key. xterm hands it to `onData` as one multi-character string
 * with newlines already folded to CR, so this has to be written as a stream
 * processor rather than a switch over single keystrokes: a two-line paste is a
 * command to run plus input for the *next* prompt, and one that lands mid-command
 * is typeahead that has to survive until that prompt exists.
 */

let running = false;
/** The line being edited. Already echoed — the terminal shows exactly this. */
let buffer = "";
/**
 * Input that arrived while a command was running, replayed verbatim at the next
 * prompt. Echoing it immediately would interleave it with the command's output,
 * so it stays invisible until there is a prompt to type at.
 */
let held = "";
let bashSeq = 0;

const PROMPT = "\x1b[2m$\x1b[0m ";
/** Bracketed-paste guards, in case a future caller turns DECSET 2004 on. */
const BRACKET = /\x1b\[20[01]~/g;
/** Held typeahead is bounded — a runaway writer must not grow it forever. */
const HELD_MAX = 8192;

export function promptLine() {
  termBus.write(PROMPT);
}

/**
 * Handle one `onData` payload from xterm — a keystroke, or a whole paste.
 */
export function handleTermInput(data: string) {
  if (!data) return;

  // Escape sequences are keys this shell does not implement (arrows, F-keys,
  // mouse reports). Drop them whole: stripping the ESC and keeping the rest
  // would type "[A" into the buffer on every press of Up.
  if (data.charCodeAt(0) === 0x1b && !data.startsWith("\x1b[200~")) return;
  const text = data.replace(BRACKET, "");

  if (text === "\x03") {
    onInterrupt();
    return;
  }
  if (text === "\x7f" || text === "\b") {
    if (!running) backspace();
    return;
  }
  if (text === "\x0c") {
    // Ctrl-L. Previously stripped as an unprintable and silently did nothing.
    if (!running) clearScreen();
    return;
  }

  if (running) {
    // typeahead — replayed by drainHeld() once the prompt comes back
    if (held.length < HELD_MAX) held += text;
    return;
  }
  feed(text);
}

/**
 * Consume input at the prompt, running a command at every newline.
 *
 * The tail after the last newline is a partial line: it stays in the buffer as
 * the thing the user is now editing, which is what makes a paste ending without
 * a trailing newline land as an editable command rather than running blind.
 */
function feed(text: string) {
  const { lines, tail } = splitPastedLines(text);
  for (let i = 0; i < lines.length; i++) {
    echo(lines[i]);
    submit();
    if (running) {
      // The rest of the paste belongs to prompts that do not exist yet.
      held += [...lines.slice(i + 1), tail].join("\r");
      return;
    }
  }
  echo(tail);
}

/** Append to the line being edited and show it. */
function echo(text: string) {
  const printable = printableOnly(text);
  if (!printable) return;
  buffer += printable;
  termBus.write(printable);
}

/** Run the buffered line. Blank lines just reprint the prompt, as a shell does. */
function submit() {
  termBus.write("\r\n");
  const cmd = buffer.trim();
  buffer = "";
  if (!cmd) {
    promptLine();
    return;
  }
  // `clear` is answered here, not by pi — see terminal-builtins.ts for why a
  // captured-output shell cannot let the real one through.
  if (isClearCommand(cmd)) {
    clearTerminalView();
    return;
  }
  runBash(cmd);
}

/** Ctrl-L — clear the screen, keeping the half-typed line, as a shell does. */
function clearScreen() {
  clearTerminalView();
  if (buffer) termBus.write(buffer);
}

/**
 * Ctrl-C: abort the running command, or clear the line at the prompt.
 *
 * Either way it discards held typeahead. Interrupting and then watching queued
 * lines from an abandoned paste execute anyway is the opposite of what the key
 * is for.
 */
function onInterrupt() {
  held = "";
  if (!running) {
    buffer = "";
    termBus.write("^C\r\n");
    promptLine();
    return;
  }
  // The pending `bash` request resolves with cancelled=true, restoring the prompt.
  termBus.write("^C\r\n");
  void getPiClient()
    .request({ type: "abort_bash" })
    .then((response) => {
      if (!response.success) {
        termBus.writeln(ansi.red(response.error || "abort_bash failed"));
      }
    })
    .catch((error) => termBus.writeln(ansi.red(piRequestErrorText(error))));
}

/** Erase one code point, so a pasted emoji or CJK char deletes in one press. */
function backspace() {
  if (!buffer) return;
  const chars = Array.from(buffer);
  chars.pop();
  buffer = chars.join("");
  termBus.write("\b \b");
}

/** Replay input that arrived while the last command was running. */
function drainHeld() {
  if (!held) return;
  const text = held;
  held = "";
  feed(text);
}

/**
 * Paste `text` at the prompt — the explicit path for a key binding or menu item,
 * as opposed to a native `paste` event that xterm turns into `onData`.
 */
export function pasteIntoTerminal(text: string) {
  handleTermInput(text);
}

/**
 * The line currently being edited.
 *
 * Exposed for callers that have to append to it and need to know whether a
 * separator is required first — a dropped path after `ls` is a second word, a
 * dropped path at an empty prompt is the first one. Only this shell can answer
 * that, because only this shell keeps the line (a remote PTY does not report
 * one).
 */
export function currentTerminalLine(): string {
  return buffer;
}

async function runBash(cmd: string) {
  running = true;
  const client = getPiClient();
  const id = `bash-${++bashSeq}`;
  // chars already painted from the live event stream — the response output is
  // sliced past this so nothing is printed twice
  let streamed = 0;
  const off = client.on("bash_execution_update", (e) => {
    if (e.type !== "bash_execution_update" || e.id !== id) return;
    if (!e.delta) return;
    streamed += e.delta.length;
    termBus.write(e.delta.replace(/\r?\n/g, "\r\n"));
  });
  try {
    const r = await client.request<BashResult>(
      { type: "bash", command: cmd, id },
      120_000
    );
    if (r.success && r.data) {
      writeResult(r.data, streamed);
    } else if (r.error) {
      termBus.writeln(ansi.red(r.error));
    }
  } catch (e) {
    termBus.writeln(
      ansi.red(e instanceof Error ? e.message : "bash failed")
    );
  } finally {
    off();
    running = false;
    promptLine();
    // queued paste lines / typeahead run in order, after the prompt is painted
    drainHeld();
  }
}

/**
 * @param streamed chars already written from `bash_execution_update` events —
 *   only the remainder of `output` is painted. Truncated output can be *shorter*
 *   than what streamed, in which case there is nothing left to write.
 */
function writeResult(r: BashResult, streamed = 0) {
  const rest = streamed > 0 ? r.output.slice(streamed) : r.output;
  if (rest) {
    // normalize LF → CRLF for xterm; keep the prompt on its own line
    termBus.write(rest.replace(/\r?\n/g, "\r\n"));
  }
  if (r.output && !r.output.endsWith("\n")) termBus.write("\r\n");
  if (r.cancelled) {
    termBus.writeln(ansi.dim("(cancelled)"));
  } else if (typeof r.exitCode === "number" && r.exitCode !== 0) {
    termBus.writeln(ansi.red(`exit ${r.exitCode}`));
  }
  if (r.truncated) {
    termBus.writeln(
      ansi.dim(`(output truncated${r.fullOutputPath ? ` — full log: ${r.fullOutputPath}` : ""})`)
    );
  }
}

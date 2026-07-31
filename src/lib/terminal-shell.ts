"use client";

import { getPiClient } from "./pi/client";
import type { BashResult } from "./pi/protocol";
import { termBus, ansi } from "./terminal-bus";

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
 */

let running = false;
let buffer = "";
let bashSeq = 0;

const PROMPT = "\x1b[2m$\x1b[0m ";

export function promptLine() {
  termBus.write(PROMPT);
}

/** Handle raw key data from xterm.onData. */
export function handleTermInput(data: string) {
  if (running) {
    // Ctrl-C aborts the in-flight bash command; the pending `bash` request
    // resolves with cancelled=true, which restores the prompt.
    if (data === "\x03") {
      termBus.write("^C\r\n");
      getPiClient().send({ type: "abort_bash" });
    }
    return; // ignore other typing while a command runs
  }

  switch (data) {
    case "\r": {
      // Enter — run the buffered line
      termBus.write("\r\n");
      const cmd = buffer.trim();
      buffer = "";
      if (!cmd) {
        promptLine();
        return;
      }
      runBash(cmd);
      break;
    }
    case "\x7f": // Backspace
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
        termBus.write("\b \b");
      }
      break;
    case "\x03": // Ctrl-C at prompt — clear the line
      buffer = "";
      termBus.write("^C\r\n");
      promptLine();
      break;
    default:
      // printable chars (incl. paste); drop other control sequences
      if (data >= " " || data === "\t") {
        buffer += data;
        termBus.write(data);
      }
  }
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

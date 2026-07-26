"use client";

import { getPiClient } from "./pi/client";
import type { BashResult } from "./pi/protocol";
import { termBus, ansi } from "./terminal-bus";

/**
 * Interactive shell line-discipline for the terminal drawer.
 * Local line editing (xterm gives us raw keys), then each entered line is
 * sent to pi's `bash` RPC. Per pi's rpc.md, output does NOT stream as events —
 * it comes back in the response `data` as a BashResult.
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
  try {
    const r = await client.request<BashResult>(
      { type: "bash", command: cmd, id: `bash-${++bashSeq}` },
      120_000
    );
    if (r.success && r.data) {
      writeResult(r.data);
    } else if (r.error) {
      termBus.writeln(ansi.red(r.error));
    }
  } catch (e) {
    termBus.writeln(
      ansi.red(e instanceof Error ? e.message : "bash failed")
    );
  } finally {
    running = false;
    promptLine();
  }
}

function writeResult(r: BashResult) {
  if (r.output) {
    // normalize LF → CRLF for xterm; keep the prompt on its own line
    termBus.write(r.output.replace(/\r?\n/g, "\r\n"));
    if (!r.output.endsWith("\n")) termBus.write("\r\n");
  }
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

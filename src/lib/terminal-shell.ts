"use client";

import { getPiClient } from "./pi/client";
import { termBus, ansi } from "./terminal-bus";

/**
 * Interactive shell line-discipline for the terminal drawer.
 * Local line editing (xterm gives us raw keys), then each entered line is
 * sent to pi's `bash` RPC; output streams back via bash_execution_update.
 */

let wired = false;
let running = false;
let buffer = "";
let bashSeq = 0;

const PROMPT = "\x1b[2m$\x1b[0m ";

export function promptLine() {
  termBus.write(PROMPT);
}

/** Subscribe bash output events once. */
export function wireBashEvents() {
  if (wired) return;
  wired = true;
  const client = getPiClient();

  client.on("bash_execution_update", (e) => {
    if (e.type !== "bash_execution_update" || !e.delta) return;
    // normalize LF → CRLF for xterm
    termBus.write(e.delta.replace(/\r?\n/g, "\r\n"));
  });
}

/** Handle raw key data from xterm.onData. */
export function handleTermInput(data: string) {
  if (running) {
    // Ctrl-C aborts the in-flight bash command
    if (data === "\x03") {
      termBus.write("^C\r\n");
      getPiClient().send({ type: "abort_bash" });
      running = false;
      promptLine();
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
    const r = await client.request(
      { type: "bash", command: cmd, id: `bash-${++bashSeq}` },
      120_000
    );
    if (!r.success && r.error) {
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

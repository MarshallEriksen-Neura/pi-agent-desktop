"use client";

import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { termBus } from "@/lib/terminal-bus";
import { getPiClient } from "./pi/client";
import type { BashResult } from "./pi/protocol";
import { piRequestErrorText } from "./pi/request-error";
import { splitPastedLines } from "./terminal-paste";
import { clearTerminalView, isClearCommand } from "./terminal-builtins";

/**
 * Block-mode shell handler — each command becomes a card in the blocks view.
 * Replaces the classic line-discipline when viewMode="blocks".
 */

let buffer = "";

export function handleBlockInput(data: string) {
  const blocks = useTerminalBlocks.getState();
  const runningBlock = blocks.blocks.find((b) => b.status === "running");

  // Ctrl-C: cancel the running block
  if (data === "\x03" && runningBlock) {
    void getPiClient()
      .request({ type: "abort_bash" })
      .then((response) => {
        if (!response.success) {
          useTerminalBlocks
            .getState()
            .appendOutput(
              runningBlock.id,
              `\n[abort failed] ${response.error || "abort_bash failed"}\n`
            );
        }
      })
      .catch((error) => {
        useTerminalBlocks
          .getState()
          .appendOutput(runningBlock.id, `\n[abort failed] ${piRequestErrorText(error)}\n`);
      });
    return;
  }

  // backspace
  if (data === "\x7f") {
    if (buffer.length > 0) {
      buffer = buffer.slice(0, -1);
      termBus.write("\b \b");
    }
    return;
  }

  // Enter: run the command as a block
  if (data === "\r") {
    termBus.write("\r\n");
    const cmd = buffer;
    buffer = "";
    // via runBlockLine so this path gets the builtins too, not just the input row
    runBlockLine(cmd);
    return;
  }

  // printable chars
  if (data >= " " || data === "\t") {
    buffer += data;
    termBus.write(data);
  }
}

export function blockPromptLine() {
  termBus.write("\x1b[2m$\x1b[0m ");
}

/**
 * Run one already-assembled command as a block.
 *
 * Block mode has a real `<input>`, so the caller holds the edited line — there is
 * nothing to accumulate a keystroke at a time, and feeding a command through
 * `handleBlockInput` character by character only risks the line buffer and the
 * input disagreeing.
 */
export function runBlockLine(command: string) {
  const cmd = command.trim();
  if (!cmd) return;
  // `clear` empties the block list rather than becoming a block that reports it
  // cleared something — ansi_up drops erase sequences, so the real command's
  // output would render as nothing at all.
  if (isClearCommand(cmd)) {
    clearTerminalView();
    return;
  }
  runBlockCommand(cmd);
}

/**
 * Run every complete line of a paste and return the unterminated tail.
 *
 * A block is one command, so a multi-line paste is several — the alternative is
 * what `<input>` does on its own, which is to strip the newlines and silently
 * weld `cd foo` and `echo bar` into `cd fooecho bar`. The tail goes back to the
 * input so a paste with no trailing newline stays editable before it runs.
 */
export function runPastedLines(text: string): string {
  const { lines, tail } = splitPastedLines(text);
  for (const line of lines) runBlockLine(line);
  return tail;
}

let bashSeq = 0;

async function runBlockCommand(cmd: string) {
  const blocks = useTerminalBlocks.getState();
  const blockId = blocks.addBlock({
    source: "user",
    command: cmd,
    output: "",
    status: "running",
    startedAt: Date.now(),
  });

  const client = getPiClient();
  // Correlate the live output stream with this block: pi echoes the command's
  // `id` back on every bash_execution_update, so a second command running in
  // parallel cannot leak into this card.
  const id = `blk-${++bashSeq}`;
  let streamed = 0;
  const off = client.on("bash_execution_update", (e) => {
    if (e.type !== "bash_execution_update" || e.id !== id) return;
    if (!e.delta) return;
    streamed += e.delta.length;
    useTerminalBlocks.getState().appendOutput(blockId, e.delta);
  });
  try {
    const r = await client.request<BashResult>(
      { type: "bash", command: cmd, id },
      120_000
    );
    if (r.success && r.data) {
      // append only what the stream had not already delivered — truncated
      // output can be shorter than the stream, leaving nothing to add
      const rest = streamed > 0 ? r.data.output.slice(streamed) : r.data.output;
      if (rest) blocks.appendOutput(blockId, rest);
      blocks.updateBlock(blockId, {
        status: r.data.cancelled
          ? "cancelled"
          : r.data.exitCode === 0
            ? "success"
            : "error",
        exitCode: r.data.exitCode,
        endedAt: Date.now(),
      });
    } else if (r.error) {
      blocks.updateBlock(blockId, {
        output: r.error,
        status: "error",
        endedAt: Date.now(),
      });
    }
  } catch (e) {
    blocks.updateBlock(blockId, {
      output: e instanceof Error ? e.message : "bash failed",
      status: "error",
      endedAt: Date.now(),
    });
  } finally {
    off();
    blockPromptLine();
  }
}

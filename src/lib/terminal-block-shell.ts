"use client";

import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { termBus } from "@/lib/terminal-bus";
import { getPiClient } from "./pi/client";
import type { BashResult } from "./pi/protocol";

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
    getPiClient().send({ type: "abort_bash" });
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
    const cmd = buffer.trim();
    buffer = "";
    if (!cmd) return;
    runBlockCommand(cmd);
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
  try {
    const r = await client.request<BashResult>(
      { type: "bash", command: cmd },
      120_000
    );
    if (r.success && r.data) {
      blocks.updateBlock(blockId, {
        output: r.data.output,
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
    blockPromptLine();
  }
}

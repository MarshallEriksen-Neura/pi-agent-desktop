"use client";

/**
 * Agent bridge — turns the real pi event stream into UI motion:
 *
 *  - agent_start/agent_settled        → task strip visibility (agentRunning)
 *  - tool_execution_start/end         → live task cards (read/edit/bash/…)
 *  - edit-ish tools on workspace files → reload from disk, open in the editor,
 *                                        streaming-diff highlight on changed lines
 *  - bash tool output                 → streamed into the terminal drawer
 *
 * The scripted showcase (`demo` / startDemo) stays untouched — this module is
 * the real counterpart driving the same surfaces.
 */

import { getPiClient } from "./client";
import { useUI } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { termBus, ansi } from "@/lib/terminal-bus";
import { editorBus } from "@/lib/editor-bus";
import { destroyPetBridge, initPetBridge } from "@/lib/pet/bridge";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import {
  BASH_TOOL,
  EDIT_TOOL,
  argCommand,
  argPath,
  normPath,
  toolDetail,
  toolTitle,
} from "./tool-label";

interface ToolRec {
  kind: "edit" | "bash" | "other";
  path?: string;
  /** file content before the edit (undefined if it wasn't loaded in time) */
  oldText?: string;
  /** chars of the bash partialResult already streamed to the terminal */
  streamed: number;
  /** block ID if in block mode */
  blockId?: string;
}

/* ── helpers ── */

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** tool result / partialResult → plain text (handles content-block shapes) */
function toText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  const o = asRecord(v);
  if (typeof o.output === "string") return o.output;
  if (typeof o.text === "string") return o.text;
  if (Array.isArray(o.content)) {
    return o.content
      .map((c) => {
        const b = asRecord(c);
        return typeof b.text === "string" ? b.text : "";
      })
      .join("");
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
}

const HIGHLIGHT_CAP = 400;

/** 1-based changed line numbers in `next` (common prefix/suffix trimmed) */
function changedLines(prev: string, next: string): number[] {
  const a = prev.split("\n");
  const b = next.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const lines: number[] = [];
  for (let i = start; i <= endB && lines.length < HIGHLIGHT_CAP; i++) lines.push(i + 1);
  return lines;
}

/* ── the bridge ── */

let bridged = false;
let bridgeUnlisteners: Array<() => void> = [];

export function initAgentBridge() {
  if (bridged) return;
  bridged = true;

  // Initialize pet bridge alongside agent bridge
  initPetBridge();

  const client = getPiClient();
  const recs = new Map<string, ToolRec>();

  bridgeUnlisteners.push(
    client.on("agent_start", () => useUI.getState().beginAgentRun()),
  );
  const settle = () => useUI.getState().endAgentRun();
  bridgeUnlisteners.push(
    client.on("agent_settled", settle),
    client.on("agent_end", (e) => {
      if (e.type === "agent_end" && !e.willRetry) settle();
    }),
  );

  bridgeUnlisteners.push(client.on("tool_execution_start", (e) => {
    if (e.type !== "tool_execution_start") return;
    const args = asRecord(e.args);
    const ui = useUI.getState();

    // pi can start tools before/without agent_start (e.g. sub-turns)
    if (!ui.agentRunning) ui.beginAgentRun();

    const rec: ToolRec = { kind: "other", streamed: 0 };

    if (EDIT_TOOL.test(e.toolName)) {
      const raw = argPath(args);
      if (raw) {
        rec.kind = "edit";
        rec.path = normPath(raw);
        const ws = useWorkspace.getState();
        rec.oldText = ws.docs[rec.path]; // may be undefined — openFile races the tool
        // focus the file so the user watches the edit land; also snapshots
        // the pre-edit content into docs for the later diff highlight
        void ws.openFile(rec.path).then(() => {
          if (rec.oldText === undefined) {
            rec.oldText = useWorkspace.getState().docs[rec.path!];
          }
        });
      }
    } else if (BASH_TOOL.test(e.toolName)) {
      rec.kind = "bash";
      const cmd = argCommand(args);

      const blocksStore = useTerminalBlocks.getState();
      if (blocksStore.viewMode === "blocks") {
        // blocks mode: create a command block for this agent bash
        rec.blockId = blocksStore.addBlock({
          source: "agent",
          command: cmd ?? e.toolName,
          output: "",
          status: "running",
          startedAt: Date.now(),
          toolCallId: e.toolCallId,
        });
      } else {
        // classic mode: write to xterm
        termBus.writeln(ansi.dim("$ ") + ansi.bold(cmd ?? e.toolName));
      }
    }

    recs.set(e.toolCallId, rec);
    ui.upsertAgentTask({
      id: e.toolCallId,
      title: toolTitle(e.toolName, args),
      detail: toolDetail(args),
      status: "running",
      tool: e.toolName,
    });
  }));

  bridgeUnlisteners.push(client.on("tool_execution_update", (e) => {
    if (e.type !== "tool_execution_update") return;
    const rec = recs.get(e.toolCallId);
    if (!rec || rec.kind !== "bash") return;

    const text = toText(e.partialResult);
    if (text.length <= rec.streamed) return;

    const delta = text.slice(rec.streamed);
    rec.streamed = text.length;

    const blocksStore = useTerminalBlocks.getState();
    if (rec.blockId && blocksStore.viewMode === "blocks") {
      // blocks mode: append to the block
      blocksStore.appendOutput(rec.blockId, delta);
    } else {
      // classic mode: write to xterm
      termBus.write(delta.replace(/\r?\n/g, "\r\n"));
    }
  }));

  bridgeUnlisteners.push(client.on("tool_execution_end", (e) => {
    if (e.type !== "tool_execution_end") return;
    const rec = recs.get(e.toolCallId);
    recs.delete(e.toolCallId);
    const ui = useUI.getState();

    const resultText = toText(e.result);
    ui.patchAgentTask(e.toolCallId, {
      status: e.isError ? "error" : "done",
      ...(resultText
        ? { detail: resultText.replace(/\s+/g, " ").slice(0, 80) }
        : {}),
    });

    if (!rec) return;

    if (rec.kind === "bash") {
      const text = resultText;
      const delta = text.slice(rec.streamed);

      const blocksStore = useTerminalBlocks.getState();
      if (rec.blockId && blocksStore.viewMode === "blocks") {
        // blocks mode: finalize the block
        if (delta) blocksStore.appendOutput(rec.blockId, delta);
        blocksStore.updateBlock(rec.blockId, {
          status: e.isError ? "error" : "success",
          endedAt: Date.now(),
        });
      } else {
        // classic mode: write remaining output to xterm
        if (delta.length > 0) {
          termBus.write(delta.replace(/\r?\n/g, "\r\n"));
        }
        if (!text.endsWith("\n")) termBus.writeln();
      }
      return;
    }

    if (rec.kind === "edit" && rec.path && !e.isError) {
      const path = rec.path;
      const ws = useWorkspace.getState();
      void (async () => {
        const oldText = rec.oldText ?? ws.docs[path];
        await ws.reloadFile(path); // pull pi's write from disk
        await ws.openFile(path); //   ensure it's the active editor doc
        void ws.refreshDir(parentDir(path)); // new files show up in the tree
        const newText = useWorkspace.getState().docs[path];
        if (
          oldText === undefined ||
          newText === undefined ||
          oldText === newText
        )
          return;
        const lines = changedLines(oldText, newText);
        if (lines.length === 0) return;
        // let the editor swap to the fresh doc before decorating it
        setTimeout(() => editorBus.highlight({ path, lines }), 90);
      })();
    }
  }));
}

export function destroyAgentBridge() {
  if (!bridged) return;
  while (bridgeUnlisteners.length > 0) bridgeUnlisteners.pop()?.();
  destroyPetBridge();
  bridged = false;
}

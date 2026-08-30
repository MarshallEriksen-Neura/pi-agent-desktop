"use client";

/**
 * Agent bridge — turns the real pi event stream into UI motion:
 *
 *  - agent_start/agent_settled        → agentRunning (composer busy state)
 *  - edit-ish tools on workspace files → reload from disk, open in the editor,
 *                                        streaming-diff highlight on changed lines
 *  - bash tool output                 → streamed into the terminal drawer
 *
 * The scripted showcase (`demo` / startDemo) stays untouched — this module is
 * the real counterpart driving the same surfaces.
 */

import { getPiClient } from "./client";
import { useSessions } from "./sessions";
import { getActiveTaskId, useTaskContext } from "./task-context";
import { useUI } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { termBus, ansi } from "@/lib/terminal-bus";
import { editorBus } from "@/lib/editor-bus";
import { destroyPetBridge, initPetBridge } from "@/lib/pet/bridge";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { diffStatFromArgs, diffStatFromResult, useDiffStats } from "./diff-stat";
import { buildDiff, useFileDiffs } from "./file-diffs";
import { isFollowingAgent, useFileInspector } from "@/lib/file-inspector";
import {
  BASH_TOOL,
  EDIT_TOOL,
  argCommand,
  argPath,
  normPath,
  shellPrompt,
} from "./tool-label";

interface ToolRec {
  kind: "edit" | "bash" | "other";
  path?: string;
  /** file content before the edit (undefined if it wasn't loaded in time) */
  oldText?: string;
  /**
   * Resolves once the pre-edit snapshot attempt has settled. `tool_execution_end`
   * awaits it rather than racing it — losing that race used to mean no `oldText`
   * and therefore no diff at all, and the file has been overwritten by then, so
   * there is no second chance to read the old content.
   */
  snapshot?: Promise<void>;
  /**
   * Whether the file was readable before the edit. `false` means pi created it,
   * which is a real diff against empty (all additions) rather than unknown.
   */
  existedBefore?: boolean;
  /**
   * The edit tool's own arguments, kept for the +/- count. They describe the
   * change directly, which is what makes the badge survive a disk read-back that
   * never lands — the layout without an editor, a mocked backend, a path the
   * workspace store resolved differently than the agent did.
   */
  args?: Record<string, unknown>;
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

/** Whether this task is bound to a remote execution target. */
function remoteTask(taskId: string): boolean {
  const state = useSessions.getState();
  const session = state.sessions.find((item) => item.id === taskId);
  return (session?.executionBinding ?? state.executionBinding).kind === "ssh";
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
let recs = new Map<string, ToolRec>();
let taskSwitchUnlisten: (() => void) | null = null;

/** Subscribe the agent surfaces to a specific task's pi event stream. */
function bindAgentBridge(taskId: string) {
  while (bridgeUnlisteners.length > 0) bridgeUnlisteners.pop()?.();
  recs = new Map<string, ToolRec>();

  const client = getPiClient(taskId);
  const remote = remoteTask(taskId);

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
    // Remote paths and command output belong to the remote Pi transcript. Do not
    // feed them into local workspace, editor, diff, or terminal state.
    if (remote) {
      recs.set(e.toolCallId, rec);
      return;
    }

    if (EDIT_TOOL.test(e.toolName)) {
      const raw = argPath(args);
      if (raw) {
        rec.kind = "edit";
        rec.path = normPath(raw);
        rec.args = args;
        const path = rec.path;
        const ws = useWorkspace.getState();
        const cached = ws.docs[path];
        // Snapshot the pre-edit content, which both the changed-line highlight
        // and the +/- badge diff against. Whether the editor also *jumps* to the
        // file is a separate question: it should while the user is watching work
        // happen, and must not once they have pinned a file open themselves.
        rec.snapshot = (async () => {
          try {
            if (cached !== undefined) {
              rec.oldText = cached;
              rec.existedBefore = true;
            }
            if (isFollowingAgent()) await ws.openFile(path);
            else await ws.ensureDoc(path);
            rec.oldText ??= useWorkspace.getState().docs[path];
            // the read leaves docs untouched when it fails, which is exactly
            // how a file pi is about to create reads here
            rec.existedBefore ??= rec.oldText !== undefined;
          } catch {
            // Never reject: tool_execution_end awaits this, and a rejection there
            // would discard the badge and the highlight with nothing to show for it.
            // `existedBefore` stays unset on purpose — an unexpected failure is not
            // evidence the file was absent, and guessing would invent removals.
          }
        })();
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
        termBus.writeln(
          ansi.dim(`${shellPrompt(e.toolName)} `) + ansi.bold(cmd ?? e.toolName)
        );
      }
    }

    recs.set(e.toolCallId, rec);
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
    if (!rec) return;

    if (rec.kind === "bash") {
      const text = toText(e.result);
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
      const toolCallId = e.toolCallId;
      // Extension editors such as pi-hashline-edit-pro already return exact
      // line metrics. Publish those before any workspace IPC so the transcript
      // badge cannot be held hostage by the pre/post-read race.
      const reportedStat = diffStatFromResult(e.result);
      if (reportedStat && (reportedStat.added > 0 || reportedStat.removed > 0)) {
        useDiffStats.getState().record(toolCallId, reportedStat);
      }
      void (async () => {
        await rec.snapshot; // only disk fallback/highlighting waits for the pre-edit read
        // a file pi created has no previous content, which is a diff against
        // empty — not an unknown one
        const oldText = rec.existedBefore === false ? "" : rec.oldText;
        const ws = useWorkspace.getState();
        await ws.reloadFile(path); // pull pi's write from disk
        // Re-focus only while the surface is still chasing the agent. Pinned, the
        // user keeps the file they were reading.
        if (isFollowingAgent()) await ws.openFile(path);
        void ws.refreshDir(parentDir(path)); // new files show up in the tree
        const newText = useWorkspace.getState().docs[path];

        /* One diff serves both surfaces: the inspector renders its hunks and the
           badge takes its totals, so the panel and the row it was opened from
           cannot disagree about how much moved. */
        const body =
          oldText !== undefined && newText !== undefined && newText !== oldText
            ? buildDiff(oldText, newText)
            : undefined;
        if (body) {
          useFileDiffs.getState().record(toolCallId, path, body);
          useFileInspector.getState().noteAgentEdit(path, toolCallId);
        }

        /* Badge source priority: tool-reported metrics are authoritative and
           already published above. Without them, the disk diff observes what
           landed; tool arguments are the final fallback for native edit/write. */
        const stat =
          reportedStat ??
          (body
            ? { added: body.added, removed: body.removed, approx: body.approx }
            : diffStatFromArgs(rec.args ?? {}, oldText));
        if (
          !reportedStat &&
          stat &&
          (stat.added > 0 || stat.removed > 0)
        ) {
          useDiffStats.getState().record(toolCallId, stat);
        }

        // the highlight needs both real texts — it decorates actual line numbers
        if (oldText === undefined || newText === undefined) return;
        if (oldText === newText) return;
        const lines = changedLines(oldText, newText);
        if (lines.length === 0) return;
        // let the editor swap to the fresh doc before decorating it
        setTimeout(() => editorBus.highlight({ path, lines }), 90);
      })();
    }
  }));
}

export function initAgentBridge() {
  if (bridged) return;
  bridged = true;

  // Initialize pet bridge alongside agent bridge
  initPetBridge(getActiveTaskId());

  bindAgentBridge(getActiveTaskId());

  // Rebind whenever the focused conversation switches so the task strip and
  // terminal reflect the active task's tool events.
  taskSwitchUnlisten = useTaskContext.subscribe((s, prev) => {
    if (s.activeTaskId === prev.activeTaskId) return;
    initPetBridge(s.activeTaskId);
    bindAgentBridge(s.activeTaskId);
  });
}

export function destroyAgentBridge() {
  if (!bridged) return;
  taskSwitchUnlisten?.();
  taskSwitchUnlisten = null;
  while (bridgeUnlisteners.length > 0) bridgeUnlisteners.pop()?.();
  destroyPetBridge();
  bridged = false;
}

"use client";

import { create } from "zustand";
import { getPiClient } from "./client";
import { getActiveTaskId, useTaskContext } from "./task-context";
import type { PiEvent } from "./protocol";
import {
  asyncStateToStatus,
  pollAsyncRun,
  readSyncOutcome,
  readSyncProgress,
  type AsyncRunStatus,
} from "./async-runs";

/**
 * Subagent model — worker agents spawned by the main pi session.
 *
 * pi has NO built-in subagent: docs/usage.md states it is deliberately out of
 * scope and left to extensions. The reference implementation ships inside the pi
 * package (`examples/extensions/subagent/`) and registers ONE tool named
 * `subagent` that runs 1..N workers per call:
 *   single   — args.agent + args.task
 *   parallel — args.tasks[]  (every worker is seeded up front)
 *   chain    — args.chain[]  (sequential, `{previous}` placeholder)
 *
 * Because N workers share a single toolCallId, cards are derived from
 * `partialResult.details.results[]` rather than from the tool call itself —
 * keying on toolCallId would collapse a whole fan-out into one card.
 * `exitCode === -1` is that extension's "still running" sentinel.
 *
 * None of this is protocol. The producer is a user-editable extension, so every
 * field is feature-detected and an unrecognized payload degrades to a single
 * plain card instead of throwing or rendering blank.
 */

export type SubagentStatus = "queued" | "running" | "done" | "error";

export interface SubagentEvent {
  id: string;
  kind: "thinking" | "tool" | "text" | "status";
  label: string;
  detail?: string;
  at: number; // ms since agent start (stable for resume/replay)
}

/** token/cost accounting reported per worker */
export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface Subagent {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  /** 0..1 — only meaningful when `total` is set (chain mode); else indeterminate */
  progress: number;
  events: SubagentEvent[];
  result?: string;
  startedAtLabel: string;
  /** epoch ms, for the elapsed-time readout while indeterminate */
  startedAt: number;
  /** model the worker ran on, when the producer reports it */
  model?: string;
  usage?: SubagentUsage;
  /** "project" agents are repo-controlled — surfaced as a trust marker */
  source?: "user" | "project" | "unknown";
  /** chain mode: 1-based position and length, the only real progress signal */
  step?: number;
  total?: number;
  /** failure detail (errorMessage / stderr / stopReason) */
  errorText?: string;
  /**
   * Detached run: the producer's lifecycle-artifact directory. Its presence is
   * what marks a card as background work whose progress comes from disk rather
   * than from the tool call, so the tool ending must not settle it.
   */
  asyncDir?: string;
  /** the producer's own run id for a detached run */
  runId?: string;
}

/* ── which tool names count as a subagent producer ──
   Only `subagent` by default: that is the name pi's own reference extension
   registers. Anything else is a guess, and a wrong guess silently mis-renders a
   plain tool as a worker fan-out — so extra names are opt-in, not assumed. */

let SUBAGENT_TOOLS = ["subagent"];

/** Override the tool names treated as subagent producers (e.g. from settings). */
export function setSubagentTools(names: string[]) {
  const cleaned = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (cleaned.length > 0) SUBAGENT_TOOLS = cleaned;
}

/** true when a tool call is a subagent producer — gates the transcript's drawer link */
export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOLS.includes(toolName.toLowerCase());
}

/* ── defensive readers: every input is `unknown` off the wire ── */

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** compact one-line rendering of a tool call's arguments */
function summarizeArgs(v: unknown): string | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  const parts: string[] = [];
  for (const [k, val] of Object.entries(rec)) {
    if (parts.length >= 3) break;
    const s = typeof val === "string" ? val : JSON.stringify(val);
    if (s === undefined) continue;
    parts.push(`${k}: ${s.slice(0, 40)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/* ── payload → cards ── */

/** the extension's sentinel for "this worker has not finished yet" */
const RUNNING_EXIT_CODE = -1;

/**
 * `subagent` is one tool for two unrelated jobs: running workers, and managing
 * them. `action: "list" | "status" | "stop"` returns
 * `details: { mode: "management", results: [] }` — no worker was launched, so
 * there is nothing to track. Without this check the degraded path below invents
 * a card for every such call, and asking "which agents exist?" leaves a blank
 * subagent sitting in the transcript.
 */
function isManagementCall(payload: unknown): boolean {
  return str(asRecord(asRecord(payload)?.details)?.mode) === "management";
}

/** `{content, details}` → the `details.results[]` array, or null if absent */
function readResults(payload: unknown): Record<string, unknown>[] | null {
  const details = asRecord(asRecord(payload)?.details);
  if (!details) return null;
  const results = details.results;
  if (!Array.isArray(results)) return null;
  return results.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
}

function readMode(payload: unknown): string | undefined {
  return str(asRecord(asRecord(payload)?.details)?.mode);
}

/**
 * A *detached* run's details: `asyncDir` present while `results[]` is still
 * empty. `pi-subagents` returns this the instant it forks the worker — the tool
 * call then ends immediately while the real work runs for minutes in another
 * process, which is why such a call must not be read as a finished run.
 *
 * The empty-`results` guard matters: a synchronous run carries `asyncDir` too
 * once it completes, and that one really is done.
 */
function readDetached(
  payload: unknown
): { asyncDir: string; runId?: string; mode?: string } | null {
  const details = asRecord(asRecord(payload)?.details);
  if (!details) return null;
  const asyncDir = str(details.asyncDir);
  if (!asyncDir) return null;
  const results = details.results;
  if (Array.isArray(results) && results.length > 0) return null;
  const runId = str(details.runId) ?? str(details.asyncId);
  const mode = str(details.mode);
  return { asyncDir, ...(runId ? { runId } : {}), ...(mode ? { mode } : {}) };
}

/** first text part of the last assistant message — the worker's answer */
function finalOutput(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = asRecord(messages[i]);
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const p = asRecord(part);
      if (p?.type === "text") {
        const text = str(p.text);
        if (text) return text;
      }
    }
  }
  return undefined;
}

/**
 * Assistant messages → a timeline. `messages` is cumulative on every update, so
 * the whole list is rebuilt each time; ids are derived from the index to keep
 * React keys stable across rebuilds.
 */
function timeline(messages: unknown, cardId: string): SubagentEvent[] {
  if (!Array.isArray(messages)) return [];
  const events: SubagentEvent[] = [];
  for (const message of messages) {
    const msg = asRecord(message);
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const p = asRecord(part);
      if (!p) continue;
      const push = (kind: SubagentEvent["kind"], label: string, detail?: string) => {
        if (!label) return;
        events.push({
          id: `${cardId}-ev-${events.length}`,
          kind,
          label: label.replace(/\s+/g, " ").slice(0, 200),
          detail,
          at: 0, // the producer reports no per-step timing
        });
      };
      if (p.type === "text") push("text", str(p.text) ?? "");
      else if (p.type === "thinking") push("thinking", str(p.thinking) ?? str(p.text) ?? "");
      else if (p.type === "toolCall") {
        push("tool", str(p.name) ?? "tool", summarizeArgs(p.arguments));
      }
    }
  }
  return events;
}

/**
 * `toolCalls[]` → a timeline, for producers that report the worker's steps
 * instead of its raw messages.
 *
 * `pi-subagents` has no `messages` field at all: a finished worker reports
 * `toolCalls: [{ text, expandedText }]`, where `text` is a pre-rendered
 * `"<tool> <args>"` line. Splitting on the first space recovers the tool name so
 * the row reads like every other tool line, and `expandedText` supplies the
 * untruncated arguments underneath.
 */
function toolCallsTimeline(v: unknown, cardId: string): SubagentEvent[] {
  if (!Array.isArray(v)) return [];
  const events: SubagentEvent[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    const text = str(rec?.text) ?? str(rec?.expandedText);
    if (!text) continue;
    const space = text.indexOf(" ");
    const label = space === -1 ? text : text.slice(0, space);
    const args = space === -1 ? undefined : text.slice(space + 1).trim();
    // the expanded form is only worth showing when it says more than `text` did
    const expanded = str(rec?.expandedText);
    const detail =
      expanded && expanded !== text
        ? expanded.slice(label.length + 1).trim() || expanded
        : args;
    events.push({
      id: `${cardId}-tc-${events.length}`,
      kind: "tool",
      label: label.slice(0, 200),
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
      at: 0, // the producer reports no per-step timing
    });
  }
  return events;
}

function readUsage(v: unknown): SubagentUsage | undefined {
  const u = asRecord(v);
  if (!u) return undefined;
  const usage: SubagentUsage = {
    input: num(u.input) ?? 0,
    output: num(u.output) ?? 0,
    cacheRead: num(u.cacheRead) ?? 0,
    cacheWrite: num(u.cacheWrite) ?? 0,
    cost: num(u.cost) ?? 0,
    contextTokens: num(u.contextTokens) ?? 0,
    turns: num(u.turns) ?? 0,
  };
  // an all-zero usage block is the pre-seeded placeholder — not worth showing
  return usage.input || usage.output || usage.cost || usage.turns ? usage : undefined;
}

function statusOf(exitCode: number | undefined, stopReason: string | undefined): SubagentStatus {
  if (exitCode === undefined || exitCode === RUNNING_EXIT_CODE) return "running";
  if (stopReason === "error" || stopReason === "aborted") return "error";
  return exitCode === 0 ? "done" : "error";
}

function readSource(v: unknown): Subagent["source"] {
  const s = str(v);
  return s === "user" || s === "project" || s === "unknown" ? s : undefined;
}

/** one `details.results[i]` entry → one card */
function toCard(
  result: Record<string, unknown>,
  cardId: string,
  mode: string | undefined,
  total: number,
  now: number,
  previous?: Subagent
): Subagent {
  const exitCode = num(result.exitCode);
  const stopReason = str(result.stopReason);
  const status = statusOf(exitCode, stopReason);
  // two producers, two shapes: assistant `messages[]` (reference extension) or
  // pre-rendered `toolCalls[]` (pi-subagents). Whichever one is present wins;
  // keep the previous timeline if an update arrives carrying neither.
  const events = (() => {
    const fromMessages = timeline(result.messages, cardId);
    if (fromMessages.length > 0) return fromMessages;
    const fromToolCalls = toolCallsTimeline(result.toolCalls, cardId);
    if (fromToolCalls.length > 0) return fromToolCalls;
    return previous?.events ?? [];
  })();
  const step = num(result.step);
  const chained = mode === "chain" && total > 1;

  const errorText =
    status === "error"
      ? str(result.errorMessage) ??
        str(result.stderr) ??
        (stopReason ? `stopped: ${stopReason}` : undefined)
      : undefined;

  return {
    id: cardId,
    name: str(result.agent) ?? previous?.name ?? "subagent",
    task: str(result.task) ?? previous?.task ?? "…",
    status,
    // real fraction for a chain; for parallel/single there is nothing to
    // interpolate, so the card shows elapsed time instead of a fake bar
    progress: chained && step !== undefined ? Math.min(1, step / total) : status === "done" || status === "error" ? 1 : 0,
    events,
    result:
      status === "done"
        ? // `finalOutput` is pi-subagents' own field; `messages` is the
          // reference extension's. Bounded for the same reason the async
          // snapshot bounds it — a worker's report runs to tens of KB.
          (str(result.finalOutput)?.slice(0, 4000) ?? finalOutput(result.messages))
        : undefined,
    startedAtLabel: previous?.startedAtLabel ?? timeLabel(now),
    startedAt: previous?.startedAt ?? now,
    model: str(result.model) ?? previous?.model,
    usage: readUsage(result.usage) ?? previous?.usage,
    source: readSource(result.agentSource) ?? previous?.source,
    ...(chained && step !== undefined ? { step, total } : {}),
    ...(errorText ? { errorText } : {}),
  };
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Cards to show before the first update lands, read straight off the tool args.
 * Gives the deck instant fan-out instead of an empty gap while the first worker
 * boots. Returns [] when the args shape is unrecognized.
 */
function seedFromArgs(args: unknown, toolCallId: string, now: number): Subagent[] {
  const a = asRecord(args);
  if (!a) return [];
  const list = Array.isArray(a.tasks) ? a.tasks : Array.isArray(a.chain) ? a.chain : null;
  const blank = (name: string, task: string, i: number): Subagent => ({
    id: `${toolCallId}#${i}`,
    name,
    task,
    status: "queued",
    progress: 0,
    events: [],
    startedAtLabel: timeLabel(now),
    startedAt: now,
  });
  if (list) {
    return list.map((item, i) => {
      const t = asRecord(item);
      return blank(str(t?.agent) ?? "subagent", str(t?.task) ?? "…", i);
    });
  }
  const agent = str(a.agent);
  const task = str(a.task);
  if (agent || task) return [blank(agent ?? "subagent", task ?? "…", 0)];
  return [];
}

/** `{content:[{type:"text",text}]}` → joined text, for the degraded path */
function contentText(payload: unknown): string | undefined {
  const content = asRecord(payload)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => str(asRecord(c)?.text) ?? "")
    .join("")
    .trim();
  return text || undefined;
}

interface SubagentStore {
  agents: Subagent[];
  /** card id currently open in the drawer; null = closed */
  focusedId: string | null;
  /**
   * Live snapshots of detached runs, keyed by toolCallId — the drawer's data
   * source for background work.
   *
   * Kept even after `clearFinished()` drops the card, so clicking a subagent
   * row further up the transcript still opens its run instead of an empty
   * drawer. One bounded snapshot per subagent call per session.
   */
  asyncRuns: Record<string, AsyncRunStatus>;

  focus: (id: string | null) => void;
  upsert: (a: Subagent) => void;
  patch: (id: string, fn: (a: Subagent) => Partial<Subagent>) => void;
  pushEvent: (id: string, e: Omit<SubagentEvent, "id">) => void;
  /** replace every card belonging to one tool call, in place */
  syncFromTool: (toolCallId: string, cards: Subagent[]) => void;
  /** fold one polled `status.json` snapshot into the cards + snapshot map */
  syncAsyncRun: (toolCallId: string, status: AsyncRunStatus) => void;
  clearFinished: () => void;

  /** local showcase: spawn N mock subagents working in parallel */
  runDemo: () => void;
  demoRunning: boolean;

  /** subscribe to real pi tool events — subagent tools become cards */
  initPiBridge: () => void;
  bridged: boolean;
}

let evSeq = 0;

/**
 * Cancellers for the file pollers of live detached runs, keyed by toolCallId.
 * Module-level: these are subscriptions, not rendered state, and one run must
 * never be polled twice.
 */
const asyncPollers = new Map<string, () => void>();

export const useSubagents = create<SubagentStore>((set, get) => ({
  agents: [],
  focusedId: null,
  asyncRuns: {},
  demoRunning: false,
  bridged: false,

  initPiBridge: () => {
    if (get().bridged) return;
    set({ bridged: true });

    /** toolCallIds we recognized at start — updates for anything else are ignored */
    const owned = new Set<string>();
    /**
     * Worker count declared in the tool args. Chain mode appends to `results[]`
     * as steps finish, so `results.length` is the progress numerator, never the
     * denominator — taking the total from the args is what makes "2/3" correct.
     */
    const declaredTotal = new Map<string, number>();

    /** the tool-call handlers, bound per pi process (see `bind` at the end) */
    const onAgentStart = () => get().clearFinished();

    const onToolStart = (e: PiEvent) => {
      if (e.type !== "tool_execution_start" || !isSubagentTool(e.toolName)) return;
      owned.add(e.toolCallId);
      const seeded = seedFromArgs(e.args, e.toolCallId, Date.now());
      if (seeded.length > 0) {
        declaredTotal.set(e.toolCallId, seeded.length);
        get().syncFromTool(e.toolCallId, seeded);
      }
    };

    /**
     * Begin tracking a detached run: keep its card alive as running and poll
     * the producer's `status.json` for the progress the RPC stream never sends.
     */
    const trackDetached = (
      toolCallId: string,
      detached: { asyncDir: string; runId?: string; mode?: string }
    ) => {
      const prefix = `${toolCallId}#`;
      const now = Date.now();
      const { asyncDir, runId } = detached;

      if (get().agents.some((a) => a.id.startsWith(prefix))) {
        // seeded from the tool args — adopt it as background work
        set((s) => ({
          agents: s.agents.map((a) =>
            a.id.startsWith(prefix)
              ? {
                  ...a,
                  status: a.status === "queued" ? "running" : a.status,
                  asyncDir,
                  ...(runId ? { runId } : {}),
                }
              : a
          ),
        }));
      } else {
        // workflow args carry no recognizable task list — hold one card until
        // the first snapshot names the real steps
        get().syncFromTool(toolCallId, [
          {
            id: `${toolCallId}#0`,
            name: "subagent",
            task: "…",
            status: "running",
            progress: 0,
            events: [],
            startedAtLabel: timeLabel(now),
            startedAt: now,
            asyncDir,
            ...(runId ? { runId } : {}),
          },
        ]);
      }

      if (asyncPollers.has(toolCallId)) return; // already watching this run
      asyncPollers.set(
        toolCallId,
        pollAsyncRun(asyncDir, (status) => get().syncAsyncRun(toolCallId, status))
      );
    };

    /** shared by update + end: rebuild this call's cards from the payload */
    const absorb = (toolCallId: string, payload: unknown, finalIsError?: boolean) => {
      // A management call launched nothing — leave the transcript alone.
      if (isManagementCall(payload)) {
        get().syncFromTool(toolCallId, []);
        return;
      }

      // Detached next: such a call returns instantly with an empty results[],
      // so every path below would misread it as a run that produced nothing.
      const detached = readDetached(payload);
      if (detached) {
        trackDetached(toolCallId, detached);
        return;
      }

      const results = readResults(payload);
      const now = Date.now();
      const existing = get().agents;
      const prev = (id: string) => existing.find((a) => a.id === id);

      /*
       * A foreground run streams `details.progress[]` on every step. Recording it
       * is what makes such a run live: the panel's rich view is driven by these
       * snapshots, so it reports the current tool as the worker moves instead of
       * only the pre-rendered tail that lands with the final result.
       */
      const streamed = readSyncProgress(payload);
      if (streamed) {
        set((s) => ({
          asyncRuns: {
            ...s.asyncRuns,
            [toolCallId]: {
              ...streamed,
              // the tool call ending is what settles a foreground run
              terminal: finalIsError !== undefined,
            },
          },
        }));
      } else if (finalIsError !== undefined && get().asyncRuns[toolCallId]) {
        /*
         * The final result drops `progress` unless the call asked for it, so the
         * last snapshot we hold still says "running". Settle it here rather than
         * leaving a finished worker spinning: the tool call ending is proof
         * enough, and the streamed steps are otherwise the record we want to keep.
         */
        const settled = finalIsError ? "failed" : "completed";
        const outcome = readSyncOutcome(payload);
        set((s) => {
          const held = s.asyncRuns[toolCallId];
          if (!held) return {};
          return {
            asyncRuns: {
              ...s.asyncRuns,
              [toolCallId]: {
                ...held,
                // the closing payload is the only one carrying saved output paths
                ...outcome,
                artifacts:
                  outcome.artifacts.length > 0 ? outcome.artifacts : held.artifacts,
                terminal: true,
                steps: held.steps.map((step) => ({
                  ...step,
                  status:
                    step.status === "completed" || step.status === "failed"
                      ? step.status
                      : settled,
                  // nothing is in flight once the call has returned
                  currentTool: undefined,
                  currentToolArgs: undefined,
                  currentToolStartedAt: undefined,
                })),
              },
            },
          };
        });
      }

      if (results && results.length > 0) {
        const mode = readMode(payload);
        const total = Math.max(declaredTotal.get(toolCallId) ?? 0, results.length);
        const cards = results.map((r, i) => {
          const cardId = `${toolCallId}#${i}`;
          return toCard(r, cardId, mode, total, now, prev(cardId));
        });
        get().syncFromTool(toolCallId, cards);
        return;
      }

      // Degraded path: the producer is a user-editable extension, so an
      // unrecognized payload must not blank the deck. Keep one card alive and
      // use the tool's own text as its live status line.
      const cardId = `${toolCallId}#0`;
      const before = prev(cardId);
      const label = contentText(payload);
      const card: Subagent = {
        id: cardId,
        name: before?.name ?? "subagent",
        task: before?.task ?? "…",
        status:
          finalIsError === undefined ? "running" : finalIsError ? "error" : "done",
        progress: finalIsError === undefined ? 0 : 1,
        events:
          label && label !== before?.events[before.events.length - 1]?.label
            ? [
                ...(before?.events ?? []),
                {
                  id: `ev-${++evSeq}`,
                  kind: "status" as const,
                  label: label.slice(0, 200),
                  at: before ? now - before.startedAt : 0,
                },
              ]
            : (before?.events ?? []),
        ...(finalIsError === false && label ? { result: label } : {}),
        ...(finalIsError === true && label ? { errorText: label } : {}),
        startedAtLabel: before?.startedAtLabel ?? timeLabel(now),
        startedAt: before?.startedAt ?? now,
        ...(before?.model ? { model: before.model } : {}),
        ...(before?.usage ? { usage: before.usage } : {}),
        ...(before?.source ? { source: before.source } : {}),
      };
      get().syncFromTool(toolCallId, [card]);
    };

    const onToolUpdate = (e: PiEvent) => {
      if (e.type !== "tool_execution_update" || !owned.has(e.toolCallId)) return;
      absorb(e.toolCallId, e.partialResult);
    };

    const onToolEnd = (e: PiEvent) => {
      if (e.type !== "tool_execution_end" || !owned.has(e.toolCallId)) return;
      owned.delete(e.toolCallId);
      absorb(e.toolCallId, e.result, e.isError === true);
      declaredTotal.delete(e.toolCallId); // after absorb — it reads the total
      // A worker still marked running after the call ended never reported a
      // terminal exitCode — settle it rather than spinning forever. Detached
      // runs are the exception: their tool call always ends early by design,
      // and the worker keeps going. Settling those is what used to make a
      // background subagent look finished seconds after it started.
      set((s) => ({
        agents: s.agents.map((a) =>
          a.id.startsWith(`${e.toolCallId}#`) &&
          a.status === "running" &&
          a.asyncDir === undefined
            ? { ...a, status: e.isError ? "error" : "done", progress: 1 }
            : a
        ),
      }));
    };

    /**
     * Subscribe to one conversation's pi process.
     *
     * Each conversation runs its own pi process, keyed by task id — so the
     * default client this used to listen on belongs to no conversation at all,
     * and no subagent event ever arrived. Bindings for previously seen tasks are
     * deliberately kept rather than swapped out: a subagent launched in a
     * background conversation must keep being tracked while you look at another
     * one. Cards are keyed by toolCallId, so a row only ever resolves its own
     * call and the shared store cannot cross conversations.
     */
    const bound = new Set<string>();
    const bind = (taskId: string) => {
      if (bound.has(taskId)) return;
      bound.add(taskId);
      const client = getPiClient(taskId);
      client.on("agent_start", onAgentStart);
      client.on("tool_execution_start", onToolStart);
      client.on("tool_execution_update", onToolUpdate);
      client.on("tool_execution_end", onToolEnd);
    };

    bind(getActiveTaskId());
    useTaskContext.subscribe((s, prev) => {
      if (s.activeTaskId !== prev.activeTaskId) bind(s.activeTaskId);
    });
  },

  focus: (id) => set({ focusedId: id }),

  upsert: (a) =>
    set((s) => {
      const i = s.agents.findIndex((x) => x.id === a.id);
      if (i === -1) return { agents: [...s.agents, a] };
      const next = [...s.agents];
      next[i] = a;
      return { agents: next };
    }),

  patch: (id, fn) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...fn(a) } : a)),
    })),

  pushEvent: (id, e) =>
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === id
          ? { ...a, events: [...a.events, { ...e, id: `ev-${++evSeq}` }] }
          : a
      ),
    })),

  syncFromTool: (toolCallId, cards) =>
    set((s) => {
      const prefix = `${toolCallId}#`;
      const out: Subagent[] = [];
      let inserted = false;
      // splice the new block in where this call's first card already sat, so a
      // growing fan-out does not reorder the deck under the user
      for (const a of s.agents) {
        if (a.id.startsWith(prefix)) {
          if (!inserted) {
            out.push(...cards);
            inserted = true;
          }
          continue;
        }
        out.push(a);
      }
      if (!inserted) out.push(...cards);
      return { agents: out };
    }),

  syncAsyncRun: (toolCallId, status) => {
    const now = Date.now();
    const prefix = `${toolCallId}#`;
    const before = get().agents;
    const prev = (id: string) => before.find((a) => a.id === id);
    // the seeded card, kept as the fallback for fields the snapshot lacks
    const seed = before.find((a) => a.id.startsWith(prefix));

    // One card per reported step. Before the runner has written any, hold the
    // single placeholder so the run does not vanish between fork and first write.
    const steps = status.steps.length > 0 ? status.steps : [undefined];

    const cards: Subagent[] = steps.map((step, i) => {
      const id = `${prefix}${i}`;
      const earlier = prev(id);
      // a step with no state of its own inherits the run's
      const cardStatus = asyncStateToStatus(step?.status ?? status.state);
      const startedAt = step?.startedAt ?? earlier?.startedAt ?? status.startedAt ?? now;
      return {
        id,
        name: step?.agent ?? earlier?.name ?? seed?.name ?? "subagent",
        // status.json redacts the prompt, so the task text only ever comes from
        // the tool args captured at seed time
        task: earlier?.task ?? seed?.task ?? "…",
        status: cardStatus,
        progress: cardStatus === "done" || cardStatus === "error" ? 1 : 0,
        events: [], // the drawer reads the richer feed off the snapshot
        startedAtLabel: earlier?.startedAtLabel ?? timeLabel(startedAt),
        startedAt,
        ...(step?.model ?? earlier?.model ? { model: step?.model ?? earlier?.model } : {}),
        ...(earlier?.source ? { source: earlier.source } : {}),
        ...(seed?.asyncDir ?? earlier?.asyncDir
          ? { asyncDir: (earlier?.asyncDir ?? seed?.asyncDir) as string }
          : {}),
        ...(status.runId ?? earlier?.runId
          ? { runId: (status.runId ?? earlier?.runId) as string }
          : {}),
      };
    });

    get().syncFromTool(toolCallId, cards);
    set((s) => ({ asyncRuns: { ...s.asyncRuns, [toolCallId]: status } }));

    // terminal snapshots are final: the poller has already stopped itself, so
    // drop its canceller rather than leaving a dead entry behind
    if (status.terminal) asyncPollers.delete(toolCallId);
  },

  clearFinished: () =>
    set((s) => ({
      agents: s.agents.filter(
        (a) => a.status === "running" || a.status === "queued"
      ),
    })),

  runDemo: () => {
    if (get().demoRunning) return;
    set({ demoRunning: true });

    const specs: {
      name: string;
      task: string;
      model: string;
      source: Subagent["source"];
      script: [number, SubagentEvent["kind"], string, string?][];
    }[] = [
      {
        name: "explorer",
        task: "Map the auth flow across the codebase",
        model: "claude-sonnet-4-5",
        source: "user",
        script: [
          [400, "status", "Started", "search breadth: medium"],
          [900, "tool", "grep", "\"session|token\" — 42 hits in 11 files"],
          [1900, "tool", "read", "src/lib/auth/session.ts (210 lines)"],
          [3200, "thinking", "Tracing refresh-token rotation…"],
          [4600, "tool", "read", "src/middleware.ts (88 lines)"],
          [5800, "text", "Auth flow mapped", "entry → middleware → session.verify → rotate"],
        ],
      },
      {
        name: "test-writer",
        task: "Write tests for runAgentLoop()",
        model: "claude-opus-4-8",
        source: "project",
        script: [
          [600, "status", "Started", "target: src/lib/agent.ts"],
          [1400, "tool", "read", "src/lib/agent.ts (142 lines)"],
          [2600, "thinking", "Choosing seams: mock reason() + execute()…"],
          [4200, "tool", "write", "src/lib/agent.spec.ts (+96 lines)"],
          [5600, "tool", "bash", "pnpm vitest run agent.spec — 6 passed"],
          [6400, "text", "6 tests added, all green", "covers depth-3 planning + abort path"],
        ],
      },
      {
        name: "reviewer",
        task: "Review the streaming diff patch",
        model: "claude-sonnet-4-5",
        source: "user",
        script: [
          [800, "status", "Started", "diff: +1 −1 in agent.ts"],
          [1700, "tool", "read", "git diff HEAD (1 hunk)"],
          [3000, "thinking", "Checking error propagation of reason()…"],
          [4400, "text", "1 suggestion", "await reason() lacks a timeout guard"],
        ],
      },
    ];

    const now = Date.now();
    const { upsert, patch, pushEvent } = get();
    // share one synthetic "tool call" prefix so the drawer lists all three as
    // siblings, the same way a real parallel fan-out does
    const call = `demo-${now}`;

    specs.forEach((spec, i) => {
      const id = `${call}#${i}`;
      const total = spec.script.length;
      upsert({
        id,
        name: spec.name,
        task: spec.task,
        status: "queued",
        progress: 0,
        events: [],
        startedAtLabel: timeLabel(now),
        startedAt: now,
        model: spec.model,
        source: spec.source,
        step: 0,
        total,
      });

      // stagger the starts like a real fan-out
      setTimeout(() => patch(id, () => ({ status: "running" })), 250 + i * 350);

      // the demo has no transcript row to click, so open the drawer on it
      if (i === 0) set({ focusedId: id });

      spec.script.forEach(([at, kind, lbl, detail], j) => {
        setTimeout(() => {
          pushEvent(id, { kind, label: lbl, detail, at });
          patch(id, () => ({ step: j + 1, progress: (j + 1) / total }));
        }, 250 + i * 350 + at);
      });

      const last = spec.script[total - 1];
      setTimeout(
        () => {
          patch(id, () => ({
            status: "done",
            progress: 1,
            step: total,
            result: last[3] ?? last[2],
            usage: {
              input: 12_400 + i * 3_100,
              output: 890 + i * 210,
              cacheRead: 8_200,
              cacheWrite: 1_100,
              cost: 0.042 + i * 0.011,
              contextTokens: 21_500 + i * 4_000,
              turns: total,
            },
          }));
          // when the final agent lands, release the demo lock
          if (i === specs.length - 1) set({ demoRunning: false });
        },
        250 + i * 350 + last[0] + 500
      );
    });
  },
}));

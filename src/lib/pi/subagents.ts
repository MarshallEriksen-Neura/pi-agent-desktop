"use client";

import { create } from "zustand";
import { getPiClient } from "./client";

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

function isSubagentTool(toolName: string): boolean {
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
  const events = timeline(result.messages, cardId);
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
    result: status === "done" ? finalOutput(result.messages) : undefined,
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
  /** id currently expanded into the detail layer; null = deck view */
  focusedId: string | null;

  focus: (id: string | null) => void;
  upsert: (a: Subagent) => void;
  patch: (id: string, fn: (a: Subagent) => Partial<Subagent>) => void;
  pushEvent: (id: string, e: Omit<SubagentEvent, "id">) => void;
  /** replace every card belonging to one tool call, in place */
  syncFromTool: (toolCallId: string, cards: Subagent[]) => void;
  clearFinished: () => void;

  /** local showcase: spawn N mock subagents working in parallel */
  runDemo: () => void;
  demoRunning: boolean;

  /** subscribe to real pi tool events — subagent tools become cards */
  initPiBridge: () => void;
  bridged: boolean;
}

let evSeq = 0;

export const useSubagents = create<SubagentStore>((set, get) => ({
  agents: [],
  focusedId: null,
  demoRunning: false,
  bridged: false,

  initPiBridge: () => {
    if (get().bridged) return;
    set({ bridged: true });
    const client = getPiClient();
    /** toolCallIds we recognized at start — updates for anything else are ignored */
    const owned = new Set<string>();
    /**
     * Worker count declared in the tool args. Chain mode appends to `results[]`
     * as steps finish, so `results.length` is the progress numerator, never the
     * denominator — taking the total from the args is what makes "2/3" correct.
     */
    const declaredTotal = new Map<string, number>();

    // a new run supersedes finished workers; keep in-flight ones visible
    client.on("agent_start", () => get().clearFinished());

    client.on("tool_execution_start", (e) => {
      if (e.type !== "tool_execution_start" || !isSubagentTool(e.toolName)) return;
      owned.add(e.toolCallId);
      const seeded = seedFromArgs(e.args, e.toolCallId, Date.now());
      if (seeded.length > 0) {
        declaredTotal.set(e.toolCallId, seeded.length);
        get().syncFromTool(e.toolCallId, seeded);
      }
    });

    /** shared by update + end: rebuild this call's cards from the payload */
    const absorb = (toolCallId: string, payload: unknown, finalIsError?: boolean) => {
      const results = readResults(payload);
      const now = Date.now();
      const existing = get().agents;
      const prev = (id: string) => existing.find((a) => a.id === id);

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

    client.on("tool_execution_update", (e) => {
      if (e.type !== "tool_execution_update" || !owned.has(e.toolCallId)) return;
      absorb(e.toolCallId, e.partialResult);
    });

    client.on("tool_execution_end", (e) => {
      if (e.type !== "tool_execution_end" || !owned.has(e.toolCallId)) return;
      owned.delete(e.toolCallId);
      absorb(e.toolCallId, e.result, e.isError === true);
      declaredTotal.delete(e.toolCallId); // after absorb — it reads the total
      // a worker still marked running after the call ended never reported a
      // terminal exitCode — settle it rather than spinning forever
      set((s) => ({
        agents: s.agents.map((a) =>
          a.id.startsWith(`${e.toolCallId}#`) && a.status === "running"
            ? { ...a, status: e.isError ? "error" : "done", progress: 1 }
            : a
        ),
      }));
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

    specs.forEach((spec, i) => {
      const id = `sub-${now}-${i}`;
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

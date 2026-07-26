"use client";

import { create } from "zustand";
import { getPiClient } from "./client";

/**
 * Subagent model — parallel worker agents spawned by the main pi session.
 *
 * pi's RPC surface has no first-class subagent protocol yet; subagents appear
 * as tool executions (e.g. a `task`/`agent` tool). This store normalizes both:
 *  - real events: tool_execution_start/update/end with an agent-ish toolName
 *  - demo events: driven locally so the UI is fully previewable
 */

export type SubagentStatus = "queued" | "running" | "done" | "error";

export interface SubagentEvent {
  id: string;
  kind: "thinking" | "tool" | "text" | "status";
  label: string;
  detail?: string;
  at: number; // ms since agent start (stable for resume/replay)
}

export interface Subagent {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  /** 0..1 coarse progress, from event count vs estimate */
  progress: number;
  events: SubagentEvent[];
  result?: string;
  startedAtLabel: string;
}

interface SubagentStore {
  agents: Subagent[];
  /** id currently expanded into the detail layer; null = deck view */
  focusedId: string | null;

  focus: (id: string | null) => void;
  upsert: (a: Subagent) => void;
  patch: (id: string, fn: (a: Subagent) => Partial<Subagent>) => void;
  pushEvent: (id: string, e: Omit<SubagentEvent, "id">) => void;
  clearFinished: () => void;

  /** local showcase: spawn N mock subagents working in parallel */
  runDemo: () => void;
  demoRunning: boolean;

  /** subscribe to real pi tool events — agent-ish tools become cards */
  initPiBridge: () => void;
  bridged: boolean;
}

/** toolNames that represent a spawned worker rather than a plain tool */
const AGENT_TOOL = /^(task|agent|subagent|spawn[_-]?agent|dispatch[_-]?agent)$/i;

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
    const started = new Map<string, number>(); // toolCallId → t0

    client.on("tool_execution_start", (e) => {
      if (e.type !== "tool_execution_start" || !AGENT_TOOL.test(e.toolName)) return;
      const args = (e.args ?? {}) as Record<string, unknown>;
      started.set(e.toolCallId, performance.now());
      get().upsert({
        id: e.toolCallId,
        name: String(args.name ?? args.agent ?? e.toolName),
        task: String(args.task ?? args.prompt ?? args.description ?? "…"),
        status: "running",
        progress: 0.1,
        events: [],
        startedAtLabel: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    });

    client.on("tool_execution_update", (e) => {
      if (e.type !== "tool_execution_update") return;
      const t0 = started.get(e.toolCallId);
      if (t0 === undefined) return; // not one of ours
      const text =
        typeof e.partialResult === "string"
          ? e.partialResult
          : JSON.stringify(e.partialResult ?? "");
      get().pushEvent(e.toolCallId, {
        kind: "text",
        label: text.slice(0, 120),
        at: Math.round(performance.now() - t0),
      });
      get().patch(e.toolCallId, (a) => ({
        progress: Math.min(0.9, a.progress + 0.12),
      }));
    });

    client.on("tool_execution_end", (e) => {
      if (e.type !== "tool_execution_end") return;
      const t0 = started.get(e.toolCallId);
      if (t0 === undefined) return;
      started.delete(e.toolCallId);
      const text =
        typeof e.result === "string"
          ? e.result
          : JSON.stringify(e.result ?? "");
      get().patch(e.toolCallId, () => ({
        status: e.isError ? "error" : "done",
        progress: 1,
        result: text.slice(0, 200),
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

  clearFinished: () =>
    set((s) => ({
      agents: s.agents.filter(
        (a) => a.status === "running" || a.status === "queued"
      ),
    })),

  runDemo: () => {
    if (get().demoRunning) return;
    set({ demoRunning: true });

    const specs: { name: string; task: string; script: [number, SubagentEvent["kind"], string, string?][] }[] = [
      {
        name: "explorer",
        task: "Map the auth flow across the codebase",
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
        script: [
          [800, "status", "Started", "diff: +1 −1 in agent.ts"],
          [1700, "tool", "read", "git diff HEAD (1 hunk)"],
          [3000, "thinking", "Checking error propagation of reason()…"],
          [4400, "text", "1 suggestion", "await reason() lacks a timeout guard"],
        ],
      },
    ];

    const now = new Date();
    const label = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const { upsert, patch, pushEvent } = get();

    specs.forEach((spec, i) => {
      const id = `sub-${Date.now()}-${i}`;
      upsert({
        id,
        name: spec.name,
        task: spec.task,
        status: "queued",
        progress: 0,
        events: [],
        startedAtLabel: label,
      });

      // stagger the starts like a real fan-out
      setTimeout(() => patch(id, () => ({ status: "running" })), 250 + i * 350);

      spec.script.forEach(([at, kind, lbl, detail], j) => {
        setTimeout(() => {
          pushEvent(id, { kind, label: lbl, detail, at });
          patch(id, () => ({ progress: (j + 1) / spec.script.length }));
        }, 250 + i * 350 + at);
      });

      const total = 250 + i * 350 + spec.script[spec.script.length - 1][0] + 500;
      setTimeout(() => {
        const last = spec.script[spec.script.length - 1];
        patch(id, () => ({
          status: "done",
          progress: 1,
          result: last[3] ?? last[2],
        }));
        // when the final agent lands, release the demo lock
        if (i === specs.length - 1) set({ demoRunning: false });
      }, total);
    });
  },
}));

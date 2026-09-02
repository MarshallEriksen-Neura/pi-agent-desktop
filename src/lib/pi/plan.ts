"use client";

/**
 * Plan state — pi's todo list, folded out of the tool calls that mutate it.
 *
 * pi's `todo` tool is a command stream, not a snapshot: `create` appends an item
 * without naming it (pi assigns the id itself, counting from 1 — its own
 * `blockedBy: [1]` references are the proof), and `update` patches one by id.
 * Nothing on the wire carries the whole list, so the only way to know what the
 * plan looks like is to replay the calls in order. This module does that as a
 * pure fold, so the same code serves both the live stream (agent-bridge, one
 * call at a time) and a session restored from history (a whole transcript at
 * once).
 *
 * The tool name is matched narrowly — exactly `todo`, unlike `TASK_TOOL` in
 * tool-label, which is a deliberately loose bucket for picking a row icon.
 * Folding an unrelated `task`/`plan` call in here would invent steps.
 */

import { useMemo } from "react";
import { create } from "zustand";
import type { ChatToolCall } from "./chat";

/** pi's todo mutation tool. Narrower than tool-label's TASK_TOOL on purpose. */
const PLAN_TOOL = /^todo$/i;

export type PlanItemStatus = "pending" | "in_progress" | "completed";

const STATUSES: readonly PlanItemStatus[] = ["pending", "in_progress", "completed"];

export interface PlanItem {
  /** pi's own 1-based id — what `blockedBy` entries refer to */
  id: number;
  subject: string;
  description?: string;
  /** present-tense phrasing pi supplies for the step while it is the active one */
  activeForm?: string;
  status: PlanItemStatus;
  /** ids that have to finish before this one can start */
  blockedBy?: number[];
}

/**
 * The fold's accumulator.
 *
 * `seq` is a monotonic counter rather than `max(id) + 1` over the live items: if
 * pi deletes an item (the `includeDeleted` argument says it can), recomputing
 * from what is left would hand the next `create` an id that some `blockedBy`
 * still points at.
 */
export interface PlanState {
  items: PlanItem[];
  seq: number;
}

export const EMPTY_PLAN: PlanState = { items: [], seq: 0 };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** pi's ids are positive integers; anything else is not an id we can key on. */
function id(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function status(value: unknown): PlanItemStatus | undefined {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
    ? (value as PlanItemStatus)
    : undefined;
}

/** `blockedBy` is only useful if every entry is a real id — a partial list would
 *  under-report what a step is waiting on, which reads as "ready" when it is not. */
function blockedBy(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: number[] = [];
  for (const raw of value) {
    const n = id(raw);
    if (n === undefined) return undefined;
    ids.push(n);
  }
  return ids.length > 0 ? ids : undefined;
}

/**
 * Apply a patch, field by field, skipping the ones the call did not carry.
 *
 * Spelled out rather than looped so the rule is visible: pi's `update` sends only
 * what changed, so a missing `subject` means "leave it alone", never "blank it".
 */
function patch(item: PlanItem, changes: Partial<PlanItem>): PlanItem {
  return {
    ...item,
    ...(changes.subject !== undefined ? { subject: changes.subject } : {}),
    ...(changes.description !== undefined ? { description: changes.description } : {}),
    ...(changes.activeForm !== undefined ? { activeForm: changes.activeForm } : {}),
    ...(changes.status !== undefined ? { status: changes.status } : {}),
    ...(changes.blockedBy !== undefined ? { blockedBy: changes.blockedBy } : {}),
  };
}

/** Whether this tool call is one that mutates or reads pi's todo list. */
export function isPlanTool(toolName: string): boolean {
  return PLAN_TOOL.test(toolName);
}

/**
 * Apply one `todo` call to the plan. Pure: returns the same state object when the
 * call changes nothing, so a store can skip the notify.
 *
 * `list` and `get` are reads — they report the plan back to the model and must
 * not touch it. An unknown action is ignored rather than guessed at.
 */
export function applyPlanCall(state: PlanState, call: ChatToolCall): PlanState {
  if (!isPlanTool(call.name)) return state;
  const args = record(call.args);
  if (!args) return state;
  const action = text(args.action)?.toLowerCase();
  const subject = text(args.subject);
  const description = text(args.description);
  const activeForm = text(args.activeForm);
  const blocked = blockedBy(args.blockedBy);
  const next = status(args.status);
  const target = id(args.id);

  if (action === "create") {
    const seq = state.seq + 1;
    return {
      seq,
      items: [
        ...state.items,
        {
          id: seq,
          // pi always sends a subject on create; the fallbacks keep a malformed
          // call from rendering as a blank row
          subject: subject ?? activeForm ?? description ?? `#${seq}`,
          ...(description !== undefined ? { description } : {}),
          ...(activeForm !== undefined ? { activeForm } : {}),
          status: next ?? "pending",
          ...(blocked !== undefined ? { blockedBy: blocked } : {}),
        },
      ],
    };
  }

  if (action === "delete" || action === "remove") {
    if (target === undefined) return state;
    const items = state.items.filter((item) => item.id !== target);
    if (items.length === state.items.length) return state;
    return { items, seq: Math.max(state.seq, target) };
  }

  if (action === "update") {
    if (target === undefined) return state;
    const at = state.items.findIndex((item) => item.id === target);
    /* An update for an id we never saw created. Not a bug to swallow: pi's todo
       store survives compaction, and the `create` that introduced this step can
       have been summarized out of the branch we replayed. Synthesizing the item
       shows a step that really exists; dropping the call would leave the plan
       silently short. `seq` moves up so a later `create` cannot collide with it. */
    if (at < 0) {
      return {
        seq: Math.max(state.seq, target),
        items: [
          ...state.items,
          {
            id: target,
            subject: subject ?? activeForm ?? description ?? `#${target}`,
            ...(description !== undefined ? { description } : {}),
            ...(activeForm !== undefined ? { activeForm } : {}),
            status: next ?? "pending",
            ...(blocked !== undefined ? { blockedBy: blocked } : {}),
          },
        ].sort((a, b) => a.id - b.id),
      };
    }
    const updated = patch(state.items[at], {
      subject,
      description,
      activeForm,
      status: next,
      blockedBy: blocked,
    });
    const items = [...state.items];
    items[at] = updated;
    return { items, seq: state.seq };
  }

  return state;
}

/**
 * Replay every `todo` call in `calls` — the restore path. Order matters, so pass
 * the transcript's calls oldest-first; non-todo calls are skipped, which lets a
 * caller hand over a whole message's tool list without filtering.
 */
export function foldPlan(calls: Iterable<ChatToolCall>): PlanState {
  let state = EMPTY_PLAN;
  for (const call of calls) state = applyPlanCall(state, call);
  return state;
}

export interface PlanProgress {
  done: number;
  total: number;
  /** the step pi says it is on — the first `in_progress`, if any */
  active?: PlanItem;
}

/**
 * The one-line reading of a plan: how far along, and what is happening now.
 *
 * `active` is the *first* in-progress item rather than the last. pi normally has
 * one at a time, but it can mark several; the earliest is the one whose
 * `activeForm` reads as the current step.
 */
export function planProgress(items: readonly PlanItem[]): PlanProgress {
  let done = 0;
  let active: PlanItem | undefined;
  for (const item of items) {
    if (item.status === "completed") done++;
    else if (item.status === "in_progress" && active === undefined) active = item;
  }
  return { done, total: items.length, ...(active ? { active } : {}) };
}

/** What a single `todo` call did, for the one transcript row that stands in for it. */
export interface PlanCallSummary {
  kind: "created" | "started" | "completed" | "changed" | "removed";
  /** the step's own words, when the call carried them */
  label?: string;
  /** pi's step number, for the rows that have no words to show */
  step?: number;
}

/**
 * Read one `todo` call as a line of transcript.
 *
 * Returns null for the calls that should not produce a row at all: `list` and
 * `get` are the model reading its own notes back, and pi makes a lot of them —
 * before this they were rows saying "todo" and nothing else.
 *
 * The rows that do render describe the change rather than the resulting state.
 * A row cannot honestly show `3/7` anyway: the plan is folded forward, so the
 * progress at some point in the past is not something a row can look up without
 * replaying the whole branch for every row on screen.
 */
export function summarizePlanCall(call: ChatToolCall): PlanCallSummary | null {
  if (!isPlanTool(call.name)) return null;
  const args = record(call.args);
  if (!args) return null;
  const action = text(args.action)?.toLowerCase();
  const step = id(args.id);
  const subject = text(args.subject);
  const activeForm = text(args.activeForm);
  const next = status(args.status);

  if (action === "create") {
    return { kind: "created", ...(subject !== undefined ? { label: subject } : {}) };
  }
  if (action === "delete" || action === "remove") {
    return { kind: "removed", ...(step !== undefined ? { step } : {}) };
  }
  if (action !== "update") return null;

  /* `update` sends only what changed, so the words available depend on the call:
     a step going in-progress carries its activeForm, one being completed often
     carries nothing but the id. Falling back to the number keeps the row true
     rather than guessing at a name. */
  const label = next === "in_progress" ? activeForm ?? subject : subject ?? activeForm;
  const kind =
    next === "completed" ? "completed" : next === "in_progress" ? "started" : "changed";
  return {
    kind,
    ...(label !== undefined ? { label } : {}),
    ...(step !== undefined ? { step } : {}),
  };
}

interface PlanStore {
  /**
   * Keyed by task id, because every conversation has its own todo list. Only the
   * focused task's stream is subscribed (see agent-bridge), so a background
   * task's entry simply stops updating rather than being wrong — and survives
   * until that task is focused again and replays its own transcript.
   */
  plans: Record<string, PlanState>;
  /** One live `todo` call landed. */
  apply: (taskId: string, call: ChatToolCall) => void;
  /** Restore path: the whole plan, recomputed from a transcript. */
  replace: (taskId: string, state: PlanState) => void;
  clear: (taskId: string) => void;
}

export const usePlan = create<PlanStore>((set) => ({
  plans: {},
  apply: (taskId, call) =>
    set((s) => {
      const current = s.plans[taskId] ?? EMPTY_PLAN;
      const next = applyPlanCall(current, call);
      // `applyPlanCall` returns the same object when nothing moved — don't
      // publish a new map for a `list` call, every subscriber would re-render
      if (next === current) return s;
      return { plans: { ...s.plans, [taskId]: next } };
    }),
  replace: (taskId, state) =>
    set((s) => ({ plans: { ...s.plans, [taskId]: state } })),
  clear: (taskId) =>
    set((s) => {
      if (!(taskId in s.plans)) return s;
      const plans = { ...s.plans };
      delete plans[taskId];
      return { plans };
    }),
}));

/** This task's plan items, or an empty list when it has none. */
export function usePlanItems(taskId: string | null): PlanItem[] {
  return usePlan((s) => (taskId ? s.plans[taskId]?.items : undefined) ?? EMPTY_PLAN.items);
}

/**
 * This task's progress. One source for both the header's status line and the
 * panel, so the `3/7` in the two places cannot drift.
 */
export function usePlanProgress(taskId: string | null): PlanProgress {
  const items = usePlanItems(taskId);
  return useMemo(() => planProgress(items), [items]);
}

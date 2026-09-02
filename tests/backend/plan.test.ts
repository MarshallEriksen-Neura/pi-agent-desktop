import assert from "node:assert/strict";
import test from "node:test";
import type { ChatToolCall } from "../../src/lib/pi/chat";
import {
  applyPlanCall,
  EMPTY_PLAN,
  foldPlan,
  isPlanTool,
  planProgress,
  summarizePlanCall,
} from "../../src/lib/pi/plan";

/** A `todo` call as pi actually sends it — arguments only, no id of our own. */
function todo(args: Record<string, unknown>, id = "call"): ChatToolCall {
  return { id, name: "todo", args, status: "done" };
}

test("matches pi's todo tool and nothing broader", () => {
  assert.equal(isPlanTool("todo"), true);
  assert.equal(isPlanTool("TODO"), true);
  // tool-label's TASK_TOOL buckets these for the row icon; folding them would
  // invent steps
  assert.equal(isPlanTool("todo_write"), false);
  assert.equal(isPlanTool("task"), false);
  assert.equal(isPlanTool("plan"), false);
  assert.equal(isPlanTool("plan_mode_complete"), false);
});

test("create numbers items from 1, the base blockedBy refers to", () => {
  const { items, seq } = foldPlan([
    todo({ action: "create", subject: "读 session-lifecycle" }),
    todo({ action: "create", subject: "删除重复块", activeForm: "正在删除重复块" }),
    todo({ action: "create", subject: "跑测试", blockedBy: [1, 2] }),
  ]);
  assert.equal(seq, 3);
  assert.deepEqual(
    items.map((item) => [item.id, item.subject, item.status]),
    [
      [1, "读 session-lifecycle", "pending"],
      [2, "删除重复块", "pending"],
      [3, "跑测试", "pending"],
    ],
  );
  assert.equal(items[1].activeForm, "正在删除重复块");
  assert.deepEqual(items[2].blockedBy, [1, 2]);
});

test("update patches by id without blanking what it left out", () => {
  const { items } = foldPlan([
    todo({ action: "create", subject: "删除重复块", description: "保留唯一异常路径" }),
    todo({ action: "update", id: 1, status: "in_progress", activeForm: "正在删除重复块" }),
    todo({ action: "update", id: 1, status: "completed" }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "completed");
  // neither update carried a subject or description — both survive
  assert.equal(items[0].subject, "删除重复块");
  assert.equal(items[0].description, "保留唯一异常路径");
  assert.equal(items[0].activeForm, "正在删除重复块");
});

test("reads are reads: list and get leave the plan alone", () => {
  const created = foldPlan([todo({ action: "create", subject: "跑测试" })]);
  const after = foldPlan([
    todo({ action: "create", subject: "跑测试" }),
    todo({ action: "list", includeDeleted: false }),
    todo({ action: "get", id: 1 }),
  ]);
  assert.deepEqual(after, created);
  // and the identity is preserved, which is what lets the store skip the notify
  assert.equal(
    applyPlanCall(created, todo({ action: "list" })),
    created,
  );
});

test("an update for an unseen id synthesizes the step compaction dropped", () => {
  /* pi's todo store outlives compaction, so a resumed branch can carry updates
     whose `create` was summarized away. Dropping them would leave the plan short. */
  const { items, seq } = foldPlan([
    todo({ action: "update", id: 4, status: "in_progress", activeForm: "正在接线索引" }),
    todo({ action: "create", subject: "写测试" }),
  ]);
  assert.deepEqual(
    items.map((item) => [item.id, item.subject]),
    [
      [4, "正在接线索引"],
      [5, "写测试"],
    ],
  );
  // the synthesized id pushed seq up, so the later create could not collide
  assert.equal(seq, 5);
});

test("a partial blockedBy is rejected rather than half-reported", () => {
  const { items } = foldPlan([
    todo({ action: "create", subject: "跑测试", blockedBy: [1, "2"] }),
    todo({ action: "create", subject: "cargo check", blockedBy: [] }),
  ]);
  // a step that under-reports what it waits on reads as ready when it is not
  assert.equal(items[0].blockedBy, undefined);
  assert.equal(items[1].blockedBy, undefined);
});

test("delete drops the item and never lets its id be reused", () => {
  const { items, seq } = foldPlan([
    todo({ action: "create", subject: "一" }),
    todo({ action: "create", subject: "二" }),
    todo({ action: "delete", id: 2 }),
    todo({ action: "create", subject: "三" }),
  ]);
  assert.deepEqual(
    items.map((item) => [item.id, item.subject]),
    [
      [1, "一"],
      [3, "三"],
    ],
  );
  assert.equal(seq, 3);
});

test("non-todo calls and unusable arguments pass through untouched", () => {
  assert.deepEqual(foldPlan([{ id: "c", name: "read", args: { path: "a.ts" }, status: "done" }]), EMPTY_PLAN);
  assert.deepEqual(foldPlan([todo({ action: "sneeze" })]), EMPTY_PLAN);
  assert.deepEqual(foldPlan([{ id: "c", name: "todo", status: "done" }]), EMPTY_PLAN);
  assert.deepEqual(foldPlan([todo({ action: "update", status: "completed" })]), EMPTY_PLAN);
});

test("progress counts done and names the first step in flight", () => {
  const { items } = foldPlan([
    todo({ action: "create", subject: "一" }),
    todo({ action: "create", subject: "二" }),
    todo({ action: "create", subject: "三" }),
    todo({ action: "update", id: 1, status: "completed" }),
    todo({ action: "update", id: 2, status: "in_progress", activeForm: "正在做二" }),
    todo({ action: "update", id: 3, status: "in_progress" }),
  ]);
  const progress = planProgress(items);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  // pi normally marks one at a time; the earliest is the one whose activeForm
  // reads as the current step
  assert.equal(progress.active?.id, 2);
  assert.equal(progress.active?.activeForm, "正在做二");

  assert.deepEqual(planProgress([]), { done: 0, total: 0 });
});

test("a plan read produces no transcript row at all", () => {
  // pi calls these constantly; before this each one was a row saying "todo"
  assert.equal(summarizePlanCall(todo({ action: "list", includeDeleted: false })), null);
  assert.equal(summarizePlanCall(todo({ action: "get", id: 1 })), null);
  assert.equal(summarizePlanCall({ id: "c", name: "read", args: {}, status: "done" }), null);
  assert.equal(summarizePlanCall(todo({ action: "sneeze" })), null);
});

test("a plan row describes the change, in the words the call carried", () => {
  assert.deepEqual(summarizePlanCall(todo({ action: "create", subject: "跑测试" })), {
    kind: "created",
    label: "跑测试",
  });
  assert.deepEqual(
    summarizePlanCall(
      todo({ action: "update", id: 2, status: "in_progress", activeForm: "正在删除重复块" }),
    ),
    { kind: "started", label: "正在删除重复块", step: 2 },
  );
  // completing a step usually carries nothing but the id — the row falls back to
  // the number rather than inventing a name
  assert.deepEqual(summarizePlanCall(todo({ action: "update", id: 2, status: "completed" })), {
    kind: "completed",
    step: 2,
  });
  // a description-only edit is a change with no new status
  assert.deepEqual(
    summarizePlanCall(todo({ action: "update", id: 3, description: "补充说明" })),
    { kind: "changed", step: 3 },
  );
  assert.deepEqual(summarizePlanCall(todo({ action: "delete", id: 3 })), {
    kind: "removed",
    step: 3,
  });
});

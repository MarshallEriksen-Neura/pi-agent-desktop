import assert from "node:assert/strict";
import test from "node:test";
import type { FileDiff } from "../../src/lib/pi/file-diffs";
import { NO_CHANGES, turnChanges } from "../../src/lib/pi/turn";

function diff(
  path: string,
  added: number,
  removed: number,
  at: number,
  extra: { taskId?: string; approx?: boolean } = {},
): FileDiff {
  return {
    path,
    added,
    removed,
    at,
    hunks: [],
    ...(extra.taskId !== undefined ? { taskId: extra.taskId } : {}),
    ...(extra.approx ? { approx: true } : {}),
  };
}

const TURN = { taskId: "t1", startedAt: 1000 };

test("no window means no answer, not an empty-looking one", () => {
  assert.deepEqual(turnChanges({ a: diff("a.ts", 3, 1, 1200, { taskId: "t1" }) }, null), NO_CHANGES);
});

test("keeps only this task's edits from this turn", () => {
  const changes = turnChanges(
    {
      old: diff("before.ts", 9, 9, 900, { taskId: "t1" }),
      other: diff("elsewhere.ts", 5, 5, 1400, { taskId: "t2" }),
      loose: diff("unattributed.ts", 7, 7, 1500),
      mine: diff("mine.ts", 3, 1, 1200, { taskId: "t1" }),
    },
    TURN,
  );
  assert.deepEqual(
    changes.files.map((file) => file.path),
    ["mine.ts"],
  );
  assert.deepEqual([changes.added, changes.removed], [3, 1]);
});

test("several edits to one file collapse into one row", () => {
  const changes = turnChanges(
    {
      first: diff("a.ts", 21, 0, 1100, { taskId: "t1" }),
      second: diff("a.ts", 2, 5, 1300, { taskId: "t1" }),
    },
    TURN,
  );
  assert.equal(changes.files.length, 1);
  const [file] = changes.files;
  assert.equal(file.edits, 2);
  // a sum of the turn's edits, not a net file diff — the same accounting the
  // transcript badges already show
  assert.deepEqual([file.added, file.removed], [23, 5]);
  // the newest edit owns the row's diff, so clicking it shows what just landed
  assert.equal(file.toolCallId, "second");
  // …while the first touch keeps the row's place in the list
  assert.equal(file.at, 1100);
  assert.deepEqual([changes.added, changes.removed], [23, 5]);
});

test("files are listed in the order the turn first touched them", () => {
  const changes = turnChanges(
    {
      // deliberately out of chronological key order
      c: diff("c.ts", 1, 0, 1300, { taskId: "t1" }),
      a: diff("a.ts", 1, 0, 1100, { taskId: "t1" }),
      aAgain: diff("a.ts", 1, 0, 1400, { taskId: "t1" }),
      b: diff("b.ts", 1, 0, 1200, { taskId: "t1" }),
    },
    TURN,
  );
  // a second edit to a.ts must not promote it past b/c — the list only appends
  assert.deepEqual(
    changes.files.map((file) => file.path),
    ["a.ts", "b.ts", "c.ts"],
  );
});

test("an approximate edit is reported as approximate, per file and in total", () => {
  const changes = turnChanges(
    {
      exact: diff("a.ts", 3, 1, 1100, { taskId: "t1" }),
      rewrite: diff("b.ts", 4000, 3800, 1200, { taskId: "t1", approx: true }),
    },
    TURN,
  );
  assert.equal(changes.files.find((f) => f.path === "a.ts")?.approx, undefined);
  assert.equal(changes.files.find((f) => f.path === "b.ts")?.approx, true);
  assert.equal(changes.approx, true);
});

test("an edit exactly on the boundary belongs to the turn it opened", () => {
  const changes = turnChanges(
    { edge: diff("a.ts", 1, 0, TURN.startedAt, { taskId: "t1" }) },
    TURN,
  );
  assert.equal(changes.files.length, 1);
});

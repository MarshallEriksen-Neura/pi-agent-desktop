import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  diffStat,
  diffStatFromArgs,
  diffStatFromResult,
} from "../../src/lib/pi/diff-stat";

test("reads exact line metrics from hash-line replace results", () => {
  assert.deepEqual(
    diffStatFromResult({
      content: [{ type: "text", text: "Successfully replaced" }],
      details: {
        metrics: {
          classification: "applied",
          added_lines: 12,
          removed_lines: 3,
        },
      },
    }),
    { added: 12, removed: 3 },
  );
});

test("accepts camel-case metrics but rejects partial or invalid pairs", () => {
  assert.deepEqual(
    diffStatFromResult({ details: { metrics: { addedLines: 4, removedLines: 0 } } }),
    { added: 4, removed: 0 },
  );
  assert.deepEqual(
    diffStatFromResult({ details: { metrics: { added_lines: 0, removed_lines: 0 } } }),
    { added: 0, removed: 0 },
  );
  assert.equal(
    diffStatFromResult({ details: { metrics: { added_lines: 4 } } }),
    undefined,
  );
  assert.equal(
    diffStatFromResult({ details: { metrics: { added_lines: -1, removed_lines: 2 } } }),
    undefined,
  );
  assert.equal(
    diffStatFromResult({ details: { metrics: { added_lines: 1.5, removed_lines: 2 } } }),
    undefined,
  );
});

test("reads insert and undo_last_change metrics, the shape replace already reports", () => {
  // captured from a real `insert` call (pi-hashline-edit-pro 2.8.3): one line
  // added after an anchor, which the editor accounts for as a rewrite of the
  // anchor line — hence a removal git does not report
  assert.deepEqual(
    diffStatFromResult({
      content: [{ type: "text", text: "Inserted 1 line" }],
      details: {
        diff: " ...\n Nd4│- **Code editor** — CodeMirror 6\n+37C│- **Visible task progress**\n ...",
        firstChangedLine: 41,
        metrics: {
          classification: "applied",
          added_lines: 1,
          removed_lines: 1,
        },
        diffLineNumbers: [null, 40, 41, 42, null],
      },
    }),
    { added: 1, removed: 1 },
  );
  // undo reports the restore, so the edit it reverses has its counts swapped
  assert.deepEqual(
    diffStatFromResult({
      details: { metrics: { classification: "applied", added_lines: 3, removed_lines: 12 } },
    }),
    { added: 3, removed: 12 },
  );
});

test("an insert's anchor arguments imply nothing countable on their own", () => {
  // `lines` is the payload, but the insertion point is a content hash, so where
  // those lines land is unknowable from the arguments. Returning undefined keeps
  // the badge on the two sources that do know — the tool's own metrics above,
  // and the disk read-back — rather than inventing an offset.
  assert.equal(
    diffStatFromArgs(
      { path: "README.md", anchor: "Nd4", direction: "after", lines: ["- inserted"] },
      "a\nb\n",
    ),
    undefined,
  );
  // …and `undo_last_change` carries only a path, which says nothing at all
  assert.equal(diffStatFromArgs({ path: "README.md" }, "a\nb\n"), undefined);
});

test("keeps native edit arguments and disk text as fallback sources", () => {
  assert.deepEqual(
    diffStatFromArgs({
      path: "src/example.ts",
      edits: [{ oldText: "const old = true;", newText: "const next = true;\nconst added = true;" }],
    }, undefined),
    { added: 2, removed: 1 },
  );
  assert.deepEqual(diffStat("a\nb\n", "a\nc\nd\n"), { added: 2, removed: 1 });
});

test("publishes result metrics and patches before workspace snapshot work", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/lib/pi/agent-bridge.ts"),
    "utf8",
  );
  const branchStart = source.indexOf(
    'if (rec.kind === "edit" && rec.path && !e.isError)',
  );
  const branchEnd = source.indexOf('if (rec.kind === "bash")', branchStart + 1);
  const branch = source.slice(
    branchStart,
    branchEnd === -1 ? source.length : branchEnd,
  );

  const statParseAt = branch.indexOf("diffStatFromResult(e.result)");
  const statRecordAt = branch.indexOf("useDiffStats.getState().record");
  const bodyParseAt = branch.indexOf("diffBodyFromResult(e.result)");
  const bodyRecordAt = branch.indexOf("useFileDiffs.getState().record");
  const snapshotAt = branch.indexOf("await rec.snapshot");
  assert.ok(branchStart >= 0, "edit success branch must remain error-gated");
  assert.ok(
    statParseAt >= 0 && statRecordAt > statParseAt,
    "result metrics must be recorded",
  );
  assert.ok(
    bodyParseAt >= 0 && bodyRecordAt > bodyParseAt,
    "result patches must be recorded",
  );
  assert.ok(statRecordAt < snapshotAt, "badge metrics must not wait for workspace IPC");
  assert.ok(bodyRecordAt < snapshotAt, "turn diffs must not wait for workspace IPC");
});

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

test("publishes result metrics before workspace snapshot and reload work", () => {
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

  const parseAt = branch.indexOf("diffStatFromResult(e.result)");
  const recordAt = branch.indexOf("useDiffStats.getState().record");
  const snapshotAt = branch.indexOf("await rec.snapshot");
  assert.ok(branchStart >= 0, "edit success branch must remain error-gated");
  assert.ok(parseAt >= 0 && recordAt > parseAt, "result metrics must be recorded");
  assert.ok(recordAt < snapshotAt, "badge metrics must not wait for workspace IPC");
});

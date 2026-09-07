import assert from "node:assert/strict";
import test from "node:test";
import { parseRepositoryDiff } from "../../src/lib/repository";

test("parses a Git unified patch into the shared diff renderer model", () => {
  const diff = parseRepositoryDiff("src/example.ts", [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -2,3 +2,4 @@",
    " keep",
    "-before",
    "+after",
    "+added",
    " tail",
    "",
  ].join("\n"));

  assert.equal(diff.path, "src/example.ts");
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks.length, 1);
  assert.deepEqual(diff.hunks[0]?.lines, [
    { kind: " ", text: "keep", oldLine: 2, newLine: 2 },
    { kind: "-", text: "before", oldLine: 3 },
    { kind: "+", text: "after", newLine: 3 },
    { kind: "+", text: "added", newLine: 4 },
    { kind: " ", text: "tail", oldLine: 4, newLine: 5 },
  ]);
});

test("preserves backend truncation and computes gaps between Git hunks", () => {
  const diff = parseRepositoryDiff("notes.txt", [
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "@@ -10,1 +10,1 @@",
    "-later",
    "+latest",
  ].join("\n"), true);

  assert.equal(diff.truncated, true);
  assert.equal(diff.hunks[0]?.gap, 0);
  assert.equal(diff.hunks[1]?.gap, 8);
});

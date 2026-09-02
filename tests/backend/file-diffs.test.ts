import assert from "node:assert/strict";
import test from "node:test";
import { diffStat } from "../../src/lib/pi/diff-stat";
import { buildDiff, diffBodyFromResult, useFileDiffs } from "../../src/lib/pi/file-diffs";

/** compact rendering of a hunk, for readable assertions */
function render(lines: { kind: string; text: string }[]): string[] {
  return lines.map((l) => `${l.kind}${l.text}`);
}

test("builds one hunk with both line numbers for a single replacement", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\n";
  const after = "a\nb\nc\nD\ne\nf\ng\n";
  const body = buildDiff(before, after);

  assert.equal(body.hunks.length, 1);
  assert.equal(body.added, 1);
  assert.equal(body.removed, 1);
  assert.equal(body.approx, undefined);
  assert.equal(body.truncated, undefined);

  const [hunk] = body.hunks;
  assert.equal(hunk.oldStart, 1);
  assert.equal(hunk.newStart, 1);
  assert.equal(hunk.gap, 0);
  assert.deepEqual(render(hunk.lines), [" a", " b", " c", "-d", "+D", " e", " f", " g"]);

  // a removal carries only an old line number, an addition only a new one —
  // the panel's two gutters depend on that being exact
  const removed = hunk.lines.find((l) => l.kind === "-");
  const added = hunk.lines.find((l) => l.kind === "+");
  assert.deepEqual([removed?.oldLine, removed?.newLine], [4, undefined]);
  assert.deepEqual([added?.oldLine, added?.newLine], [undefined, 4]);
});

test("recovers an insert diff from its result patch when the before snapshot races", () => {
  const body = diffBodyFromResult({
    details: {
      patch: [
        "--- README.md",
        "+++ README.md",
        "@@ -40,3 +40,4 @@",
        " - **Code editor**",
        " - **Visible task progress**",
        "+  - Turn summaries report changed line counts.",
        " - **Local-first persistence**",
        "",
      ].join("\n"),
      // Hash-line metrics count the anchor as rewritten; the patch records the
      // actual file delta, which is what the turn summary promises to report.
      metrics: { added_lines: 1, removed_lines: 1 },
    },
  });

  assert.ok(body);
  assert.deepEqual([body.added, body.removed], [1, 0]);
  assert.equal(body.hunks.length, 1);
  assert.deepEqual([body.hunks[0].oldStart, body.hunks[0].newStart, body.hunks[0].gap], [40, 40, 39]);
  assert.deepEqual(render(body.hunks[0].lines), [
    " - **Code editor**",
    " - **Visible task progress**",
    "+  - Turn summaries report changed line counts.",
    " - **Local-first persistence**",
  ]);
  assert.deepEqual(
    body.hunks[0].lines.map((line) => [line.oldLine, line.newLine]),
    [
      [40, 40],
      [41, 41],
      [undefined, 42],
      [42, 43],
    ],
  );
});

test("rejects incomplete result patches instead of publishing false totals", () => {
  assert.equal(
    diffBodyFromResult({
      details: { patch: "--- a\n+++ a\n@@ -1,2 +1,2 @@\n-old\n+new\n" },
    }),
    undefined,
  );
});
test("agrees with the badge's own +/- accounting", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const after = before.replace("line 5", "line five").replace("line 30\n", "");
  assert.deepEqual(
    { added: buildDiff(before, after).added, removed: buildDiff(before, after).removed },
    diffStat(before, after),
  );
});

test("splits distant changes and reports the skipped run between them", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `l${i}`);
  const before = lines.join("\n") + "\n";
  const after = lines.map((l, i) => (i === 2 || i === 50 ? `${l}!` : l)).join("\n") + "\n";
  const body = buildDiff(before, after);

  assert.equal(body.hunks.length, 2);
  // first hunk covers lines 1..6 (change at 3 plus three lines of context)
  assert.equal(body.hunks[0].oldStart, 1);
  assert.equal(body.hunks[0].gap, 0);
  // the second starts three lines above line 51 and reports everything skipped
  assert.equal(body.hunks[1].oldStart, 48);
  assert.equal(body.hunks[1].gap, 41);
});

test("merges changes that would print overlapping context", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const before = lines.join("\n") + "\n";
  // four lines apart — closer than 2×context, so one hunk, not two
  const after = lines.map((l, i) => (i === 5 || i === 9 ? `${l}!` : l)).join("\n") + "\n";
  const body = buildDiff(before, after);

  assert.equal(body.hunks.length, 1);
  assert.equal(body.hunks[0].lines.filter((l) => l.kind === "+").length, 2);
  assert.equal(body.hunks[0].lines.filter((l) => l.kind === "-").length, 2);
});

test("treats a created file as all additions, with no phantom removal", () => {
  const body = buildDiff("", "one\ntwo\n");
  assert.deepEqual({ added: body.added, removed: body.removed }, { added: 2, removed: 0 });
  assert.deepEqual(render(body.hunks[0].lines), ["+one", "+two"]);
  assert.equal(body.hunks[0].newStart, 1);
});

test("returns nothing to render when the text is unchanged", () => {
  assert.deepEqual(buildDiff("same\n", "same\n"), { hunks: [], added: 0, removed: 0 });
});

test("cuts a rewrite to the render budget while keeping the totals exact", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n") + "\n";
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n") + "\n";
  const body = buildDiff(before, after);

  assert.equal(body.approx, true);
  assert.equal(body.truncated, true);
  // totals describe the whole change, not the visible window
  assert.deepEqual({ added: body.added, removed: body.removed }, { added: 3000, removed: 3000 });
  const shown = body.hunks.reduce((n, h) => n + h.lines.length, 0);
  assert.equal(shown, 400);
  assert.ok(shown > 0);
});

test("keeps recent diffs and evicts the oldest past the retention cap", () => {
  const { record } = useFileDiffs.getState();
  const body = buildDiff("a\n", "b\n");

  for (let i = 0; i < 205; i++) record(`call-${i}`, `src/f${i}.ts`, body);

  const { diffs, order } = useFileDiffs.getState();
  assert.equal(order.length, 200);
  assert.equal(diffs["call-0"], undefined, "oldest entry should have been evicted");
  assert.equal(diffs["call-204"]?.path, "src/f204.ts");
  assert.ok(typeof diffs["call-204"]?.at === "number");
});

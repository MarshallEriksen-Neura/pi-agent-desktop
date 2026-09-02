import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMentionValue,
  fuzzyMatch,
  mentionTokenAt,
  pathLeaf,
  pathParent,
  rankPaths,
  relativeToRoot,
} from "../../src/lib/file-match";

const PATHS = [
  "src/",
  "src/lib/",
  "src/lib/store.ts",
  "src/lib/pi/chat.ts",
  "src/components/ComposerInput.tsx",
  "tests/backend/store.test.ts",
  "README.md",
];

test("every token has to match, so a space narrows instead of restarting", () => {
  assert.deepEqual(rankPaths("lib store", PATHS, 10), ["src/lib/store.ts"]);
  // A token that matches nothing drops the path even though the other one hits.
  assert.deepEqual(rankPaths("lib nope", PATHS, 10), []);
});

test("a slash is a token separator, so typing it keeps the same matches", () => {
  // The path the user is completing contains slashes; splitting on them is what
  // lets `@src/lib/st` still be three tokens rather than one literal string.
  assert.deepEqual(rankPaths("lib/store", PATHS, 10), ["src/lib/store.ts"]);
});

test("ranks a word-boundary match above one buried mid-word", () => {
  const ranked = rankPaths("store", PATHS, 10);
  assert.equal(ranked[0], "src/lib/store.ts");
  assert.ok(ranked.includes("tests/backend/store.test.ts"));
});

test("an exact match outranks everything", () => {
  const ranked = rankPaths("README.md", PATHS, 10);
  assert.equal(ranked[0], "README.md");
});

test("a subsequence matches but scores worse than the run", () => {
  const spread = fuzzyMatch("cmp", "src/components/ComposerInput.tsx");
  const run = fuzzyMatch("com", "src/components/ComposerInput.tsx");
  assert.equal(spread.matches, true);
  assert.equal(run.matches, true);
  assert.ok(run.score < spread.score);
});

test("a query longer than the text cannot match", () => {
  assert.equal(fuzzyMatch("aaaaaa", "aaa").matches, false);
});

test("an empty query keeps the list, capped", () => {
  assert.equal(rankPaths("", PATHS, 3).length, 3);
});

test("the token is the one under the caret, not the whole draft", () => {
  const draft = "please read @src/lib and stop";
  const caret = "please read @src/lib".length;
  assert.deepEqual(mentionTokenAt(draft, caret), {
    start: 12,
    end: caret,
    query: "src/lib",
    quoted: false,
  });
});

test("a mention still opens when the caret is mid-draft", () => {
  // Completing from the caret and not the end of the word: text to the right of the
  // cursor is not part of what the user is typing.
  const draft = "@src trailing words";
  assert.equal(mentionTokenAt(draft, 4)?.query, "src");
});

test("an email address is not a mention", () => {
  assert.equal(mentionTokenAt("mail me at a@b.com", 18), null);
});

test("no token when the caret sits outside one", () => {
  assert.equal(mentionTokenAt("@src/lib done", 13), null);
  assert.equal(mentionTokenAt("plain words", 11), null);
});

test("a quoted mention survives the space inside it", () => {
  // The delimiter scan alone would cut at the space and complete against `dir`.
  const draft = 'read @"src/my dir/fi';
  const token = mentionTokenAt(draft, draft.length);
  assert.equal(token?.query, "src/my dir/fi");
  assert.equal(token?.quoted, true);
  assert.equal(token?.start, 5);
});

test("a closed quote ends the mention", () => {
  const draft = 'read @"src/my dir/file.ts"';
  assert.equal(mentionTokenAt(draft, draft.length), null);
});

test("a quote that does not follow @ is not a mention", () => {
  assert.equal(mentionTokenAt('say "hello wor', 14), null);
});

test("quotes appear only when the path needs them", () => {
  assert.equal(buildMentionValue("src/lib/store.ts", { quoted: false, open: false }), "@src/lib/store.ts");
  assert.equal(buildMentionValue("src/my dir/a.ts", { quoted: false, open: false }), '@"src/my dir/a.ts"');
  // Already inside quotes: keep them even without a space, or the closing quote the
  // user already typed would be orphaned.
  assert.equal(buildMentionValue("src/a.ts", { quoted: true, open: false }), '@"src/a.ts"');
});

test("a directory completion is left open so the user can keep drilling", () => {
  assert.equal(buildMentionValue("src/my dir/", { quoted: true, open: true }), '@"src/my dir/');
  assert.equal(buildMentionValue("src/lib/", { quoted: false, open: true }), "@src/lib/");
});

test("paths are made relative to the project root", () => {
  assert.equal(relativeToRoot("d:/repo/src/a.ts", "d:/repo"), "src/a.ts");
  assert.equal(relativeToRoot("d:/repo/src/a.ts", "d:/repo/"), "src/a.ts");
  assert.equal(relativeToRoot("d:\\repo\\src\\a.ts", "d:/repo"), "src/a.ts");
});

test("a path outside the root is left alone rather than mangled", () => {
  // Better to mention an absolute path pi can still resolve than a relative one
  // pointing somewhere else entirely.
  assert.equal(relativeToRoot("d:/other/a.ts", "d:/repo"), "d:/other/a.ts");
  assert.equal(relativeToRoot("d:/repo-2/a.ts", "d:/repo"), "d:/repo-2/a.ts");
  assert.equal(relativeToRoot("src/a.ts", null), "src/a.ts");
});

test("a row shows its own name plus the directory that disambiguates it", () => {
  assert.equal(pathLeaf("src/lib/store.ts"), "store.ts");
  assert.equal(pathParent("src/lib/store.ts"), "src/lib");
  assert.equal(pathLeaf("src/lib/"), "lib");
  assert.equal(pathParent("src/lib/"), "src");
  assert.equal(pathParent("README.md"), "");
});

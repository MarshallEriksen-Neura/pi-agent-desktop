import assert from "node:assert/strict";
import test from "node:test";
import {
  LONG_TEXT_CHARACTER_THRESHOLD,
  LONG_TEXT_LINE_THRESHOLD,
  composeLongTextPrompt,
  isLongText,
  longTextPreview,
  longTextStats,
} from "../../src/lib/long-text";

test("long text is detected at the character threshold", () => {
  assert.equal(isLongText("a".repeat(LONG_TEXT_CHARACTER_THRESHOLD - 1)), false);
  assert.equal(isLongText("a".repeat(LONG_TEXT_CHARACTER_THRESHOLD)), true);
});

test("many short lines also qualify as long text", () => {
  const below = Array.from({ length: LONG_TEXT_LINE_THRESHOLD - 1 }, () => "x").join("\n");
  const atThreshold = Array.from({ length: LONG_TEXT_LINE_THRESHOLD }, () => "x").join("\n");
  assert.equal(isLongText(below), false);
  assert.equal(isLongText(atThreshold), true);
});

test("stats count Unicode code points and normalize Windows line endings", () => {
  assert.deepEqual(longTextStats("A😀\r\nB"), { characters: 4, lines: 2 });
  assert.deepEqual(longTextStats(""), { characters: 0, lines: 0 });
});

test("prompt composition preserves the complete document and appends the short instruction", () => {
  const document = "  source text\nwith trailing space  ";
  assert.equal(
    composeLongTextPrompt(document, "  summarize the risks  "),
    `${document}\n\nsummarize the risks`
  );
  assert.equal(composeLongTextPrompt(document, ""), document);
  assert.equal(composeLongTextPrompt(null, "  hello  "), "hello");
});

test("preview collapses whitespace without changing the stored source", () => {
  const source = "first\n\n  second    third";
  assert.equal(longTextPreview(source), "first second third");
  assert.equal(longTextPreview(source, 10), "first seco…");
  assert.equal(source, "first\n\n  second    third");
});

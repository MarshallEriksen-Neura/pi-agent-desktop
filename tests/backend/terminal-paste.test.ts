import assert from "node:assert/strict";
import test from "node:test";
import {
  printableOnly,
  splitPastedLines,
} from "../../src/lib/terminal-paste";
import { isClearCommand } from "../../src/lib/terminal-builtins";

/*
 * The terminal's copy/paste regression lived here: both views received a paste as
 * one multi-character string and had only single-keystroke handling for it. The
 * cases below are the ones that were silently wrong — a multi-line paste running
 * as one welded command, and an unterminated tail being treated as committed.
 */

test("splitPastedLines: single line is all tail, nothing to run", () => {
  assert.deepEqual(splitPastedLines("echo hi"), { lines: [], tail: "echo hi" });
});

test("splitPastedLines: empty input commits nothing", () => {
  assert.deepEqual(splitPastedLines(""), { lines: [], tail: "" });
});

test("splitPastedLines: two lines without a trailing newline leaves the second editable", () => {
  // The regression: this ran as `cd fooecho bar` in block mode, and echoed a
  // literal CR into the line buffer in classic mode.
  assert.deepEqual(splitPastedLines("cd foo\necho bar"), {
    lines: ["cd foo"],
    tail: "echo bar",
  });
});

test("splitPastedLines: a trailing newline commits every line", () => {
  assert.deepEqual(splitPastedLines("cd foo\necho bar\n"), {
    lines: ["cd foo", "echo bar"],
    tail: "",
  });
});

test("splitPastedLines: accepts CRLF, bare CR and LF alike", () => {
  // xterm folds newlines to CR before onData; clipboardData does not fold at
  // all, so one implementation has to read all three.
  const expected = { lines: ["a", "b"], tail: "c" };
  assert.deepEqual(splitPastedLines("a\r\nb\r\nc"), expected);
  assert.deepEqual(splitPastedLines("a\rb\rc"), expected);
  assert.deepEqual(splitPastedLines("a\nb\nc"), expected);
});

test("splitPastedLines: keeps blank lines so line count is preserved", () => {
  assert.deepEqual(splitPastedLines("a\n\nb\n"), {
    lines: ["a", "", "b"],
    tail: "",
  });
});

test("splitPastedLines: a leading newline submits the line already in the buffer", () => {
  // Previously dropped entirely: "\rcmd" failed the `data >= " "` test, so the
  // whole paste vanished.
  assert.deepEqual(splitPastedLines("\ncmd"), { lines: [""], tail: "cmd" });
});

test("isClearCommand: matches the clear builtins, ignoring surrounding space", () => {
  // Intercepted client-side because every command is a separate captured-output
  // RPC, so the real `clear` has no terminal to act on.
  for (const cmd of ["clear", "cls", "  clear  ", "\tcls\t"]) {
    assert.equal(isClearCommand(cmd), true, cmd);
  }
});

test("isClearCommand: does not swallow commands that merely start with clear", () => {
  for (const cmd of [
    "clear-cache",
    "clear && ls",
    "npm run clear",
    "echo clear",
    "clearx",
    "",
  ]) {
    assert.equal(isClearCommand(cmd), false, cmd);
  }
});

test("printableOnly: keeps tab and ordinary text", () => {
  assert.equal(printableOnly("git\tstatus"), "git\tstatus");
  assert.equal(printableOnly("echo 'héllo 世界 🎉'"), "echo 'héllo 世界 🎉'");
});

test("printableOnly: strips escape sequences and NUL", () => {
  // An arrow key's bytes must never reach the buffer as the text "[A".
  assert.equal(printableOnly("\x1b[Aecho"), "[Aecho");
  assert.equal(printableOnly("a\x00b\x7fc"), "abc");
});

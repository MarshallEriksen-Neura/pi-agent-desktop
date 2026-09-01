import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDroppedPaths,
  isDropInside,
  quotePathForShell,
  toWslPath,
} from "../../src/lib/terminal-drop";

/*
 * Drag-and-drop into the terminal has no DOM event to lean on: the OS hands the
 * drop to the window, with a physical pixel position and raw OS paths. Every
 * case below is one of the three ways that goes wrong — a hit test done in the
 * wrong unit, a path pasted into a shell that cannot see that filesystem, and a
 * path with a space arriving as two arguments.
 */

const RECT = { left: 100, top: 200, right: 300, bottom: 400 };

test("isDropInside: physical position is scaled to CSS pixels first", () => {
  // The same drop, reported on a 2x display, is outside the box if the ratio is
  // not divided out — this was the whole bug class this helper exists for.
  assert.equal(isDropInside({ x: 400, y: 600 }, RECT, 2), true);
  assert.equal(isDropInside({ x: 400, y: 600 }, RECT, 1), false);
});

test("isDropInside: edges count, beyond them does not", () => {
  assert.equal(isDropInside({ x: 100, y: 200 }, RECT), true);
  assert.equal(isDropInside({ x: 300, y: 400 }, RECT), true);
  assert.equal(isDropInside({ x: 99, y: 300 }, RECT), false);
  assert.equal(isDropInside({ x: 200, y: 401 }, RECT), false);
});

test("isDropInside: a nonsense ratio falls back to 1 instead of dividing by zero", () => {
  assert.equal(isDropInside({ x: 200, y: 300 }, RECT, 0), true);
});

test("quotePathForShell: ordinary paths are left alone", () => {
  assert.equal(quotePathForShell("D:\\src\\pi\\main.ts"), "D:\\src\\pi\\main.ts");
  assert.equal(quotePathForShell("/home/me/notes.md"), "/home/me/notes.md");
});

test("quotePathForShell: a space gets double quotes, readable by both shell families", () => {
  assert.equal(
    quotePathForShell("D:\\my files\\a b.txt"),
    '"D:\\my files\\a b.txt"'
  );
});

test("quotePathForShell: expansion characters force POSIX single quotes", () => {
  assert.equal(quotePathForShell("/tmp/$HOME test"), "'/tmp/$HOME test'");
  assert.equal(quotePathForShell("/tmp/`id`"), "'/tmp/`id`'");
  // An apostrophe alone is literal inside double quotes, so it stays on the
  // portable branch; it only needs escaping once something else forces single
  // quotes.
  assert.equal(quotePathForShell(`/tmp/it's mine`), `"/tmp/it's mine"`);
  assert.equal(quotePathForShell(`/tmp/it's $HOME`), `'/tmp/it'\\''s $HOME'`);
});

test("toWslPath: drive letters become automount paths", () => {
  assert.equal(toWslPath("D:\\src\\pi"), "/mnt/d/src/pi");
  assert.equal(toWslPath("C:\\"), "/mnt/c");
  assert.equal(toWslPath("C:"), "/mnt/c");
});

test("toWslPath: a UNC path inside the running distro loses the prefix", () => {
  assert.equal(toWslPath("\\\\wsl$\\Ubuntu\\home\\me\\a.txt", "Ubuntu"), "/home/me/a.txt");
  assert.equal(
    toWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me", "ubuntu"),
    "/home/me"
  );
});

test("toWslPath: a UNC path from another distro is left untouched", () => {
  // `/home/me` inside Debian is a different file from `/home/me` inside Ubuntu,
  // so there is no honest translation — better an unusable path than a wrong one.
  const path = "\\\\wsl$\\Debian\\home\\me\\a.txt";
  assert.equal(toWslPath(path, "Ubuntu"), path);
});

test("toWslPath: POSIX paths pass through", () => {
  assert.equal(toWslPath("/var/log/pi.log", "Ubuntu"), "/var/log/pi.log");
});

test("formatDroppedPaths: nothing droppable yields nothing to type", () => {
  assert.equal(formatDroppedPaths([]), "");
  assert.equal(formatDroppedPaths(["  "]), "");
});

test("formatDroppedPaths: paths end with a space so a second drop is a second argument", () => {
  assert.equal(formatDroppedPaths(["D:\\a.txt"]), "D:\\a.txt ");
  assert.equal(
    formatDroppedPaths(["D:\\a.txt", "D:\\my files\\b.txt"]),
    'D:\\a.txt "D:\\my files\\b.txt" '
  );
});

test("formatDroppedPaths: a separator is added only when the line needs one", () => {
  assert.equal(formatDroppedPaths(["/a"], { precedingLine: "cat" }), " /a ");
  assert.equal(formatDroppedPaths(["/a"], { precedingLine: "cat " }), "/a ");
  assert.equal(formatDroppedPaths(["/a"], { precedingLine: "" }), "/a ");
  // null means the line is unknown (a remote PTY owns it) — do not guess.
  assert.equal(formatDroppedPaths(["/a"], { precedingLine: null }), "/a ");
});

test("formatDroppedPaths: WSL mode translates, and no mode leaves paths as the OS gave them", () => {
  assert.equal(
    formatDroppedPaths(["D:\\my files\\b.txt"], { wslDistro: "Ubuntu" }),
    '"/mnt/d/my files/b.txt" '
  );
  assert.equal(
    formatDroppedPaths(["D:\\my files\\b.txt"], { wslDistro: null }),
    '"D:\\my files\\b.txt" '
  );
});

test("formatDroppedPaths: never emits a newline, so a drop cannot run a command", () => {
  const text = formatDroppedPaths(["D:\\a.txt", "\\\\wsl$\\Ubuntu\\home\\me"], {
    wslDistro: "Ubuntu",
    precedingLine: "ls",
  });
  assert.equal(/[\r\n]/.test(text), false);
  assert.equal(text, " /mnt/d/a.txt /home/me ");
});

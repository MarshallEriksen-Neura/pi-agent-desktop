import assert from "node:assert/strict";
import test from "node:test";
import {
  SEND_SHORTCUTS,
  formatSendShortcut,
  isSendShortcut,
  matchSendIntent,
  type SendKeyEvent,
  type SendShortcut,
} from "../../src/lib/composer-shortcut";

const key = (over: Partial<SendKeyEvent> = {}): SendKeyEvent => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...over,
});

test("mod-enter: ⌘↩ and Ctrl↩ send, bare ↩ is a newline", () => {
  assert.equal(matchSendIntent(key({ metaKey: true }), "mod-enter"), "send");
  assert.equal(matchSendIntent(key({ ctrlKey: true }), "mod-enter"), "send");
  assert.equal(matchSendIntent(key(), "mod-enter"), null);
  assert.equal(matchSendIntent(key({ shiftKey: true }), "mod-enter"), null);
});

test("enter: bare ↩ sends, ⇧↩ is a newline", () => {
  assert.equal(matchSendIntent(key(), "enter"), "send");
  assert.equal(matchSendIntent(key({ shiftKey: true }), "enter"), null);
});

test("shift-enter: ⇧↩ sends, bare ↩ is a newline", () => {
  assert.equal(matchSendIntent(key({ shiftKey: true }), "shift-enter"), "send");
  assert.equal(matchSendIntent(key(), "shift-enter"), null);
});

test("⌘↩ stays a send under every preference", () => {
  for (const shortcut of SEND_SHORTCUTS) {
    assert.equal(matchSendIntent(key({ metaKey: true }), shortcut), "send", shortcut);
    assert.equal(matchSendIntent(key({ ctrlKey: true }), shortcut), "send", shortcut);
  }
});

test("⌘⇧↩ keeps flipping steer↔queue under every preference", () => {
  for (const shortcut of SEND_SHORTCUTS) {
    assert.equal(
      matchSendIntent(key({ metaKey: true, shiftKey: true }), shortcut),
      "altSend",
      shortcut
    );
  }
});

test("non-Enter keys are never a send", () => {
  for (const shortcut of SEND_SHORTCUTS) {
    for (const k of ["a", "Tab", "Escape", "ArrowUp", " "]) {
      assert.equal(matchSendIntent(key({ key: k, metaKey: true }), shortcut), null);
    }
  }
});

test("hint glyph only varies by platform for the mod combo", () => {
  assert.equal(formatSendShortcut("mod-enter", true), "⌘↩");
  assert.equal(formatSendShortcut("mod-enter", false), "Ctrl↩");
  for (const mac of [true, false]) {
    assert.equal(formatSendShortcut("enter", mac), "↩");
    assert.equal(formatSendShortcut("shift-enter", mac), "⇧↩");
  }
});

test("isSendShortcut rejects stale or foreign storage values", () => {
  for (const shortcut of SEND_SHORTCUTS) assert.ok(isSendShortcut(shortcut));
  for (const bad of ["", "cmd-enter", "Enter", null, undefined, 3, {}]) {
    assert.equal(isSendShortcut(bad), false);
  }
});

test("every preset has a distinct newline key, so text entry stays possible", () => {
  // A preset that sent on both ↩ and ⇧↩ would make multi-line input impossible.
  const newlineable = (shortcut: SendShortcut) =>
    [key(), key({ shiftKey: true })].some(
      (e) => matchSendIntent(e, shortcut) === null
    );
  for (const shortcut of SEND_SHORTCUTS) assert.ok(newlineable(shortcut), shortcut);
});

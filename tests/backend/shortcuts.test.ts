import assert from "node:assert/strict";
import test from "node:test";
import {
  REBINDABLE_IDS,
  SHORTCUT_REGISTRY,
  bindingFromEvent,
  bindingsEqual,
  effectiveBindings,
  findConflict,
  formatBinding,
  formatBindings,
  matchesBinding,
  normalizeBinding,
  normalizeKey,
  parseShortcutOverrides,
  shortcutById,
  type Binding,
  type ShortcutKeyEvent,
} from "../../src/lib/shortcuts";

const ev = (over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

test("normalizeKey folds single characters, leaves named keys alone", () => {
  assert.equal(normalizeKey("C"), "c");
  assert.equal(normalizeKey("k"), "k");
  assert.equal(normalizeKey("ArrowDown"), "ArrowDown");
  assert.equal(normalizeKey("Enter"), "Enter");
});

test("a shifted letter still matches its binding", () => {
  // The hand-rolled check this replaces compared against 'C' literally, so the
  // chord depended on shift twice and missed on layouts reporting lower case.
  const binding: Binding = { key: "c", mod: true, shift: true };
  const mac = ev({ key: "C", metaKey: true, shiftKey: true });
  const win = ev({ key: "C", ctrlKey: true, shiftKey: true });
  assert.equal(matchesBinding(mac, binding, true), true);
  assert.equal(matchesBinding(win, binding, false), true);
});

test("mod is ⌘ on macOS and Ctrl elsewhere", () => {
  const binding: Binding = { key: "k", mod: true };
  assert.equal(matchesBinding(ev({ metaKey: true }), binding, true), true);
  assert.equal(matchesBinding(ev({ ctrlKey: true }), binding, true), false);
  assert.equal(matchesBinding(ev({ ctrlKey: true }), binding, false), true);
  assert.equal(matchesBinding(ev({ metaKey: true }), binding, false), false);
});

test("literal ctrl stays on Ctrl even on macOS", () => {
  const binding: Binding = { key: "l", ctrl: true };
  assert.equal(matchesBinding(ev({ key: "l", ctrlKey: true }), binding, true), true);
  assert.equal(matchesBinding(ev({ key: "l", metaKey: true }), binding, true), false);
  assert.equal(matchesBinding(ev({ key: "l", ctrlKey: true }), binding, false), true);
});

test("modifiers match exactly — ⌘⇧K is not ⌘K", () => {
  const binding: Binding = { key: "k", mod: true };
  assert.equal(matchesBinding(ev({ metaKey: true, shiftKey: true }), binding, true), false);
  assert.equal(matchesBinding(ev({ metaKey: true, altKey: true }), binding, true), false);
});

test("Shift is ignored for punctuation, where it is how the key is typed", () => {
  // AZERTY produces `/` with Shift held; the event already reports `/`, so
  // comparing the flag would leave ⌘/ dead on that layout.
  const binding: Binding = { key: "/", mod: true };
  assert.equal(matchesBinding(ev({ key: "/", metaKey: true }), binding, true), true);
  assert.equal(
    matchesBinding(ev({ key: "/", metaKey: true, shiftKey: true }), binding, true),
    true
  );
  // ...and Shift is dropped from a captured punctuation chord, so the stored
  // binding cannot disagree with the matcher.
  assert.equal(normalizeBinding({ key: "/", mod: true, shift: true }).shift, undefined);
  assert.equal(normalizeBinding({ key: "k", mod: true, shift: true }).shift, true);
});

test("bindingsEqual collapses mod and ctrl off macOS only", () => {
  const mod: Binding = { key: "l", mod: true };
  const ctrl: Binding = { key: "l", ctrl: true };
  assert.equal(bindingsEqual(mod, ctrl, false), true, "same Ctrl key on Windows");
  assert.equal(bindingsEqual(mod, ctrl, true), false, "⌘L and ⌃L differ on macOS");
});

test("formatBinding follows each platform's convention", () => {
  // macOS orders modifiers ⌃⌥⇧⌘, with Command nearest the key — the order Apple's
  // own menus use. Windows and Linux lead with Ctrl instead.
  assert.equal(formatBinding({ key: "c", mod: true, shift: true }, true), "⇧⌘C");
  assert.equal(formatBinding({ key: "c", mod: true, shift: true }, false), "Ctrl+Shift+C");
  assert.equal(formatBinding({ key: "ArrowDown", alt: true }, true), "⌥↓");
  assert.equal(formatBinding({ key: "l", ctrl: true }, true), "⌃L");
  assert.equal(formatBinding({ key: "Escape" }, false), "Esc");
  assert.equal(
    formatBindings([{ key: "ArrowDown", alt: true }, { key: "ArrowUp", alt: true }], true),
    "⌥↓ · ⌥↑"
  );
});

test("capture requires a command modifier or Alt", () => {
  assert.equal(bindingFromEvent(ev({ key: "k" }), true), null, "bare letter");
  assert.equal(bindingFromEvent(ev({ key: "k", shiftKey: true }), true), null, "⇧K is K");
  assert.equal(bindingFromEvent(ev({ key: "Meta", metaKey: true }), true), null, "bare modifier");
  assert.deepEqual(bindingFromEvent(ev({ key: "k", metaKey: true }), true), {
    key: "k",
    mod: true,
  });
  assert.deepEqual(bindingFromEvent(ev({ key: "ArrowDown", altKey: true }), true), {
    key: "ArrowDown",
    alt: true,
  });
});

test("a captured Ctrl off macOS is stored as the portable mod flag", () => {
  assert.deepEqual(bindingFromEvent(ev({ key: "k", ctrlKey: true }), false), {
    key: "k",
    mod: true,
  });
});

test("conflict detection spans fixed commands and overlapping scopes", () => {
  // ⌘S belongs to the editor, but a global chord is live over it.
  const clash = findConflict("commandPalette", { key: "s", mod: true }, {}, true);
  assert.equal(clash?.id, "editorSave");
  // The registry's own defaults are found too.
  assert.equal(findConflict("commandPalette", { key: "j", mod: true }, {}, true)?.id, "toggleTerminal");
  // Free chord.
  assert.equal(findConflict("commandPalette", { key: "y", mod: true, alt: true }, {}, true), null);
});

test("chat and terminal both keep ⌘⇧C — only one can have focus", () => {
  const chat = shortcutById("copyLastReply");
  const terminal = shortcutById("terminalCopy");
  assert.ok(chat && terminal);
  assert.equal(
    terminal.defaults.some((b) => bindingsEqual(b, chat.defaults[0], true)),
    true,
    "the two ship the same chord"
  );
  assert.equal(findConflict("copyLastReply", { key: "c", mod: true, shift: true }, {}, true), null);
});

test("an override moves the chord and is what conflict detection sees", () => {
  const overrides = { commandPalette: { key: "p", mod: true, shift: true } };
  const command = shortcutById("commandPalette");
  assert.ok(command);
  assert.deepEqual(effectiveBindings(command, overrides), [overrides.commandPalette]);
  // ⌘K is free once the palette has moved off it...
  assert.equal(findConflict("zenMode", { key: "k", mod: true }, overrides, true), null);
  // ...and the palette's new chord is now the occupied one.
  assert.equal(
    findConflict("zenMode", { key: "p", mod: true, shift: true }, overrides, true)?.id,
    "commandPalette"
  );
});

test("stored overrides are validated, not trusted", () => {
  assert.deepEqual(parseShortcutOverrides(null), {});
  assert.deepEqual(parseShortcutOverrides("not json"), {});
  assert.deepEqual(parseShortcutOverrides("[]"), {});
  assert.deepEqual(parseShortcutOverrides('{"commandPalette":{"key":42}}'), {});
  // a command that no longer exists, and one that is fixed
  assert.deepEqual(parseShortcutOverrides('{"goneCommand":{"key":"k","mod":true}}'), {});
  assert.deepEqual(parseShortcutOverrides('{"editorSave":{"key":"q","mod":true}}'), {});
  assert.deepEqual(parseShortcutOverrides('{"commandPalette":{"key":"P","mod":true}}'), {
    commandPalette: { key: "p", mod: true },
  });
});

test("registry ids are unique and rebindable commands ship exactly one chord", () => {
  const ids = SHORTCUT_REGISTRY.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const command of SHORTCUT_REGISTRY) {
    assert.ok(command.defaults.length > 0, `${command.id} has no chord`);
    if (command.rebindable) {
      assert.equal(command.defaults.length, 1, `${command.id} is rebindable`);
    } else {
      assert.ok(command.reason, `${command.id} is fixed without a reason`);
    }
  }
  assert.equal(REBINDABLE_IDS.length, 7);
});

test("no two rebindable defaults collide out of the box", () => {
  for (const mac of [true, false]) {
    for (const id of REBINDABLE_IDS) {
      const command = shortcutById(id);
      assert.ok(command);
      const clash = findConflict(id, command.defaults[0], {}, mac);
      assert.equal(clash, null, `${id} collides with ${clash?.id} (mac=${mac})`);
    }
  }
});

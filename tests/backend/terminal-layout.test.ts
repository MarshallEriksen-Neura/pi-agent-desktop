import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_HEIGHT_DEFAULT,
  TERMINAL_HEIGHT_MIN,
  availableTerminalHeight,
  clampTerminalHeightPreference,
  terminalHeightBounds,
} from "../../src/lib/terminal-layout";

test("terminal resize can use the full workspace height", () => {
  assert.equal(availableTerminalHeight(1080, 48), 1032);
  assert.deepEqual(terminalHeightBounds(1032), {
    min: TERMINAL_HEIGHT_MIN,
    max: 1032,
  });
});

test("terminal resize keeps a usable minimum in a short workspace", () => {
  assert.deepEqual(terminalHeightBounds(80), {
    min: TERMINAL_HEIGHT_MIN,
    max: TERMINAL_HEIGHT_MIN,
  });
  assert.deepEqual(terminalHeightBounds(0), {
    min: TERMINAL_HEIGHT_MIN,
    max: TERMINAL_HEIGHT_DEFAULT,
  });
});

test("saved terminal height is not capped to a medium-sized window", () => {
  assert.equal(clampTerminalHeightPreference(1600), 1600);
  assert.equal(clampTerminalHeightPreference(80), TERMINAL_HEIGHT_MIN);
});

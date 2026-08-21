import assert from "node:assert/strict";
import test from "node:test";
import {
  isModelEnabled,
  modelRef,
  pruneModelsFromScope,
  toggleModelEnabled,
} from "../../src/lib/pi/model-scope";

const ALL = [
  { provider: "openai", id: "gpt-4o" },
  { provider: "proxy", id: "gpt-4o" },
  { provider: "azure", id: "gpt-4o" },
  { provider: "openai", id: "o3" },
];

test("prune drops the canonical ref of a removed model", () => {
  const out = pruneModelsFromScope(
    ["openai/gpt-4o", "openai/o3"],
    [{ provider: "openai", id: "gpt-4o" }],
    ALL
  );
  assert.deepEqual(out, ["openai/o3"]);
});

test("prune leaves entries for models that weren't removed", () => {
  const entries = ["openai/o3", "anthropic/claude-opus-5"];
  assert.deepEqual(pruneModelsFromScope(entries, [{ provider: "proxy", id: "gpt-4o" }], ALL), entries);
});

test("prune expands a legacy bare id so surviving providers stay enabled", () => {
  const out = pruneModelsFromScope(["gpt-4o"], [{ provider: "openai", id: "gpt-4o" }], ALL);
  assert.deepEqual(out.sort(), ["azure/gpt-4o", "proxy/gpt-4o"]);
});

test("prune of every provider behind a bare id clears it entirely", () => {
  const out = pruneModelsFromScope(
    ["gpt-4o"],
    [
      { provider: "openai", id: "gpt-4o" },
      { provider: "proxy", id: "gpt-4o" },
      { provider: "azure", id: "gpt-4o" },
    ],
    ALL
  );
  assert.deepEqual(out, []);
});

test("prune is order-independent for a bare id", () => {
  const removed = [
    { provider: "azure", id: "gpt-4o" },
    { provider: "openai", id: "gpt-4o" },
  ];
  const forward = pruneModelsFromScope(["gpt-4o"], removed, ALL);
  const backward = pruneModelsFromScope(["gpt-4o"], [...removed].reverse(), ALL);
  assert.deepEqual(forward, ["proxy/gpt-4o"]);
  assert.deepEqual(backward.sort(), forward.sort());
});

test("prune never enables a model that wasn't in the scope list", () => {
  // toggleModelEnabled adds when absent — prune must not inherit that.
  const out = pruneModelsFromScope([], [{ provider: "openai", id: "gpt-4o" }], ALL);
  assert.deepEqual(out, []);
  const kept = pruneModelsFromScope(["openai/o3"], [{ provider: "openai", id: "gpt-4o" }], ALL);
  assert.deepEqual(kept, ["openai/o3"]);
});

test("prune leaves glob entries to pi", () => {
  const out = pruneModelsFromScope(
    ["gpt-*", "openai/o3"],
    [{ provider: "openai", id: "gpt-4o" }],
    ALL
  );
  assert.deepEqual(out, ["gpt-*", "openai/o3"]);
});

test("prune removes a model id that contains slashes", () => {
  const id = "inclusionai/ling-3.0-flash:free";
  const ref = modelRef("openrouter", id);
  const out = pruneModelsFromScope([ref, "openai/o3"], [{ provider: "openrouter", id }], [
    { provider: "openrouter", id },
  ]);
  assert.deepEqual(out, ["openai/o3"]);
});

test("prune result is no longer reported as enabled", () => {
  const out = pruneModelsFromScope(
    ["openai/gpt-4o", "gpt-4o"],
    [{ provider: "openai", id: "gpt-4o" }],
    ALL
  );
  assert.equal(isModelEnabled(out, "openai", "gpt-4o"), false);
  assert.equal(isModelEnabled(out, "proxy", "gpt-4o"), true);
});

test("toggle still round-trips after a prune", () => {
  const pruned = pruneModelsFromScope(
    ["openai/gpt-4o"],
    [{ provider: "openai", id: "gpt-4o" }],
    ALL
  );
  const back = toggleModelEnabled(pruned, "openai", "gpt-4o", ALL);
  assert.deepEqual(back, ["openai/gpt-4o"]);
});

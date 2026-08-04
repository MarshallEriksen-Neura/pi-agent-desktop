import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertNextRemoteEventSequence,
  assertRemoteTaskTransition,
  canTransitionRemoteTask,
  isRemoteTaskTerminalState,
} from "../../packages/remote-control-contracts/src/index";

test("remote task lifecycle is bounded and terminal states cannot reopen", () => {
  assert.equal(canTransitionRemoteTask("queued", "starting"), true);
  assert.equal(canTransitionRemoteTask("starting", "running"), true);
  assert.equal(canTransitionRemoteTask("running", "succeeded"), true);
  assert.equal(isRemoteTaskTerminalState("succeeded"), true);
  assert.equal(canTransitionRemoteTask("succeeded", "running"), false);
  assert.throws(
    () => assertRemoteTaskTransition("failed", "queued"),
    /Invalid remote task transition/,
  );
});

test("remote event sequence rejects duplicates and regressions", () => {
  assert.equal(assertNextRemoteEventSequence(41, 42), 42);
  assert.throws(() => assertNextRemoteEventSequence(42, 42), /must increase/);
  assert.throws(() => assertNextRemoteEventSequence(42, 12), /must increase/);
});

test("contracts remain isolated from desktop implementation and sensitive DTO fields", () => {
  const root = path.resolve(process.cwd(), "packages", "remote-control-contracts", "src");
  const source = fs
    .readdirSync(root)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");

  for (const forbidden of [
    "@tauri-apps/",
    "zustand",
    "react",
    "sessionPath",
    "PiCommand",
    "Bash",
    "../../src/",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden contract dependency/field: ${forbidden}`);
  }
});

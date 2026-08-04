import assert from "node:assert/strict";
import test from "node:test";

import {
  configureChatRecovery,
  getChatRecoveryTarget,
  resetChatRecoveryForTests,
} from "../../src/lib/orchestration/chat-recovery";

test.afterEach(() => resetChatRecoveryForTests());

test("chat recovery fails closed until an explicit service is configured", () => {
  assert.equal(getChatRecoveryTarget(), null);
});

test("chat recovery reads the latest target without importing stores", () => {
  let resumePath = "session-a.jsonl";
  const service = {
    getTarget: () => ({ cwd: "D:/project", resumePath }),
  };
  configureChatRecovery(service);
  assert.deepEqual(getChatRecoveryTarget(), {
    cwd: "D:/project",
    resumePath: "session-a.jsonl",
  });

  resumePath = "session-b.jsonl";
  assert.equal(getChatRecoveryTarget()?.resumePath, "session-b.jsonl");
  assert.doesNotThrow(() => configureChatRecovery(service));
  assert.throws(
    () => configureChatRecovery({ getTarget: () => ({}) }),
    /already configured/,
  );
});

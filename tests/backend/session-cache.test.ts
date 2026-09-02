import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSessionMessages,
  SessionCacheDecodeError,
} from "../../src/lib/backend/session-cache";

test("distinguishes a valid empty transcript from corrupted cache", () => {
  assert.deepEqual(decodeSessionMessages("[]"), []);
  assert.throws(() => decodeSessionMessages("{"), SessionCacheDecodeError);
  assert.throws(() => decodeSessionMessages("{}"), SessionCacheDecodeError);
});

test("rejects malformed cached messages", () => {
  assert.throws(
    () => decodeSessionMessages(JSON.stringify([{ id: "x", role: "user", text: "missing runtime fields" }])),
    (error: unknown) =>
      error instanceof SessionCacheDecodeError && /invalid message at index 0/.test(error.message)
  );
});

test("accepts the persisted chat projection shape", () => {
  assert.deepEqual(
    decodeSessionMessages(
      JSON.stringify([
        {
          id: "a",
          role: "assistant",
          text: "done",
          thinking: "",
          tools: [{ id: "call", name: "read", args: { path: "x" }, status: "done" }],
          streaming: false,
        },
      ])
    )[0]?.tools?.[0]?.status,
    "done"
  );
});

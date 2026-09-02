import assert from "node:assert/strict";
import test from "node:test";
import {
  activeSessionBranch,
  SessionTranscriptError,
  sessionEntriesToChatMessages,
  type PiEntriesSnapshot,
} from "../../src/lib/pi/session-transcript";

function entry(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
  timestamp = "2026-01-02T03:04:05.000Z"
) {
  return { type: "message", id, parentId, timestamp, message };
}

test("follows leafId through the active branch instead of flattening siblings", () => {
  const snapshot: PiEntriesSnapshot = {
    entries: [
      { type: "session", version: 3, id: "session-id" },
      entry("u1", null, { role: "user", content: "root", timestamp: 1 }),
      entry("old", "u1", { role: "assistant", content: [{ type: "text", text: "old branch" }], timestamp: 2 }),
      entry("new", "u1", { role: "assistant", content: [{ type: "text", text: "active branch" }], timestamp: 3 }),
    ],
    leafId: "new",
  };

  assert.deepEqual(activeSessionBranch(snapshot).map((value) => value.id), ["u1", "new"]);
  assert.deepEqual(sessionEntriesToChatMessages(snapshot).map((value) => value.text), [
    "root",
    "active branch",
  ]);
});

test("keeps original branch messages across compaction and ignores summary metadata", () => {
  const snapshot: PiEntriesSnapshot = {
    entries: [
      entry("u1", null, { role: "user", content: "before", timestamp: 1 }),
      entry("a1", "u1", { role: "assistant", content: "answer", timestamp: 2 }),
      {
        type: "compaction",
        id: "c1",
        parentId: "a1",
        timestamp: "2026-01-02T03:04:06.000Z",
        summary: "summary for model context",
        firstKeptEntryId: "a1",
      },
      {
        type: "branch_summary",
        id: "b1",
        parentId: "c1",
        timestamp: "2026-01-02T03:04:07.000Z",
        summary: "abandoned branch summary",
      },
      entry("u2", "b1", { role: "user", content: "after", timestamp: 3 }),
    ],
    leafId: "u2",
  };

  assert.deepEqual(sessionEntriesToChatMessages(snapshot).map((value) => value.text), [
    "before",
    "answer",
    "after",
  ]);
});

test("maps text, images, thinking and completed/error tool activity", () => {
  const snapshot: PiEntriesSnapshot = {
    entries: [
      entry("u1", null, {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 10,
      }),
      entry("a1", "u1", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "text", text: "working" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "false" } },
        ],
        timestamp: 11,
      }),
      entry("r1", "a1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 12,
      }),
      entry("r2", "r1", {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "bash",
        content: [{ type: "text", text: "failed" }],
        isError: true,
        timestamp: 13,
      }),
    ],
    leafId: "r2",
  };

  const converted = sessionEntriesToChatMessages(snapshot);
  assert.deepEqual(converted[0]?.images, ["data:image/png;base64,abc"]);
  assert.equal(converted[1]?.thinking, "reason");
  assert.deepEqual(converted[1]?.tools?.map(({ id, name, args, status }) => ({ id, name, args, status })), [
    { id: "call-1", name: "read", args: { path: "a.ts" }, status: "done" },
    { id: "call-2", name: "bash", args: { command: "false" }, status: "error" },
  ]);
});

test("rejects a broken active branch instead of presenting an empty conversation", () => {
  assert.throws(
    () => activeSessionBranch({ entries: [], leafId: "missing" }),
    (error: unknown) =>
      error instanceof SessionTranscriptError && /missing entry missing/.test(error.message)
  );
});

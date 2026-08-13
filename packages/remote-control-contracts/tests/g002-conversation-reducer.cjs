const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRemoteConversationReducerState,
  deriveRemoteConversationStatus,
  reduceRemoteConversationState,
} = require("../../../.tmp/remote-control-contracts-g002/index.js");

const capabilities = {
  conversationV2: true,
  piSessionResume: true,
  appendTurns: true,
  cancelTurn: true,
  interactions: true,
  messagePaging: true,
  eventReplay: true,
  maxQueuedTurns: 8,
  maxPromptBytes: 32768,
  maxContextFiles: 16,
  maxPageSize: 100,
};

function snapshot() {
  return {
    version: 2,
    conversationId: "conv_1",
    ownerDeviceId: "device_1",
    projectId: "project_1",
    status: "idle",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    messageCount: 0,
    turnCount: 0,
    queuedTurnCount: 0,
    capabilities,
  };
}

function turnCreated(sequence = 11) {
  return {
    eventId: `event_${sequence}`,
    emittedAt: "2026-08-12T00:00:01.000Z",
    sequence,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "turn.created",
    turn: {
      turnId: "turn_1",
      conversationId: "conv_1",
      requestId: "request_1",
      ownerDeviceId: "device_1",
      state: "queued",
      createdAt: "2026-08-12T00:00:01.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
      userMessageId: "message_1",
    },
  };
}

test("v2 reducer counts entities once and ignores duplicate or regressing sequences", () => {
  const initial = createRemoteConversationReducerState(snapshot(), 10);
  const applied = reduceRemoteConversationState(initial, turnCreated());
  assert.equal(applied.snapshot.turnCount, 1);
  assert.equal(applied.snapshot.queuedTurnCount, 1);
  assert.equal(reduceRemoteConversationState(applied, turnCreated()), applied);
  assert.equal(reduceRemoteConversationState(applied, turnCreated(9)), applied);

  const accepted = reduceRemoteConversationState(applied, {
    eventId: "event_12",
    emittedAt: "2026-08-12T00:00:02.000Z",
    sequence: 12,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "message.accepted",
    message: {
      messageId: "message_1",
      conversationId: "conv_1",
      turnId: "turn_1",
      role: "user",
      status: "accepted",
      text: "Inspect the repository.",
      createdAt: "2026-08-12T00:00:01.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    },
    delivery: {
      deliveryId: "delivery_1",
      conversationId: "conv_1",
      turnId: "turn_1",
      status: "accepted",
      acceptedAt: "2026-08-12T00:00:01.000Z",
    },
  });
  const completed = reduceRemoteConversationState(accepted, {
    eventId: "event_13",
    emittedAt: "2026-08-12T00:00:03.000Z",
    sequence: 13,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "message.completed",
    message: {
      ...accepted.snapshot.latestMessage,
      status: "completed",
      text: "Inspect the repository.",
      updatedAt: "2026-08-12T00:00:03.000Z",
      completedAt: "2026-08-12T00:00:03.000Z",
    },
  });
  assert.equal(completed.snapshot.messageCount, 1);
});

test("message deltas build one streaming assistant message and completed replaces it", () => {
  const initial = createRemoteConversationReducerState(snapshot(), 0);
  const first = reduceRemoteConversationState(initial, {
    eventId: "event_1",
    emittedAt: "2026-08-12T00:00:01.000Z",
    sequence: 1,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "message.delta",
    turnId: "turn_1",
    messageId: "assistant_1",
    delta: "先看一下",
  });
  const second = reduceRemoteConversationState(first, {
    eventId: "event_2",
    emittedAt: "2026-08-12T00:00:02.000Z",
    sequence: 2,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "message.delta",
    turnId: "turn_1",
    messageId: "assistant_1",
    delta: "实现。",
  });
  assert.equal(second.snapshot.messageCount, 1);
  assert.equal(second.snapshot.latestMessage.status, "streaming");
  assert.equal(second.snapshot.latestMessage.text, "先看一下实现。");

  const completed = reduceRemoteConversationState(second, {
    eventId: "event_3",
    emittedAt: "2026-08-12T00:00:03.000Z",
    sequence: 3,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "message.completed",
    message: {
      ...second.snapshot.latestMessage,
      status: "completed",
      text: "先看一下实现。",
      completedAt: "2026-08-12T00:00:03.000Z",
      updatedAt: "2026-08-12T00:00:03.000Z",
    },
  });
  assert.equal(completed.snapshot.messageCount, 1);
  assert.equal(completed.snapshot.latestMessage.status, "completed");

  const lateDelta = reduceRemoteConversationState(completed, {
    eventId: "event_4",
    emittedAt: "2026-08-12T00:00:04.000Z",
    sequence: 4,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "message.delta",
    turnId: "turn_1",
    messageId: "assistant_1",
    delta: " late",
  });
  assert.equal(lateDelta.snapshot.latestMessage.status, "completed");
  assert.equal(lateDelta.snapshot.latestMessage.text, "先看一下实现。");
});

test("snapshot_required freezes deltas until an authoritative snapshot replaces state", () => {
  const initial = createRemoteConversationReducerState(snapshot(), 20);
  const required = reduceRemoteConversationState(initial, {
    eventId: "event_21",
    emittedAt: "2026-08-12T00:00:04.000Z",
    sequence: 21,
    deviceId: "device_1",
    conversationId: "conv_1",
    kind: "snapshot_required",
    reason: "retention_exceeded",
  });
  assert.equal(required.needsSnapshot, true);
  assert.equal(reduceRemoteConversationState(required, turnCreated(22)), required);
});

test("terminal turns keep the conversation appendable", () => {
  assert.equal(deriveRemoteConversationStatus({
    latestTurn: {
      ...turnCreated().turn,
      state: "succeeded",
    },
  }), "idle");
});

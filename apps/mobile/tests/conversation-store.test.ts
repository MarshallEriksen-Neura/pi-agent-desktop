import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteConversationCapabilities,
  RemoteConversationEvent,
  RemoteConversationSnapshot,
  RemoteMessage,
  RemoteMessagePageResponse,
  RemoteConversationCreateResponse,
} from "@pi/remote-control-contracts";
import { useConnectionStore } from "@/stores/connection.store";
import { useConversationDrafts } from "@/stores/conversation-drafts";
import { useConversationStore } from "@/stores/conversation-store";

const capabilities: RemoteConversationCapabilities = {
  conversationV2: true,
  piSessionResume: true,
  appendTurns: true,
  cancelTurn: true,
  interactions: true,
  messagePaging: true,
  eventReplay: true,
  maxQueuedTurns: 8,
  maxPromptBytes: 16_384,
  maxContextFiles: 8,
  maxPageSize: 100,
};

function snapshot(overrides: Partial<RemoteConversationSnapshot> = {}): RemoteConversationSnapshot {
  return {
    version: 2,
    conversationId: "conv-1",
    ownerDeviceId: "device-1",
    projectId: "project-1",
    status: "idle",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    messageCount: 1,
    turnCount: 1,
    queuedTurnCount: 0,
    capabilities,
    latestTurn: {
      turnId: "turn-1",
      conversationId: "conv-1",
      requestId: "req-1",
      ownerDeviceId: "device-1",
      state: "succeeded",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:01.000Z",
      finishedAt: "2026-08-13T00:00:01.000Z",
      userMessageId: "msg-1",
    },
    ...overrides,
  };
}

function message(id: string, text: string, status: RemoteMessage["status"] = "completed"): RemoteMessage {
  return {
    messageId: id,
    conversationId: "conv-1",
    turnId: "turn-1",
    role: "assistant",
    status,
    text,
    createdAt: "2026-08-13T00:00:01.000Z",
    updatedAt: "2026-08-13T00:00:01.000Z",
  };
}

function page(messages: readonly RemoteMessage[]): RemoteMessagePageResponse {
  return { conversationId: "conv-1", messages };
}

function statusEvent(sequence: number, to: "idle" | "running"): RemoteConversationEvent {
  return {
    kind: "conversation.status_changed",
    eventId: `event-${sequence}`,
    emittedAt: `2026-08-13T00:00:0${sequence}.000Z`,
    sequence,
    deviceId: "device-1",
    conversationId: "conv-1",
    from: to === "idle" ? "running" : "idle",
    to,
  };
}

function deltaEvent(sequence: number, delta: string, messageId = "assistant-1"): RemoteConversationEvent {
  return {
    kind: "message.delta",
    eventId: `delta-${sequence}`,
    emittedAt: "2026-08-13T00:00:02.000Z",
    sequence,
    deviceId: "device-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    messageId,
    delta,
  };
}

describe("conversation store reconnect authority", () => {
  beforeEach(() => {
    useConversationStore.getState().reset();
    useConversationDrafts.getState().reset();
    useConnectionStore.setState({ client: null });
  });

  it("replaces local transcript with the authoritative reconnect snapshot", async () => {
    const serverSnapshot = snapshot({ messageCount: 1 });
    const client = {
      getConversation: vi.fn(async () => serverSnapshot),
      getConversationMessages: vi.fn(async () => page([message("server-msg", "from server")])),
    };
    useConnectionStore.setState({ client: client as never });
    useConversationStore.setState({
      open: {
        snapshot: snapshot({ messageCount: 2 }),
        messages: [message("stale", "stale local")],
        reducerState: useConversationStore.getState().open?.reducerState ?? {
          snapshot: snapshot(),
          lastSequence: 0,
          needsSnapshot: false,
          seenTurnIds: new Set(),
          seenMessageIds: new Set(),
        },
        loadingMessages: false,
      },
    });

    await useConversationStore.getState().reconcile();
    expect(useConversationStore.getState().open?.messages.map((item) => item.text)).toEqual(["from server"]);
    expect(useConversationStore.getState().open?.messages.some((item) => item.text === "stale local")).toBe(false);
  });

  it("does not duplicate streamed deltas or append after terminal completion", () => {
    useConversationStore.setState({
      open: {
        snapshot: snapshot({ latestMessage: message("assistant-1", "done", "completed") }),
        messages: [message("assistant-1", "done", "completed")],
        reducerState: {
          snapshot: snapshot({ latestMessage: message("assistant-1", "done", "completed") }),
          lastSequence: 3,
          needsSnapshot: false,
          seenTurnIds: new Set(["turn-1"]),
          seenMessageIds: new Set(["assistant-1"]),
        },
        loadingMessages: false,
      },
    });
    useConversationStore.getState().applyEvent(deltaEvent(4, " late"));
    useConversationStore.getState().applyEvent(deltaEvent(4, " late"));
    expect(useConversationStore.getState().open?.messages[0].text).toBe("done");
  });

  it("keeps offline sends as drafts and never inserts them into transcript", async () => {
    const client = {
      appendTurn: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    useConnectionStore.setState({ client: client as never });
    await useConversationStore.getState().appendTurn("conv-1", {
      requestId: "req-offline",
      prompt: "draft only",
    });
    expect(useConversationStore.getState().open).toBeNull();
    expect(useConversationDrafts.getState().get("req-offline")?.prompt).toBe("draft only");
  });
});

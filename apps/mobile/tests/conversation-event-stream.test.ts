import { describe, expect, it, vi } from "vitest";
import type { RemoteConversationEvent } from "@pi/remote-control-contracts";
import type { EventStreamHandle, SecureNetPort } from "@/net/port";
import { ConversationEventStreamClient } from "@/net/conversation-event-stream";

class FakeHandle implements EventStreamHandle {
  readonly streamId = "fake-stream";
  private messageCallbacks = new Set<(data: string) => void>();
  private closeCallbacks = new Set<(code: number, reason: string) => void>();
  private errorCallbacks = new Set<(message: string) => void>();

  onMessage(callback: (data: string) => void): () => void {
    this.messageCallbacks.add(callback);
    return () => this.messageCallbacks.delete(callback);
  }

  onClose(callback: (code: number, reason: string) => void): () => void {
    this.closeCallbacks.add(callback);
    return () => this.closeCallbacks.delete(callback);
  }

  onError(callback: (message: string) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  async close(): Promise<void> {
    this.emitClose(1000, "closed");
  }

  emit(event: RemoteConversationEvent): void {
    for (const callback of this.messageCallbacks) callback(JSON.stringify(event));
  }

  emitClose(code = 1006, reason = "dropped"): void {
    for (const callback of this.closeCallbacks) callback(code, reason);
  }

  emitError(message: string): void {
    for (const callback of this.errorCallbacks) callback(message);
  }
}

function event(kind: "conversation.status_changed" | "snapshot_required", sequence: number): RemoteConversationEvent {
  if (kind === "snapshot_required") {
    return {
      kind,
      eventId: `event-${sequence}`,
      emittedAt: "2026-08-13T00:00:00.000Z",
      sequence,
      deviceId: "device-1",
      conversationId: "conv-1",
      reason: "cursor_expired",
    } as RemoteConversationEvent;
  }
  return {
    kind,
    eventId: `event-${sequence}`,
    emittedAt: "2026-08-13T00:00:00.000Z",
    sequence,
    deviceId: "device-1",
    conversationId: "conv-1",
    from: "running",
    to: "idle",
  } as RemoteConversationEvent;
}

describe("ConversationEventStreamClient", () => {
  it("deduplicates events and routes snapshot_required separately", async () => {
    let handle: FakeHandle | undefined;
    const received: RemoteConversationEvent[] = [];
    const snapshots = vi.fn();
    const transport = {
      openStream: vi.fn(async () => {
        handle = new FakeHandle();
        return handle;
      }),
    } as unknown as SecureNetPort;
    const client = new ConversationEventStreamClient(transport, () => "/v2/stream", () => ({}), {
      onEvent: (value) => received.push(value),
      onSnapshotRequired: snapshots,
    });

    await client.connect();
    handle!.emit(event("conversation.status_changed", 1));
    handle!.emit(event("conversation.status_changed", 1));
    handle!.emit(event("snapshot_required", 2));

    expect(received).toHaveLength(1);
    expect(snapshots).toHaveBeenCalledOnce();
    expect(client.currentSequence).toBe(2);
    await client.stop();
  });

  it("reconnects with the last durable cursor", async () => {
    vi.useFakeTimers();
    try {
      let handle: FakeHandle | undefined;
      const urls: string[] = [];
      const transport = {
        openStream: vi.fn(async (options: { url: string }) => {
          urls.push(options.url);
          handle = new FakeHandle();
          return handle;
        }),
      } as unknown as SecureNetPort;
      const client = new ConversationEventStreamClient(
        transport,
        (after) => `/v2/stream${after == null ? "" : `?after=${after}`}`,
        () => ({}),
        { onEvent: () => {}, onSnapshotRequired: () => {} },
      );

      await client.connect();
      handle!.emit(event("conversation.status_changed", 7));
      handle!.emitClose();
      await vi.advanceTimersByTimeAsync(1000);

      expect(urls).toEqual(["/v2/stream", "/v2/stream?after=7"]);
      await client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

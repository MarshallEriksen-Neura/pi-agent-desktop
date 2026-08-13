import type { RemoteConversationEvent } from "@pi/remote-control-contracts";

export interface ConversationEventSubscriber {
  onEvent(event: RemoteConversationEvent): void;
  onSnapshotRequired(): void;
  onTerminalError?(message: string): void;
}

let subscribers = new Set<ConversationEventSubscriber>();

export const conversationEventDispatcher = {
  subscribe(subscriber: ConversationEventSubscriber): () => void {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  },
  dispatch(event: RemoteConversationEvent): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onEvent(event);
      } catch {
        // A UI reducer must not break the network stream.
      }
    }
  },
  dispatchSnapshotRequired(): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onSnapshotRequired();
      } catch {
        // Reconciliation errors are handled by the store.
      }
    }
  },
  dispatchTerminalError(message: string): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onTerminalError?.(message);
      } catch {
        // Ignore subscriber failures.
      }
    }
  },
  reset(): void {
    subscribers = new Set();
  },
};

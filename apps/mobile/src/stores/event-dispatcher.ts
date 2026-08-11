import type { RemoteEvent } from "@pi/remote-control-contracts";

/**
 * Event dispatcher — a tiny module-level pub/sub that decouples the
 * connection store (which owns the WSS lifecycle) from the task and
 * interaction stores (which own the domain state).
 *
 * The connection store forwards every deduped `RemoteEvent` here; the task
 * and interaction stores subscribe their reducers. This keeps the connection
 * store framework-agnostic (no React/zustand import from the net layer) while
 * still letting domain state react to the live event stream.
 *
 * The `snapshotRequired` signal is separate: it tells subscribers to refetch
 * authoritative state via GET /tasks + GET /interactions because the replay
 * window is exhausted (plan AC9).
 */

export interface EventSubscriber {
  onEvent(event: RemoteEvent): void;
  onSnapshotRequired(): void;
  /** Called when the WSS reaches a terminal error (pin_mismatch / identity). */
  onTerminalError?(message: string): void;
}

type Subscribers = Set<EventSubscriber>;

let subs: Subscribers = new Set();

export const eventDispatcher = {
  subscribe(sub: EventSubscriber): () => void {
    subs.add(sub);
    return () => {
      subs.delete(sub);
    };
  },

  dispatch(event: RemoteEvent): void {
    // Iterate a snapshot so subscribers can unsubscribe mid-dispatch.
    for (const s of [...subs]) {
      try {
        s.onEvent(event);
      } catch {
        // A faulty subscriber must not break the event loop.
      }
    }
  },

  dispatchSnapshotRequired(): void {
    for (const s of [...subs]) {
      try {
        s.onSnapshotRequired();
      } catch {
        // ignore
      }
    }
  },

  dispatchTerminalError(message: string): void {
    for (const s of [...subs]) {
      try {
        s.onTerminalError?.(message);
      } catch {
        // ignore
      }
    }
  },

  /** Test-only: clear all subscribers. */
  reset(): void {
    subs = new Set();
  },
};

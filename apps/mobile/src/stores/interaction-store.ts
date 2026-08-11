import { create } from "zustand";
import type {
  RemoteEvent,
  RemoteInteractionSnapshot,
  RemoteInteractionResponse,
  RemoteInteractionResponseValue,
} from "@pi/remote-control-contracts";
import { useConnectionStore } from "./connection.store";
import { eventDispatcher } from "./event-dispatcher";
import { NetError } from "@/net/errors";

/**
 * Interaction store — domain state for awaiting_input interactions, fed by:
 *  1. The live WSS event stream (via {@link eventDispatcher}).
 *  2. Explicit REST refetches (GET /interactions) on mount,
 *     snapshot_required, or reconnect.
 *
 * Invariants (plan AC9, AC11, Stage 1):
 *  - A resolved/expired interaction is terminal — replayed events are no-ops.
 *  - snapshot_required triggers a full refetch.
 *  - response submission is idempotent from the store's perspective: a network
 *    error after the server accepted the response is reconciled on the next
 *    refresh.
 *  - The "pending" set is what the UI surfaces as actionable (badge + list).
 */

interface InteractionState {
  /** All known interactions, keyed by interactionId. */
  interactions: Record<string, RemoteInteractionSnapshot>;
  /** Order of arrival — newest first, for list rendering. */
  order: string[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** interactionIds currently being responded to (in-flight POST). */
  responding: Set<string>;

  refresh: () => Promise<void>;
  fetchInteraction: (interactionId: string) => Promise<RemoteInteractionSnapshot | null>;
  respond: (
    interactionId: string,
    kind: RemoteInteractionSnapshot["kind"],
    value: RemoteInteractionResponseValue,
  ) => Promise<boolean>;
  reset: () => void;
}

export const useInteractionStore = create<InteractionState>((set, get) => ({
  interactions: {},
  order: [],
  loading: false,
  refreshing: false,
  error: null,
  responding: new Set(),

  refresh: async () => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    const isFirst = !get().loading && get().order.length === 0;
    set({ loading: isFirst, refreshing: !isFirst, error: null });
    try {
      const list = await client.getInteractions();
      applySnapshotList(list);
      set({ loading: false, refreshing: false });
    } catch (e) {
      set({
        error: e instanceof NetError ? e.message : "fetch_failed",
        loading: false,
        refreshing: false,
      });
    }
  },

  fetchInteraction: async (interactionId) => {
    const client = useConnectionStore.getState().client;
    if (!client) return null;
    try {
      const snap = await client.getInteraction(interactionId);
      upsertInteraction(snap);
      return snap;
    } catch {
      return null;
    }
  },

  respond: async (interactionId, kind, value) => {
    const client = useConnectionStore.getState().client;
    if (!client) return false;
    // Prevent double-submit: if already responding, reject.
    if (get().responding.has(interactionId)) return false;
    set((s) => {
      const next = new Set(s.responding);
      next.add(interactionId);
      return { responding: next };
    });

    const now = new Date().toISOString();
    const response: RemoteInteractionResponse = {
      interactionId,
      kind,
      value,
      submittedAt: now,
    };
    try {
      const snap = await client.respondInteraction(interactionId, response);
      upsertInteraction(snap);
      return true;
    } catch (e) {
      // Surface the error but leave the interaction pending — the server is
      // authoritative; a failed POST may still have been accepted.
      set({ error: e instanceof NetError ? e.message : "respond_failed" });
      return false;
    } finally {
      set((s) => {
        const next = new Set(s.responding);
        next.delete(interactionId);
        return { responding: next };
      });
    }
  },

  reset: () => {
    set({
      interactions: {},
      order: [],
      loading: false,
      refreshing: false,
      error: null,
      responding: new Set(),
    });
  },
}));

// ----------------------------------------------------------------
// Selectors
// ----------------------------------------------------------------

/** Pending interactions (status === "pending"), newest first. */
export function selectPending(s: InteractionState): RemoteInteractionSnapshot[] {
  return s.order
    .map((id) => s.interactions[id])
    .filter((i): i is RemoteInteractionSnapshot => Boolean(i) && i.status === "pending");
}

/** Count of pending interactions — drives the tab badge. */
export function selectPendingCount(s: InteractionState): number {
  return selectPending(s).length;
}

/** Is this interaction currently being responded to? */
export function selectIsResponding(s: InteractionState, interactionId: string): boolean {
  return s.responding.has(interactionId);
}

// ----------------------------------------------------------------
// Event subscription — installed once on module load.
// ----------------------------------------------------------------

let subscribed = false;

export function initInteractionEventSubscription(): () => void {
  if (subscribed) return () => {};
  subscribed = true;
  return eventDispatcher.subscribe({
    onEvent(event: RemoteEvent) {
      applyInteractionEvent(event);
    },
    onSnapshotRequired() {
      void useInteractionStore.getState().refresh();
    },
    onTerminalError() {
      // Pin/identity failure — keep interaction state as-is; the connection
      // store transitions to identity_failed. Pending interactions remain
      // visible so the user sees what was interrupted.
    },
  });
}

// Re-export for tests that want to drive the reducer directly.
export function applyInteractionEvent(event: RemoteEvent): void {
  switch (event.kind) {
    case "interaction.requested": {
      // Fetch the authoritative snapshot — the event is a signal; the snapshot
      // carries options + full prompt + expiry.
      void useInteractionStore.getState().fetchInteraction(event.interactionId);
      break;
    }
    case "interaction.resolved": {
      useInteractionStore.setState((s) => {
        const existing = s.interactions[event.interactionId];
        if (!existing) {
          // Unknown interaction — snapshot_required path will reconcile.
          return s;
        }
        // Terminal — never revive via stale replay.
        if (existing.status !== "pending") return s;
        const updated: RemoteInteractionSnapshot = {
          ...existing,
          status: "resolved",
          resolvedAt: event.emittedAt,
          response: event.response,
        };
        return { interactions: { ...s.interactions, [event.interactionId]: updated } };
      });
      break;
    }
    case "interaction.expired": {
      useInteractionStore.setState((s) => {
        const existing = s.interactions[event.interactionId];
        if (!existing) return s;
        if (existing.status !== "pending") return s;
        const updated: RemoteInteractionSnapshot = {
          ...existing,
          status: "expired",
        };
        return { interactions: { ...s.interactions, [event.interactionId]: updated } };
      });
      break;
    }
    // task.* handled by the task store.
    case "task.created":
    case "task.state_changed":
    case "task.output_appended":
    case "task.completed":
    case "task.changes":
    case "event_backpressure":
    case "snapshot_required":
      break;
  }
}

// ----------------------------------------------------------------
// Reducer helpers
// ----------------------------------------------------------------

function upsertInteraction(snap: RemoteInteractionSnapshot): void {
  useInteractionStore.setState((s) => {
    const existing = s.interactions[snap.interactionId];
    // Terminal — never revive via stale non-terminal replay.
    if (existing && existing.status !== "pending" && snap.status === "pending") {
      return s;
    }
    const interactions = { ...s.interactions, [snap.interactionId]: snap };
    let order = s.order;
    if (!existing) {
      // Prepend newest.
      order = [snap.interactionId, ...s.order];
    }
    return { interactions, order };
  });
}

function applySnapshotList(list: RemoteInteractionSnapshot[]): void {
  useInteractionStore.setState(() => {
    const interactions: Record<string, RemoteInteractionSnapshot> = {};
    const order: string[] = [];
    // Server may return newest-first; preserve that order.
    for (const snap of list) {
      interactions[snap.interactionId] = snap;
      order.push(snap.interactionId);
    }
    return { interactions, order };
  });
}

// Auto-install the subscription on import in the app runtime. Tests call
// initInteractionEventSubscription() explicitly and reset `subscribed` if needed.
if (typeof window !== "undefined") {
  initInteractionEventSubscription();
}

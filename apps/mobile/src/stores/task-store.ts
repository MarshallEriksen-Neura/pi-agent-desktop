import { create } from "zustand";
import type {
  RemoteEvent,
  RemoteTaskSnapshot,
  RemoteTaskOutputAppendedEvent,
  RemoteTaskState,
  RemoteTaskError,
} from "@pi/remote-control-contracts";
import { REMOTE_TASK_TERMINAL_STATES } from "@pi/remote-control-contracts";
import { useConnectionStore } from "./connection.store";
import { eventDispatcher } from "./event-dispatcher";
import { NetError } from "@/net/errors";
import { maybeNotifyTaskCompleted } from "@/services/notifications";

/**
 * Task store — domain state for tasks, fed by:
 *  1. The live WSS event stream (via {@link eventDispatcher}).
 *  2. Explicit REST refetches (GET /tasks, GET /tasks/{id}) on mount,
 *     snapshot_required, event_backpressure, or reconnect.
 *
 * Invariants (plan AC9, AC11):
 *  - Terminal states are never re-applied. A task that reached
 *    succeeded/failed/cancelled keeps its terminal state across reconnects —
 *    a replayed terminal event is a no-op.
 *  - Output fragments are bounded per task (last ~1 MiB). The gateway retains
 *    more; the phone shows a tail.
 *  - snapshot_required triggers a full refetch; event_backpressure marks the
 *    task stale and triggers a refetch of that task.
 *  - A phone going offline never marks a running task as cancelled — only
 *    authoritative events do.
 */

export interface OutputFragment {
  readonly stream: "stdout" | "stderr" | "tool" | "meta";
  readonly fragment: string;
  readonly sequence: number;
  readonly emittedAt: string;
}

interface TaskState {
  tasks: RemoteTaskSnapshot[];
  output: Record<string, OutputFragment[]>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Tasks flagged stale by event_backpressure; UI shows a refresh hint. */
  staleTaskIds: Set<string>;
  lastSequence: number;

  refresh: () => Promise<void>;
  fetchTask: (taskId: string) => Promise<RemoteTaskSnapshot | null>;
  clearOutput: (taskId: string) => void;
  reset: () => void;
}

const MAX_OUTPUT_FRAGMENTS = 400;
const MAX_OUTPUT_BYTES = 1_000_000;

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  output: {},
  loading: false,
  refreshing: false,
  error: null,
  staleTaskIds: new Set(),
  lastSequence: 0,

  refresh: async () => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    const isFirst = !get().loading && get().tasks.length === 0;
    set({ loading: isFirst, refreshing: !isFirst, error: null });
    try {
      const tasks = await client.getTasks();
      set({ tasks, loading: false, refreshing: false });
    } catch (e) {
      set({
        error: e instanceof NetError ? e.message : "fetch_failed",
        loading: false,
        refreshing: false,
      });
    }
  },

  fetchTask: async (taskId) => {
    const client = useConnectionStore.getState().client;
    if (!client) return null;
    try {
      const snap = await client.getTask(taskId);
      upsertTask(snap);
      return snap;
    } catch {
      return null;
    }
  },

  clearOutput: (taskId) => {
    set((s) => {
      if (!s.output[taskId]) return s;
      const next = { ...s.output };
      delete next[taskId];
      return { output: next };
    });
  },

  reset: () => {
    set({
      tasks: [],
      output: {},
      loading: false,
      refreshing: false,
      error: null,
      staleTaskIds: new Set(),
      lastSequence: 0,
    });
  },
}));

// ----------------------------------------------------------------
// Event subscription — installed once on module load.
// ----------------------------------------------------------------

let subscribed = false;

export function initTaskEventSubscription(): () => void {
  if (subscribed) return () => {};
  subscribed = true;
  return eventDispatcher.subscribe({
    onEvent(event: RemoteEvent) {
      applyTaskEvent(event);
    },
    onSnapshotRequired() {
      void useTaskStore.getState().refresh();
    },
    onTerminalError() {
      // Pin/identity failure — keep task state as-is; phone going offline
      // does not cancel running tasks (only authoritative events do).
    },
  });
}

// Re-export for tests that want to drive the reducer directly.
export function applyTaskEvent(event: RemoteEvent): void {
  const store = useTaskStore.getState();
  const seq = event.sequence;
  if (seq > store.lastSequence) {
    useTaskStore.setState({ lastSequence: seq });
  }

  // Terminal task notification — dedup + watching-page skip live in the
  // service, so replays and reconnects never double-alert.
  if (event.kind === "task.completed") {
    void maybeNotifyTaskCompleted(event.taskId, event.state);
  }

  switch (event.kind) {
    case "task.created":
      upsertTask(event.task);
      break;
    case "task.state_changed":
      updateTaskState(event.taskId, event.to, event.emittedAt, event.error);
      break;
    case "task.completed":
      updateTaskState(event.taskId, event.state, event.emittedAt, event.error);
      break;
    case "task.output_appended":
      appendOutput(event);
      break;
    case "task.changes":
      // Snapshot delta — refetch the authoritative task.
      void useTaskStore.getState().fetchTask(event.taskId);
      break;
    case "event_backpressure":
      // Control lane saturated — mark stale and refetch.
      useTaskStore.setState((s) => {
        const next = new Set(s.staleTaskIds);
        next.add(event.taskId);
        return { staleTaskIds: next };
      });
      void useTaskStore.getState().fetchTask(event.taskId);
      break;
    case "snapshot_required":
      void useTaskStore.getState().refresh();
      break;
    // interaction.* handled by the interaction store.
    case "interaction.requested":
    case "interaction.resolved":
    case "interaction.expired":
      break;
  }
}

// ----------------------------------------------------------------
// Reducer helpers
// ----------------------------------------------------------------

function upsertTask(snap: RemoteTaskSnapshot): void {
  useTaskStore.setState((s) => {
    const idx = s.tasks.findIndex((t) => t.taskId === snap.taskId);
    if (idx === -1) {
      // New task — prepend (most recent first).
      return { tasks: [snap, ...s.tasks] };
    }
    // Existing task — preserve terminal state: a replayed terminal event
    // must not resurrect a non-terminal snapshot the gateway already moved on.
    const existing = s.tasks[idx];
    if (
      REMOTE_TASK_TERMINAL_STATES.includes(existing.state) &&
      !REMOTE_TASK_TERMINAL_STATES.includes(snap.state)
    ) {
      return s;
    }
    const next = [...s.tasks];
    next[idx] = { ...existing, ...snap };
    return { tasks: next };
  });
}

function updateTaskState(
  taskId: string,
  to: RemoteTaskState,
  updatedAt: string,
  error?: RemoteTaskError,
): void {
  useTaskStore.setState((s) => {
    const idx = s.tasks.findIndex((t) => t.taskId === taskId);
    if (idx === -1) {
      // Unknown task — snapshot_required path will reconcile. Don't fabricate.
      return s;
    }
    const existing = s.tasks[idx];
    // Never revive a terminal task via a stale non-terminal replay.
    if (REMOTE_TASK_TERMINAL_STATES.includes(existing.state)) {
      return s;
    }
    const next = [...s.tasks];
    next[idx] = {
      ...existing,
      state: to,
      updatedAt,
      error,
      finishedAt: REMOTE_TASK_TERMINAL_STATES.includes(to) ? updatedAt : existing.finishedAt,
    };
    // Clear stale flag once a terminal/authoritative event arrives.
    let stale = s.staleTaskIds;
    if (stale.has(taskId) && REMOTE_TASK_TERMINAL_STATES.includes(to)) {
      stale = new Set(stale);
      stale.delete(taskId);
    }
    return { tasks: next, staleTaskIds: stale };
  });
}

function appendOutput(event: RemoteTaskOutputAppendedEvent): void {
  useTaskStore.setState((s) => {
    const frag: OutputFragment = {
      stream: event.stream,
      fragment: event.fragment,
      sequence: event.sequence,
      emittedAt: event.emittedAt,
    };
    const list = s.output[event.taskId] ?? [];
    const next = [...list, frag];
    // Bound by fragment count and total bytes.
    let trimmed = next;
    while (trimmed.length > MAX_OUTPUT_FRAGMENTS) {
      trimmed.shift();
    }
    let totalBytes = trimmed.reduce((n, f) => n + f.fragment.length, 0);
    while (totalBytes > MAX_OUTPUT_BYTES && trimmed.length > 1) {
      const removed = trimmed.shift()!;
      totalBytes -= removed.fragment.length;
    }
    return { output: { ...s.output, [event.taskId]: trimmed } };
  });
}

// Auto-install the subscription on import in the app runtime. Tests call
// initTaskEventSubscription() explicitly and reset `subscribed` if needed.
if (typeof window !== "undefined") {
  initTaskEventSubscription();
}

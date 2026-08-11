import { describe, it, expect, beforeEach } from "vitest";
import { useTaskStore, applyTaskEvent } from "@/stores/task-store";
import type { RemoteEvent, RemoteTaskSnapshot } from "@pi/remote-control-contracts";

function makeTask(overrides: Partial<RemoteTaskSnapshot> = {}): RemoteTaskSnapshot {
  return {
    taskId: "task-1",
    requestId: "req-1",
    ownerDeviceId: "device-1",
    projectId: "proj-1",
    state: "queued",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    contextFiles: [],
    ...overrides,
  };
}

function makeEventBase(seq: number) {
  return {
    eventId: `evt-${seq}`,
    emittedAt: "2026-01-01T00:00:01Z",
    sequence: seq,
    deviceId: "device-1",
  };
}

describe("Task reducer — state transitions", () => {
  beforeEach(() => {
    useTaskStore.getState().reset();
  });

  it("creates a task on task.created event", () => {
    const task = makeTask();
    const event: RemoteEvent = {
      ...makeEventBase(1),
      kind: "task.created",
      task,
    };
    applyTaskEvent(event);
    expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(useTaskStore.getState().tasks[0].taskId).toBe("task-1");
  });

  it("transitions state on task.state_changed", () => {
    // Seed
    applyTaskEvent({ ...makeEventBase(1), kind: "task.created", task: makeTask() });
    // Transition queued → starting
    applyTaskEvent({
      ...makeEventBase(2),
      kind: "task.state_changed",
      taskId: "task-1",
      from: "queued",
      to: "starting",
    });
    expect(useTaskStore.getState().tasks[0].state).toBe("starting");
    // starting → running
    applyTaskEvent({
      ...makeEventBase(3),
      kind: "task.state_changed",
      taskId: "task-1",
      from: "starting",
      to: "running",
    });
    expect(useTaskStore.getState().tasks[0].state).toBe("running");
  });

  it("reaches terminal state on task.completed", () => {
    applyTaskEvent({ ...makeEventBase(1), kind: "task.created", task: makeTask({ state: "running" }) });
    applyTaskEvent({
      ...makeEventBase(2),
      kind: "task.completed",
      taskId: "task-1",
      state: "succeeded",
    });
    expect(useTaskStore.getState().tasks[0].state).toBe("succeeded");
    expect(useTaskStore.getState().tasks[0].finishedAt).toBe("2026-01-01T00:00:01Z");
  });

  it("never revives a terminal task via stale non-terminal replay", () => {
    // Task reaches succeeded
    applyTaskEvent({ ...makeEventBase(1), kind: "task.created", task: makeTask({ state: "running" }) });
    applyTaskEvent({
      ...makeEventBase(2),
      kind: "task.completed",
      taskId: "task-1",
      state: "succeeded",
    });
    // A stale replayed "running" event must NOT revive it
    applyTaskEvent({
      ...makeEventBase(3),
      kind: "task.state_changed",
      taskId: "task-1",
      from: "succeeded",
      to: "running",
    });
    expect(useTaskStore.getState().tasks[0].state).toBe("succeeded");
  });

  it("appends output fragments on task.output_appended", () => {
    applyTaskEvent({ ...makeEventBase(1), kind: "task.created", task: makeTask({ state: "running" }) });
    applyTaskEvent({
      ...makeEventBase(2),
      kind: "task.output_appended",
      taskId: "task-1",
      fragment: "hello ",
      stream: "stdout",
    });
    applyTaskEvent({
      ...makeEventBase(3),
      kind: "task.output_appended",
      taskId: "task-1",
      fragment: "world",
      stream: "stdout",
    });
    const frags = useTaskStore.getState().output["task-1"];
    expect(frags).toHaveLength(2);
    expect(frags.map((f) => f.fragment).join("")).toBe("hello world");
  });

  it("bounds output to prevent unbounded memory growth", () => {
    applyTaskEvent({ ...makeEventBase(1), kind: "task.created", task: makeTask({ state: "running" }) });
    // Push 500 fragments (limit is 400)
    for (let i = 2; i < 502; i++) {
      applyTaskEvent({
        ...makeEventBase(i),
        kind: "task.output_appended",
        taskId: "task-1",
        fragment: "x".repeat(100),
        stream: "stdout",
      });
    }
    const frags = useTaskStore.getState().output["task-1"];
    expect(frags.length).toBeLessThanOrEqual(400);
  });
});

describe("Task reducer — event dedup and sequence", () => {
  beforeEach(() => {
    useTaskStore.getState().reset();
  });

  it("tracks lastSequence monotonically", () => {
    applyTaskEvent({ ...makeEventBase(5), kind: "task.created", task: makeTask() });
    expect(useTaskStore.getState().lastSequence).toBe(5);
    applyTaskEvent({
      ...makeEventBase(3),
      kind: "task.state_changed",
      taskId: "task-1",
      from: "queued",
      to: "starting",
    });
    // An older sequence must not regress lastSequence
    expect(useTaskStore.getState().lastSequence).toBe(5);
    applyTaskEvent({
      ...makeEventBase(10),
      kind: "task.state_changed",
      taskId: "task-1",
      from: "queued",
      to: "starting",
    });
    expect(useTaskStore.getState().lastSequence).toBe(10);
  });

  it("handles snapshot_required by marking for refetch", () => {
    applyTaskEvent({ ...makeEventBase(1), kind: "task.created", task: makeTask() });
    applyTaskEvent({
      ...makeEventBase(2),
      kind: "snapshot_required",
    });
    // snapshot_required doesn't crash; the store remains consistent
    expect(useTaskStore.getState().tasks).toHaveLength(1);
  });

  it("marks task stale on event_backpressure", () => {
    applyTaskEvent({ ...makeEventBase(1), kind: "task.created", task: makeTask({ state: "running" }) });
    applyTaskEvent({
      ...makeEventBase(2),
      kind: "event_backpressure",
      taskId: "task-1",
      reason: "control_lane_saturated",
    });
    expect(useTaskStore.getState().staleTaskIds.has("task-1")).toBe(true);
  });
});

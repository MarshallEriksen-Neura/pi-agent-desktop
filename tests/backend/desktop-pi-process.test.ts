import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopPiProcessPort,
  type DesktopPiProcessDependencies,
} from "../../src/lib/backend/desktop/pi-process";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";

interface InvokeCall {
  command: string;
  args?: Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeDesktopBackend {
  readonly calls: InvokeCall[] = [];
  private readonly handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
  startResult: Promise<{ generation: number; targetId: string }> = Promise.resolve({
    generation: 1,
    targetId: "local",
  });

  readonly dependencies: DesktopPiProcessDependencies = {
    listen: async (event, handler) => {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
      return () => handlers.delete(handler);
    },
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      this.calls.push({ command, args });
      if (command === "pi_start") return (await this.startResult) as T;
      return undefined as T;
    },
  };

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.forEach((handler) => handler({ payload }));
  }

  listenerCount(): number {
    return [...this.handlers.values()].reduce((count, handlers) => count + handlers.size, 0);
  }

  async waitForCall(command: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.calls.some((call) => call.command === command)) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`timed out waiting for ${command}`);
  }
}

const REMOTE_BINDING: ExecutionBinding = {
  kind: "ssh",
  profileId: "work",
  profileRevision: 4,
  hostAlias: "work-host",
  remoteCwd: "/srv/work",
  launcherProtocolVersion: 1,
};

test("desktop Pi process buffers startup events and filters stale identities", async () => {
  const backend = new FakeDesktopBackend();
  const started = deferred<{ generation: number; targetId: string }>();
  backend.startResult = started.promise;
  const process = new DesktopPiProcessPort("task-a", REMOTE_BINDING, backend.dependencies);
  const lines: string[] = [];
  const exits: Array<number | null> = [];
  process.onLine((line) => lines.push(line));
  process.onExit((exit) => exits.push(exit.code));

  const start = process.start({ cwd: "/srv/work", executionBinding: REMOTE_BINDING });
  await backend.waitForCall("pi_start");
  backend.emit("pi://line", {
    taskId: "task-a",
    generation: 7,
    targetId: "ssh:work",
    line: "accepted-before-start-response",
  });
  backend.emit("pi://line", {
    taskId: "task-a",
    generation: 6,
    targetId: "ssh:work",
    line: "stale-generation",
  });
  backend.emit("pi://line", {
    taskId: "task-a",
    generation: 7,
    targetId: "ssh:other",
    line: "stale-target",
  });
  started.resolve({ generation: 7, targetId: "ssh:work" });
  await start;

  assert.deepEqual(lines, ["accepted-before-start-response"]);
  backend.emit("pi://exit", {
    taskId: "task-a",
    generation: 6,
    targetId: "ssh:work",
    code: 1,
  });
  assert.deepEqual(exits, []);
  backend.emit("pi://exit", {
    taskId: "task-a",
    generation: 7,
    targetId: "ssh:work",
    code: 23,
  });
  assert.deepEqual(exits, [23]);
  assert.equal(backend.listenerCount(), 0);
  await assert.rejects(process.send({ type: "abort" }), /Pi is not running/);
});

test("desktop Pi process sends and stops with the active generation and target", async () => {
  const backend = new FakeDesktopBackend();
  backend.startResult = Promise.resolve({ generation: 12, targetId: "ssh:work" });
  const process = new DesktopPiProcessPort("task-b", REMOTE_BINDING, backend.dependencies);

  await process.start({ executionBinding: REMOTE_BINDING });
  await process.send({ type: "abort" });
  await process.stop();

  const send = backend.calls.find((call) => call.command === "pi_send");
  assert.deepEqual(send?.args, {
    taskId: "task-b",
    line: JSON.stringify({ type: "abort" }),
    expectedGeneration: 12,
    expectedTargetId: "ssh:work",
  });
  const stop = backend.calls.find((call) => call.command === "pi_stop");
  assert.deepEqual(stop?.args, {
    taskId: "task-b",
    expectedGeneration: 12,
    expectedTargetId: "ssh:work",
  });
  assert.equal(backend.listenerCount(), 0);
});

test("desktop Pi process cancels a delayed start and stops the late process", async () => {
  const backend = new FakeDesktopBackend();
  const started = deferred<{ generation: number; targetId: string }>();
  backend.startResult = started.promise;
  const process = new DesktopPiProcessPort("task-c", undefined, backend.dependencies);

  const start = process.start();
  await backend.waitForCall("pi_start");
  const stop = process.stop();
  started.resolve({ generation: 19, targetId: "local" });

  await Promise.all([
    assert.rejects(start, /Pi start was cancelled/),
    stop,
  ]);
  const stopCalls = backend.calls.filter((call) => call.command === "pi_stop");
  assert.deepEqual(stopCalls.map((call) => call.args), [
    {
      taskId: "task-c",
      expectedGeneration: 19,
      expectedTargetId: "local",
    },
  ]);
  assert.equal(backend.listenerCount(), 0);
});

test("desktop Pi process rejects and cleans up an unexpected start target", async () => {
  const backend = new FakeDesktopBackend();
  backend.startResult = Promise.resolve({ generation: 31, targetId: "local" });
  const process = new DesktopPiProcessPort("task-d", REMOTE_BINDING, backend.dependencies);

  await assert.rejects(
    process.start({ executionBinding: REMOTE_BINDING }),
    /Pi started on unexpected target local/,
  );
  const stop = backend.calls.find((call) => call.command === "pi_stop");
  assert.deepEqual(stop?.args, {
    taskId: "task-d",
    expectedGeneration: 31,
    expectedTargetId: "local",
  });
  assert.equal(backend.listenerCount(), 0);
});

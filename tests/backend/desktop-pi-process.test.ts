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
    // Null on an attached target: the write either reaches pi's stdin or throws, so
    // there is no ambiguous middle state for a key to protect against. A detached
    // binding — one carrying a remoteTaskId — is what mints one.
    idempotencyKey: null,
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

/**
 * A detached remote target is the one case where the child is not pi.
 *
 * `--attach` is read-only, so its stdout is a stream of frames wrapping journal records
 * and its input has to go out through a separate `--send`. The adapter is the only place
 * that knows this; everything downstream still receives pi lines.
 */
const DETACHED: ExecutionBinding = {
  kind: "ssh",
  profileId: "work",
  profileRevision: 3,
  hostAlias: "build-host",
  remoteCwd: "/srv/app",
  launcherProtocolVersion: 1,
  remoteTaskId: "t-0000000a0001",
};

const frame = (value: Record<string, unknown>) => JSON.stringify(value);

async function startedDetached(attachAfter?: number) {
  const backend = new FakeDesktopBackend();
  backend.startResult = Promise.resolve({ generation: 7, targetId: "ssh:work" });
  const port = new DesktopPiProcessPort("task-d", DETACHED, backend.dependencies);
  const lines: string[] = [];
  const diagnostics: string[] = [];
  const exits: Array<{ code: number | null; detachReason?: string }> = [];
  let resets = 0;
  port.onLine((line) => lines.push(line));
  port.onStderr((line) => diagnostics.push(line));
  port.onExit((exit) => exits.push(exit));
  port.onTranscriptReset(() => {
    resets += 1;
  });
  await port.start({ executionBinding: DETACHED, attachAfter });
  const push = (payload: Record<string, unknown>) =>
    backend.emit("pi://line", {
      taskId: "task-d",
      generation: 7,
      targetId: "ssh:work",
      line: frame(payload),
    });
  return { backend, port, lines, diagnostics, exits, push, resets: () => resets };
}

test("attach frames are unwrapped into pi lines and the cursor advances", async () => {
  const harness = await startedDetached();
  const start = harness.backend.calls.find((call) => call.command === "pi_start");
  // The cursor travels as its own argument: it is the caller's, and deriving it from
  // `generation` would break replay, since every reattach is a new generation against
  // the same remote task.
  assert.equal(start?.args?.attachAfter, null);

  harness.push({
    type: "attached",
    remoteTaskId: "t-0000000a0001",
    state: "running",
    after: null,
    baseSequence: 1,
    nextSequence: 1,
    snapshotRequired: false,
    pid: 40213,
    supervisorPid: 40199,
  });
  // The handshake is not pi output, so nothing reaches the chat pipeline from it.
  assert.deepEqual(harness.lines, []);

  harness.push({ type: "event", sequence: 1, ts: 1, stream: "stdout", data: '{"type":"ready"}' });
  harness.push({ type: "event", sequence: 2, ts: 2, stream: "stderr", data: "boot diagnostic" });
  harness.push({ type: "event", sequence: 3, ts: 3, stream: "control", event: "started" });
  assert.deepEqual(harness.lines, ['{"type":"ready"}']);
  assert.deepEqual(harness.diagnostics, ["boot diagnostic"]);
  // Control records are launcher bookkeeping, not pi output — but they still move the
  // cursor, or a reattach would replay them forever.
  assert.equal(harness.port.appliedSequence, 3);
});

test("a detached send carries an idempotency key and a fresh one each time", async () => {
  const harness = await startedDetached();
  await harness.port.send({ type: "prompt", message: "one" } as never);
  await harness.port.send({ type: "prompt", message: "two" } as never);
  const sends = harness.backend.calls.filter((call) => call.command === "pi_send");
  const keys = sends.map((call) => call.args?.idempotencyKey as string);
  assert.equal(keys.length, 2);
  for (const key of keys) assert.match(key, /^k-[a-z0-9]{1,8}-\d+$/);
  // Two calls are two messages. Reusing one key across them would make the launcher
  // refuse the second as a conflict, or worse, silently swallow it as a duplicate.
  assert.notEqual(keys[0], keys[1]);
});

test("only taskExited reports pi's own exit code", async () => {
  for (const [reason, exitCode, expected] of [
    ["taskExited", 0, 0],
    ["caughtUp", 0, null],
    ["taskGone", null, null],
  ] as const) {
    const harness = await startedDetached();
    harness.push({ type: "detached", reason, exitCode, nextSequence: 5 });
    assert.deepEqual(harness.exits, [{ code: expected, detachReason: reason }], reason);
  }
});

test("a gap and a stale cursor both ask the caller to discard its transcript", async () => {
  const gapped = await startedDetached(41);
  gapped.push({ type: "event", sequence: 42, ts: 1, stream: "stdout", data: "kept" });
  gapped.push({ type: "gap", fromSequence: 43, toSequence: 900 });
  assert.equal(gapped.resets(), 1);
  // The cursor jumps the hole: resuming from before it would re-request records that no
  // longer exist.
  assert.equal(gapped.port.appliedSequence, 900);

  const stale = await startedDetached(41);
  stale.push({
    type: "attached",
    remoteTaskId: "t-0000000a0001",
    state: "running",
    after: 41,
    baseSequence: 100,
    nextSequence: 100,
    snapshotRequired: true,
    pid: null,
    supervisorPid: null,
  });
  assert.equal(stale.resets(), 1);
  // The handshake consumes no sequence space, so a retry with the same stale cursor gets
  // the same answer.
  assert.equal(stale.port.appliedSequence, 41);
});

test("a refused attach ends the channel without claiming pi exited", async () => {
  const harness = await startedDetached();
  harness.push({ ok: false, errorCode: "taskNotFound" });
  // `code: null` on purpose: the launcher refused to attach, which says nothing about
  // whether pi ran or what it returned.
  assert.deepEqual(harness.exits, [{ code: null }]);
});

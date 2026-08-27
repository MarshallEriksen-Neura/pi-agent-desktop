import assert from "node:assert/strict";
import test from "node:test";
import {
  PiClient,
  PiRequestError,
  configurePiClientForTests,
  onAnyTaskEvent,
  onPiClientDisposed,
  peekPiClient,
  resetPiClientForTests,
} from "../../src/lib/pi/client";
import type {
  PiProcessExit,
  PiProcessPort,
  PiProcessStartOptions,
} from "../../src/lib/backend/ports/pi-process";
import type { PiCommand, PiResponse } from "../../src/lib/pi/protocol";

class FakePiProcess implements PiProcessPort {
  readonly taskId = "default";
  readonly sent: PiCommand[] = [];
  startedWith: PiProcessStartOptions | undefined;
  failSend: Error | null = null;
  failStop: Error | null = null;
  startCount = 0;
  private readonly lineHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(line: string) => void>();
  private readonly exitHandlers = new Set<(exit: PiProcessExit) => void>();

  async start(options?: PiProcessStartOptions): Promise<void> {
    this.startCount += 1;
    this.startedWith = options;
  }

  async send(command: PiCommand): Promise<void> {
    this.sent.push(command);
    if (this.failSend) throw this.failSend;
  }

  async stop(): Promise<void> {
    if (this.failStop) throw this.failStop;
    return undefined;
  }

  onLine(handler: (line: string) => void): () => void {
    this.lineHandlers.add(handler);
    return () => {
      this.lineHandlers.delete(handler);
    };
  }

  onStderr(handler: (line: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => {
      this.stderrHandlers.delete(handler);
    };
  }

  onExit(handler: (exit: PiProcessExit) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  emitLine(value: unknown): void {
    const line = typeof value === "string" ? value : JSON.stringify(value);
    this.lineHandlers.forEach((handler) => handler(line));
  }

  emitExit(code: number | null): void {
    this.exitHandlers.forEach((handler) => handler({ code }));
  }
}

test("PiClient uses the injected process port and preserves caller ids", async () => {
  const process = new FakePiProcess();
  const client = new PiClient("test-task", process);

  await client.start({ cwd: "D:/work", resumePath: "session-1" });
  const responsePromise = client.request<{ ok: true }>(
    { type: "bash", command: "pwd", id: "cmd-1" },
    100
  );

  assert.deepEqual(process.startedWith, { cwd: "D:/work", resumePath: "session-1" });
  assert.deepEqual(process.sent[0], { type: "bash", command: "pwd", id: "cmd-1" });

  process.emitLine({
    type: "response",
    command: "bash",
    success: true,
    id: "cmd-1",
    data: { ok: true },
  } satisfies PiResponse);

  assert.deepEqual(await responsePromise, {
    type: "response",
    command: "bash",
    success: true,
    id: "cmd-1",
    data: { ok: true },
  });
});

test("PiClient rejects pending requests on send failure and process exit", async () => {
  const process = new FakePiProcess();
  const client = new PiClient("test-task", process);
  process.failSend = new Error("broken pipe");

  await assert.rejects(
    () => client.request({ type: "get_state" }, 100),
    (error) =>
      error instanceof PiRequestError &&
      error.kind === "send" &&
      error.command === "get_state" &&
      error.detail === "broken pipe"
  );

  process.failSend = null;
  const pending = client.request({ type: "get_available_models" }, 1_000);
  process.emitExit(9);

  await assert.rejects(
    () => pending,
    (error) =>
      error instanceof PiRequestError &&
      error.kind === "exit" &&
      error.exitCode === 9
  );
});

test("getPiClient singleton is explicit and resettable for tests", () => {
  const firstProcess = new FakePiProcess();
  const first = configurePiClientForTests(firstProcess);
  const second = configurePiClientForTests(new FakePiProcess());

  assert.notEqual(first, second);
  resetPiClientForTests();
});

test("PiClient keeps a live process coherent when stop fails", async () => {
  const process = new FakePiProcess();
  const client = new PiClient("test-task", process);
  await client.start();

  const pending = client.request({ type: "get_state" }, 1_000);
  const request = process.sent[0] as PiCommand & { id?: string };
  process.failStop = new Error("stop rejected");
  await assert.rejects(() => client.stop(), /stop rejected/);

  process.emitLine({
    type: "response",
    command: "get_state",
    success: true,
    id: request.id,
    data: {},
  });
  assert.equal((await pending).success, true);

  await client.start();
  assert.equal(process.startCount, 1);
});

/**
 * Extension UI is the reason the cross-task bus exists. `useExtUi.init()` runs
 * at boot, before the first conversation resolves, so it has no task id to bind
 * to — and every real task id is a UUID, so binding to the implicit `"default"`
 * task meant a blocking `select`/`editor` from a real conversation reached
 * nobody and hung that turn forever.
 */
test("onAnyTaskEvent sees clients created after it subscribed", () => {
  resetPiClientForTests();
  const seen: Array<{ taskId: string; id: string }> = [];
  const off = onAnyTaskEvent("extension_ui_request", (taskId, e) => {
    if (e.type !== "extension_ui_request") return;
    seen.push({ taskId, id: e.id });
  });

  // subscribed first, client born second — the boot-order case
  const process = new FakePiProcess();
  const client = new PiClient("task-uuid-1", process);
  process.emitLine({
    type: "extension_ui_request",
    id: "req-1",
    method: "select",
    title: "pick",
    options: ["a", "b"],
  });

  assert.deepEqual(seen, [{ taskId: "task-uuid-1", id: "req-1" }]);

  // and the task id must be the *originating* one, so the reply can be routed
  // back to the process that is actually blocked
  const other = new FakePiProcess();
  const otherClient = new PiClient("task-uuid-2", other);
  other.emitLine({
    type: "extension_ui_request",
    id: "req-2",
    method: "confirm",
    title: "ok?",
  });
  assert.deepEqual(seen[1], { taskId: "task-uuid-2", id: "req-2" });

  off();
  process.emitLine({
    type: "extension_ui_request",
    id: "req-3",
    method: "confirm",
    title: "after unsubscribe",
  });
  assert.equal(seen.length, 2);

  client.dispose();
  otherClient.dispose();
});

test("peekPiClient does not create a client, and dispose notifies", () => {
  resetPiClientForTests();
  assert.equal(peekPiClient("never-seen"), undefined);

  const disposed: string[] = [];
  const off = onPiClientDisposed((taskId) => disposed.push(taskId));

  const client = configurePiClientForTests(new FakePiProcess());
  // configurePiClientForTests registers under the active task id
  assert.equal(peekPiClient("default"), client);

  resetPiClientForTests();
  // resetPiClientForTests clears the registry without firing dispose subs;
  // subscriptions themselves must survive so a live consumer stays attached
  assert.equal(peekPiClient("default"), undefined);
  assert.deepEqual(disposed, []);
  off();
});

/**
 * pi never acks `extension_ui_response`: its stdin dispatcher resolves the
 * waiting extension promise and returns before `handleCommand`, so no `response`
 * is emitted. `request()` would therefore hang for its full timeout — which left
 * every answered dialog stuck on screen for 15s and then reported a failure,
 * even though pi had taken the answer and moved on. `write()` reports only
 * whether the write itself landed.
 */
test("write resolves without an ack and surfaces send failures", async () => {
  const process = new FakePiProcess();
  const client = new PiClient("task-uuid-3", process);
  await client.start();

  // no response is ever emitted for this command — must not hang
  await client.write({
    type: "extension_ui_response",
    id: "dialog-1",
    value: "picked",
  });
  assert.deepEqual(process.sent[0], {
    type: "extension_ui_response",
    id: "dialog-1",
    value: "picked",
  });

  // a failed write is still a real failure the sheet must report
  process.failSend = new Error("broken pipe");
  await assert.rejects(
    () =>
      client.write({
        type: "extension_ui_response",
        id: "dialog-2",
        cancelled: true,
      }),
    (error: unknown) =>
      error instanceof PiRequestError &&
      error.kind === "send" &&
      error.command === "extension_ui_response" &&
      error.requestId === "dialog-2"
  );
});

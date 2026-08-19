import assert from "node:assert/strict";
import test from "node:test";
import {
  PiClient,
  PiRequestError,
  configurePiClientForTests,
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
  const client = new PiClient(process);

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
  const client = new PiClient(process);
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
  const client = new PiClient(process);
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

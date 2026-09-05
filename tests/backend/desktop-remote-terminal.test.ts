import assert from "node:assert/strict";
import test from "node:test";

import { DesktopRemoteTerminalPort } from "../../src/lib/backend/desktop/remote-terminal";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";

interface InvokeCall {
  command: string;
  args?: Record<string, unknown>;
}

type EventHandler = (event: { payload: unknown }) => void;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeDesktopBackend {
  readonly calls: InvokeCall[] = [];
  readonly writeGates: Array<ReturnType<typeof deferred>> = [];
  startGate: ReturnType<typeof deferred> | null = null;
  stopError: Error | null = null;
  private readonly handlers = new Map<string, Set<EventHandler>>();

  readonly dependencies = {
    listen: async <T>(event: string, handler: (event: { payload: T }) => void) => {
      const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
      const wrapped = handler as EventHandler;
      handlers.add(wrapped);
      this.handlers.set(event, handlers);
      return () => handlers.delete(wrapped);
    },
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      this.calls.push({ command, args });
      if (command === "remote_terminal_start") {
        if (this.startGate) await this.startGate.promise;
        return { sessionId: args?.sessionId, targetId: "ssh:work", shellFallback: false } as T;
      }
      if (command === "remote_terminal_stop" && this.stopError) throw this.stopError;
      if (command === "remote_terminal_write") {
        const gate = deferred();
        this.writeGates.push(gate);
        await gate.promise;
      }
      return undefined as T;
    },
  };

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.forEach((handler) => handler({ payload }));
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


const LOCAL_BINDING: ExecutionBinding = { kind: "local", targetId: "local" };
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("desktop remote terminal forwards lifecycle commands without using the Pi channel", async () => {
  const backend = new FakeDesktopBackend();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);

  const started = await port.start({
    sessionId: "terminal-1",
    executionBinding: REMOTE_BINDING,
    cols: 120,
    rows: 40,
  });
  await port.resize("terminal-1", 90, 30);

  assert.deepEqual(started, {
    sessionId: "terminal-1",
    targetId: "ssh:work",
    shellFallback: false,
  });
  assert.deepEqual(backend.calls, [
    {
      command: "remote_terminal_start",
      args: {
        sessionId: "terminal-1",
        generation: 1,
        executionBinding: REMOTE_BINDING,
        cwd: null,
        localShell: null,
        cols: 120,
        rows: 40,
      },
    },
    {
      command: "remote_terminal_resize",
      args: { sessionId: "terminal-1", generation: 1, cols: 90, rows: 30 },
    },
  ]);
});

test("desktop terminal forwards an immutable local cwd snapshot to the PTY backend", async () => {
  const backend = new FakeDesktopBackend();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);

  await port.start({
    sessionId: "terminal-local-2",
    executionBinding: LOCAL_BINDING,
    cwd: "C:/projects/ragcode",
    localShell: { kind: "custom", executable: "C:/Program Files/PowerShell/7/pwsh.exe" },
    cols: 100,
    rows: 32,
  });

  assert.deepEqual(backend.calls[0], {
    command: "remote_terminal_start",
    args: {
      sessionId: "terminal-local-2",
      generation: 1,
      executionBinding: LOCAL_BINDING,
      cwd: "C:/projects/ragcode",
      localShell: { kind: "custom", executable: "C:/Program Files/PowerShell/7/pwsh.exe" },
      cols: 100,
      rows: 32,
    },
  });
});

test("desktop local terminals default omitted shell snapshots to Auto", async () => {
  const backend = new FakeDesktopBackend();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);

  await port.start({
    sessionId: "terminal-local-auto",
    executionBinding: LOCAL_BINDING,
    cols: 80,
    rows: 24,
  });

  assert.deepEqual(backend.calls[0]?.args?.localShell, { kind: "auto" });
  assert.equal(backend.calls[0]?.args?.cwd, null);
});

test("desktop remote terminal stops immediately and suppresses queued writes", async () => {
  const backend = new FakeDesktopBackend();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);

  await port.start({
    sessionId: "terminal-2",
    executionBinding: REMOTE_BINDING,
    cols: 80,
    rows: 24,
  });
  const first = port.write("terminal-2", "a");
  const second = port.write("terminal-2", "b");
  await flushPromises();
  assert.deepEqual(
    backend.calls.filter((call) => call.command === "remote_terminal_write").map((call) => call.args?.data),
    ["a"]
  );

  await port.stop("terminal-2");
  assert.deepEqual(backend.calls.at(-1), {
    command: "remote_terminal_stop",
    args: { sessionId: "terminal-2", generation: 1 },
  });
  assert.deepEqual(
    backend.calls.filter((call) => call.command === "remote_terminal_write").map((call) => call.args?.data),
    ["a"]
  );

  const secondRejected = assert.rejects(second, /stopping/);
  backend.writeGates[0].resolve();
  await first;
  await secondRejected;
  await assert.rejects(port.write("terminal-2", "c"), /stopping/);
  assert.deepEqual(
    backend.calls.filter((call) => call.command === "remote_terminal_write").map((call) => call.args?.data),
    ["a"]
  );
});

test("desktop remote terminal cleans up a start that races with stop", async () => {
  const backend = new FakeDesktopBackend();
  backend.startGate = deferred();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);
  const starting = port.start({
    sessionId: "terminal-race",
    executionBinding: REMOTE_BINDING,
    cols: 80,
    rows: 24,
  });
  const startRejected = assert.rejects(starting, /stopped while starting/);
  await flushPromises();
  await port.stop("terminal-race");
  backend.startGate.resolve();
  await startRejected;

  const stopCalls = backend.calls.filter((call) => call.command === "remote_terminal_stop");
  assert.ok(
    stopCalls.length >= 2,
    "stop should be retried with the original generation after start finishes"
  );
  assert.ok(
    stopCalls.every((call) => call.args?.generation === 1),
    "all cleanup attempts must target the started generation"
  );
});

test("desktop remote terminal rolls back state when stop fails", async () => {
  const backend = new FakeDesktopBackend();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);
  await port.start({
    sessionId: "terminal-stop-failure",
    executionBinding: REMOTE_BINDING,
    cols: 80,
    rows: 24,
  });

  backend.stopError = new Error("kill failed");
  await assert.rejects(port.stop("terminal-stop-failure"), /kill failed/);
  backend.stopError = null;
  await port.stop("terminal-stop-failure");

  const stopCalls = backend.calls.filter((call) => call.command === "remote_terminal_stop");
  assert.deepEqual(
    stopCalls.map((call) => call.args?.generation),
    [1, 1],
    "a retry must target the still-running backend generation"
  );
});

test("desktop remote terminal decodes bytes and rejects malformed events", async () => {
  const backend = new FakeDesktopBackend();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);
  const data: Array<{ sessionId: string; bytes: number[] }> = [];
  const exits: unknown[] = [];
  const unlistenData = await port.onData((event) => {
    data.push({ sessionId: event.sessionId, bytes: [...event.data] });
  });
  const unlistenExit = await port.onExit((event) => exits.push(event));
  await port.start({
    sessionId: "terminal-3",
    executionBinding: REMOTE_BINDING,
    cols: 80,
    rows: 24,
  });

  backend.emit("remote-terminal://data", {
    sessionId: "terminal-3",
    generation: 1,
    dataBase64: "AQD/",
  });
  backend.emit("remote-terminal://data", {
    sessionId: "terminal-3",
    generation: 2,
    dataBase64: "stale",
  });
  backend.emit("remote-terminal://data", { sessionId: "terminal-3", generation: 1, dataBase64: 7 });
  backend.emit("remote-terminal://exit", {
    sessionId: "terminal-3",
    generation: 1,
    code: 130,
    signal: null,
    error: null,
  });
  backend.emit("remote-terminal://exit", {
    sessionId: "terminal-3",
    generation: 2,
    code: 0,
    signal: null,
    error: null,
  });
  backend.emit("remote-terminal://exit", {
    sessionId: "terminal-3",
    generation: 1,
    code: "130",
  });

  assert.deepEqual(data, [{ sessionId: "terminal-3", bytes: [1, 0, 255] }]);
  assert.deepEqual(exits, [
    { sessionId: "terminal-3", code: 130, signal: null, error: null },
  ]);

  unlistenData();
  unlistenExit();
  backend.emit("remote-terminal://data", {
    sessionId: "terminal-3",
    generation: 1,
    dataBase64: "Ag==",
  });
  assert.equal(data.length, 1);
});

test("desktop terminal isolates concurrent local and SSH sessions", async () => {
  const backend = new FakeDesktopBackend();
  const port = new DesktopRemoteTerminalPort(backend.dependencies);
  const events: Array<{ sessionId: string; text: string }> = [];
  const unlisten = await port.onData((event) => {
    events.push({ sessionId: event.sessionId, text: new TextDecoder().decode(event.data) });
  });

  await Promise.all([
    port.start({
      sessionId: "terminal-a",
      executionBinding: LOCAL_BINDING,
      cwd: "C:/projects/ragcode",
      cols: 80,
      rows: 24,
    }),
    port.start({
      sessionId: "terminal-b",
      executionBinding: { ...REMOTE_BINDING, profileId: "staging", hostAlias: "staging" },
      cols: 100,
      rows: 30,
    }),
  ]);

  backend.emit("remote-terminal://data", {
    sessionId: "terminal-a",
    generation: 1,
    dataBase64: "QQ==",
  });
  backend.emit("remote-terminal://data", {
    sessionId: "terminal-b",
    generation: 1,
    dataBase64: "Qg==",
  });
  assert.deepEqual(events, [
    { sessionId: "terminal-a", text: "A" },
    { sessionId: "terminal-b", text: "B" },
  ]);

  await port.stop("terminal-a");
  await assert.rejects(port.write("terminal-a", "closed"), /stopping/);
  await port.resize("terminal-b", 120, 40);

  const resize = backend.calls.at(-1);
  assert.deepEqual(resize, {
    command: "remote_terminal_resize",
    args: { sessionId: "terminal-b", generation: 1, cols: 120, rows: 40 },
  });
  assert.equal(
    backend.calls.filter(
      (call) => call.command === "remote_terminal_stop" && call.args?.sessionId === "terminal-b"
    ).length,
    0,
    "closing one tab must not stop another PTY"
  );

  unlisten();
});

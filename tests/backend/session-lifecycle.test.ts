import assert from "node:assert/strict";
import test from "node:test";

import {
  configureBrowserBackend, resetBackendContainerForTests, type BackendPorts,
} from "../../src/lib/backend/composition/container";
import { getChatStore, clearChatStores, type ChatMessage } from "../../src/lib/pi/chat";
import { getPiStore, resetPiStoreForTests } from "../../src/lib/pi/store";
import { setActiveTaskId } from "../../src/lib/pi/task-context";
import type { SessionRepositoryPort } from "../../src/lib/backend/ports";
import type { PiProcessExit, PiProcessPort } from "../../src/lib/backend/ports/pi-process";
import { readCurrentPiSessionPath } from "../../src/lib/orchestration/session-lifecycle";
import { configurePiClientForTests, resetPiClientForTests } from "../../src/lib/pi/client";
import type { PiCommand, PiState } from "../../src/lib/pi/protocol";
import {
  configureSessionDependenciesForTests,
  peekLatestSessionPath,
  useSessions, flushActiveSession, type ChatSessionMeta,
} from "../../src/lib/pi/sessions";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import type { PiProcessStartOptions } from "../../src/lib/backend/ports/pi-process";
import type { RemotePiProfilePort, RemoteTaskEnsureRequest } from "../../src/lib/backend/ports/remote-profiles";

class StateProcess implements PiProcessPort {
  readonly sent: PiCommand[] = [];
  stopped = false;
  private line: ((line: string) => void) | null = null;

  constructor(private readonly state: PiState, readonly taskId = "default") {}

  async start(): Promise<void> { this.stopped = false; }
  async stop(): Promise<void> { this.stopped = true; }

  onLine(handler: (line: string) => void): () => void {
    this.line = handler;
    return () => { this.line = null; };
  }

  onStderr(_handler: (line: string) => void): () => void {
    return () => undefined;
  }

  onExit(_handler: (exit: PiProcessExit) => void): () => void {
    return () => undefined;
  }

  async send(command: PiCommand): Promise<void> {
    if (this.stopped) throw new Error("Pi is not running");
    this.sent.push(command);
    const request = command as PiCommand & { id?: string };
    queueMicrotask(() => this.line?.(JSON.stringify({
      type: "response",
      command: request.type,
      success: true,
      id: request.id,
      data: request.type === "get_state" ? this.state
        : request.type === "get_available_models" ? { models: [{ id: "test", provider: "test", name: "Test" }] }
        : request.type === "get_entries" ? { entries: [], leafId: null }
        : { commands: [] },
    })));
  }
}

test("session resume selection prefers file, then id, then legacy path", async () => {
  for (const [state, expected] of [
    [{ sessionFile: "file.jsonl", sessionId: "id", sessionPath: "legacy" }, "file.jsonl"],
    [{ sessionId: "id", sessionPath: "legacy" }, "id"],
    [{ sessionPath: "legacy" }, "legacy"],
  ] as Array<[PiState, string]>) {
    configurePiClientForTests(new StateProcess(state));
    assert.equal((await readCurrentPiSessionPath()).path, expected);
  }
  resetPiClientForTests();
});

test("latest-session lookup canonicalizes the project scope", async () => {
  let listedProject = "";
  const repository = {
    list: async (scope: { projectRoot: string }) => {
      listedProject = scope.projectRoot;
      return [{ sessionPath: "latest.jsonl" }];
    },
  } as unknown as SessionRepositoryPort;
  configureSessionDependenciesForTests({
    repository,
    desktopFeatures: true,
    projectRoot: () => "D:/Next",
  });
  assert.equal(await peekLatestSessionPath("D:\\Next\\"), "latest.jsonl");
  assert.equal(listedProject, "D:/Next");
  configureSessionDependenciesForTests(null);
});

test("switching away and back rebuilds the chat client and restores autosave", async () => {
  const processes: StateProcess[] = [];
  const saved = new Map<string, ChatMessage[]>();
  let failSave = false;
  const sessions: ChatSessionMeta[] = ["first", "second"].map((id) => ({
    id, name: id, sessionPath: `${id}.jsonl`, preview: "", projectRoot: "D:/project",
    executionBinding: { kind: "local", targetId: "local" }, createdAt: 1, updatedAt: 1,
  }));
  const repository = {
    list: async () => sessions,
    delete: async () => {},
    load: async (_scope, id) => saved.get(id) ?? [],
    save: async (_scope, session) => {
      if (failSave && session.id === "first") throw new Error("disk unavailable");
      saved.set(session.id, session.messages);
    },
    readNativeTranscript: async (_scope, path) => {
      const id = path.replace(".jsonl", "");
      return [
        { type: "session", version: 3, id, cwd: "D:/project", timestamp: new Date(0).toISOString() },
        ...(saved.get(id) ?? []).filter((message) => message.role === "user").map((message, index) => ({
          type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
          message: { role: "user", content: [{ type: "text", text: message.text }], timestamp: 1 },
        })),
      ].map((entry) => JSON.stringify(entry)).join("\n");
    },
    generateTitle: async () => "",
  } satisfies Partial<SessionRepositoryPort> as unknown as SessionRepositoryPort;
  configureSessionDependenciesForTests({
    repository, desktopFeatures: true, projectRoot: () => "D:/project",
  });
  configureBrowserBackend({
    createPiProcess: (taskId = "default") => {
      const process = new StateProcess({ sessionFile: `${taskId}.jsonl` }, taskId);
      processes.push(process);
      return process;
    },
  } satisfies Partial<BackendPorts> as unknown as BackendPorts);
  useSessions.setState({ sessions, activeId: null, projectRoot: "D:/project" });
  try {
    await useSessions.getState().switchSession("first");
    const original = getChatStore("first");
    await original.getState().send("before switching");
    original.setState({ streaming: false });
    await useSessions.getState().switchSession("second");
    assert.equal(processes[0].stopped, true, "idle process was reclaimed");
    assert.equal(saved.get("first")?.[0].text, "before switching");

    await useSessions.getState().switchSession("first");
    const replacement = getChatStore("first");
    assert.notEqual(replacement, original);
    assert.equal(replacement.getState().messages[0].text, "before switching");
    assert.equal(getPiStore("first").getState().status, "ready");
    await replacement.getState().send("after returning");
    assert.equal(replacement.getState().messages.some((message) => message.isError), false);
    assert.equal(processes.at(-1)?.sent.filter((command) => command.type === "prompt").length, 1);
    await flushActiveSession();
    assert.equal(saved.get("first")?.at(-1)?.text, "after returning", "autosave was reattached");

    // A running task keeps its client/store, even when no longer focused.
    getPiStore("first").setState({ status: "running" });
    await useSessions.getState().switchSession("second");
    assert.equal(getChatStore("first"), replacement);
    await useSessions.getState().switchSession("first");
    getPiStore("first").setState({ status: "ready" });
    replacement.setState({ streaming: false });

    // A failed flush must preserve the only copy of unsaved messages.
    await replacement.getState().send("not persisted yet");
    replacement.setState({ streaming: false });
    failSave = true;
    await useSessions.getState().switchSession("second");
    assert.equal(getChatStore("first"), replacement);
    assert.equal(replacement.getState().messages.at(-1)?.text, "not persisted yet");
    failSave = false;
    await useSessions.getState().switchSession("first");
    await flushActiveSession();
    assert.equal(saved.get("first")?.at(-1)?.text, "not persisted yet");
  } finally {
    failSave = false;
    useSessions.setState({ activeId: null });
    for (const { id } of sessions) await useSessions.getState().deleteSession(id);
    resetPiStoreForTests();
    clearChatStores();
    resetPiClientForTests();
    configureSessionDependenciesForTests(null);
    resetBackendContainerForTests();
    useSessions.setState({ sessions: [], activeId: null });
    setActiveTaskId("default");
  }
});

test("new remote sessions mint their own task without changing historical task bindings", async () => {
  for (const remoteTaskPending of [false, true]) {
    const binding: ExecutionBinding = {
      kind: "ssh", profileId: "remote-build", profileRevision: 1, hostAlias: "build-host",
      remoteCwd: "/srv/app", launcherProtocolVersion: 1,
      remoteTaskId: "t-old-history", remoteTaskPending,
    };
    const history: ChatSessionMeta = {
      id: "history", name: "Previous conversation", sessionPath: "history.jsonl", preview: "old prompt",
      projectRoot: "ssh:remote-build:app", executionBinding: binding, createdAt: 1, updatedAt: 1,
    };
    const oldMessages: ChatMessage[] = [{
      id: "old-user", role: "user", text: "old prompt", thinking: "", tools: [], streaming: false,
    }];
    const saved = new Map<string, ChatMessage[]>([[history.id, oldMessages]]);
    const persistedBindings = new Map<string, ExecutionBinding>([[history.id, binding]]);
    const starts: Array<{ taskId: string; options: PiProcessStartOptions }> = [];
    const ensured: RemoteTaskEnsureRequest[] = [];
    const statusRequests: string[] = [];
    const repository = {
      load: async (_scope, id) => saved.get(id) ?? [],
      save: async (_scope, session) => {
        saved.set(session.id, session.messages);
        if (session.executionBinding) persistedBindings.set(session.id, session.executionBinding);
      },
      delete: async () => {},
    } satisfies Partial<SessionRepositoryPort> as unknown as SessionRepositoryPort;
    const remoteProfiles = {
      list: async () => [{ id: binding.profileId, lifecycle: "detached" }],
      taskStatus: async (_profileId: string, remoteTaskId: string) => {
        statusRequests.push(remoteTaskId);
        return { exists: true, state: "running" };
      },
      ensureTask: async (request: RemoteTaskEnsureRequest) => {
        ensured.push(request);
        const pending = [...persistedBindings.values()].find((item) =>
          item.kind === "ssh" && item.remoteTaskId === request.remoteTaskId && item.remoteTaskPending,
        );
        assert.ok(pending, "remote start follows a durable write-ahead binding");
        return { remoteTaskId: request.remoteTaskId, state: "running", started: true };
      },
    } as unknown as RemotePiProfilePort;
    configureSessionDependenciesForTests({
      repository, desktopFeatures: true, projectRoot: () => history.projectRoot,
    });
    configureBrowserBackend({
      remoteProfiles,
      createPiProcess: (taskId = "default") => new class extends StateProcess {
        override async start(options: PiProcessStartOptions = {}): Promise<void> {
          starts.push({ taskId, options });
          await super.start();
        }
      }({ sessionFile: `${taskId}.jsonl` }, taskId),
    } satisfies Partial<BackendPorts> as unknown as BackendPorts);
    useSessions.setState({
      sessions: [history], activeId: null, projectRoot: history.projectRoot,
      executionBinding: { kind: "local", targetId: "local" },
    });
    try {
      await useSessions.getState().switchSession(history.id);
      assert.deepEqual(getChatStore(history.id).getState().messages, oldMessages);
      const oldEnsureCount = ensured.length;
      const oldStatusCount = statusRequests.length;
      useSessions.getState().setExecutionBinding(binding);
      await useSessions.getState().newSession();
      const newId = useSessions.getState().activeId!;
      assert.notEqual(newId, history.id);
      const created = useSessions.getState().sessions.find((session) => session.id === newId)!;
      assert.equal(created.executionBinding?.kind, "ssh");
      const fresh = created.executionBinding as Extract<ExecutionBinding, { kind: "ssh" }>;
      assert.notEqual(fresh.remoteTaskId, binding.remoteTaskId);
      assert.ok(fresh.remoteTaskId);
      assert.equal(fresh.remoteTaskPending, false);
      assert.deepEqual(fresh, { ...binding, remoteTaskId: fresh.remoteTaskId, remoteTaskPending: false });
      assert.equal(ensured.length, oldEnsureCount + 1, "new session must start a distinct remote task");
      assert.equal(statusRequests.length, oldStatusCount, "new session must not probe the old task for reattach");
      assert.equal(starts.at(-1)?.taskId, newId);
      assert.deepEqual(starts.at(-1)?.options.executionBinding, fresh);
      assert.equal(starts.at(-1)?.options.resumePath, undefined);
      assert.deepEqual(getChatStore(newId).getState().messages, []);
      assert.deepEqual(saved.get(history.id), oldMessages);
      const oldBinding = useSessions.getState().sessions.find((session) => session.id === history.id)!.executionBinding;
      assert.deepEqual(oldBinding, { ...binding, remoteTaskPending: false });
      await useSessions.getState().switchSession(history.id);
      assert.equal(useSessions.getState().activeId, history.id);
      assert.deepEqual(useSessions.getState().executionBinding, oldBinding);
      assert.deepEqual(getChatStore(history.id).getState().messages, oldMessages);
    } finally {
      useSessions.setState({ activeId: null });
      for (const { id } of [...useSessions.getState().sessions]) await useSessions.getState().deleteSession(id);
      resetPiStoreForTests();
      clearChatStores();
      resetPiClientForTests();
      configureSessionDependenciesForTests(null);
      resetBackendContainerForTests();
      useSessions.setState({ sessions: [], activeId: null, executionBinding: { kind: "local", targetId: "local" } });
      setActiveTaskId("default");
    }
  }
});

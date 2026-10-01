import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopRemoteMcpConfiguration } from "../../src/lib/backend/desktop/mcp-configuration";
import { RemotePiManagementUnavailableError } from "../../src/lib/backend/desktop/remote-pi-management";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import type { McpInspectionDto } from "../../src/lib/backend/ports/mcp-configuration";
import { createMcpStore } from "../../src/lib/pi/mcp";

const binding: Extract<ExecutionBinding, { kind: "ssh" }> = {
  kind: "ssh", profileId: "host-a", profileRevision: 7,
  hostAlias: "remote-a", remoteCwd: "/remote/project-a", launcherProtocolVersion: 1,
};
const snapshot = (name: string): McpInspectionDto => ({
  agentDirectory: "/remote/.pi/agent", adapterRegistered: true, adapterPackagePresent: true,
  runtimeStatus: "unverified", sources: [{ path: "/remote/.pi/agent/mcp.json", exists: true, error: null,
    servers: [{ name, enabled: true }] }],
});
const token = (version: number) => version.toString(16).padStart(64, "0");

test("SSH MCP port binds editor operations, carries snapshot tokens and never falls back to local management", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const file = { path: "/remote/.pi/agent/mcp.json", exists: true, content: "{}", stateToken: token(1) };
  const port = createDesktopRemoteMcpConfiguration(binding, {
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      const request = args!.request as Record<string, unknown>;
      if (request.expectedState === "conflict") return { ok: false, errorCode: "configurationChanged", detail: "secret-never-displayed" } as T;
      const result = request.operation === "inspectMcp" ? snapshot("remote-only")
        : request.operation === "discoverMcpSources" ? [] : file;
      return { ok: true, operation: request.operation, result } as T;
    },
  });
  assert.deepEqual(await port.inspectStatus!(), snapshot("remote-only"));
  const loaded = await port.readMcpConfig("global");
  await port.writeMcpConfig("global", '{"mcpServers":{}}', loaded.stateToken);
  assert.deepEqual(await port.discoverMcpSources(), []);
  assert.equal((await port.checkMcpAdapter()).installed, true);
  assert.deepEqual(calls.map((call) => call.args!.request), [
    { operation: "inspectMcp" }, { operation: "readMcpConfig", scope: "global" },
    { operation: "writeMcpConfig", scope: "global", expectedState: token(1), content: '{"mcpServers":{}}' },
    { operation: "discoverMcpSources" }, { operation: "inspectMcp" },
  ]);
  for (const call of calls) {
    assert.equal(call.command, "remote_pi_management_request");
    assert.equal(call.args!.id, binding.profileId);
    assert.equal(call.args!.profileRevision, binding.profileRevision);
    assert.equal(call.args!.remoteCwd, binding.remoteCwd);
  }
  const count = calls.length;
  await assert.rejects(() => port.writeMcpConfig("project", "{}"), /Load the remote configuration/);
  await assert.rejects(() => port.installAdapter(), /remote host/);
  await assert.rejects(() => port.openMcpConfigDirectory("global"), /local file manager/);
  assert.equal(calls.length, count);
  await assert.rejects(() => port.writeMcpConfig("global", "{}", "conflict"), (error: Error) => {
    assert.match(error.message, /Remote configuration changed/);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  const outdated = createDesktopRemoteMcpConfiguration(binding, {
    invoke: async () => { throw new Error("launcher-upgrade-required: pi-mcp-config-read-v1"); },
  });
  await assert.rejects(() => outdated.inspectStatus!(), RemotePiManagementUnavailableError);
  await assert.rejects(() => outdated.readMcpConfig("global"), /Update the remote launcher/);
});

test("bound MCP store preserves custom fields, serializes edits and keeps tokens attached to displayed content", async () => {
  let content = JSON.stringify({ mcpServers: { docs: { command: "original", custom: { keep: true } } }, extra: "keep" });
  let version = 1;
  let failProjectRead = false;
  const writes: Record<string, unknown>[] = [];
  const dirty: string[] = [];
  const port = createDesktopRemoteMcpConfiguration(binding, {
    invoke: async <T>(_command: string, args?: Record<string, unknown>) => {
      const request = args!.request as Record<string, unknown>;
      if (request.operation === "inspectMcp") return { ok: true, result: snapshot("docs") } as T;
      if (request.operation === "discoverMcpSources") return { ok: true, result: [{ id: "source", path: "/remote/.mcp.json",
        label: "Remote source", scope: "project", format: "json", supported: true, reason: null,
        content: '{"mcpServers":{"imported":{"url":"https://example.test/mcp"}}}' }] } as T;
      if (request.scope === "project" && failProjectRead) throw new Error("launcher-upgrade-required");
      if (request.operation === "writeMcpConfig") {
        writes.push(request);
        if (request.expectedState !== token(version)) return { ok: false, errorCode: "configurationChanged" } as T;
        content = request.content as string;
        version++;
      }
      return { ok: true, result: { path: request.scope === "global" ? "/remote/.pi/agent/mcp.json" : "/remote/project-a/.pi/mcp.json",
        exists: true, content: request.scope === "global" ? content : "{}", stateToken: token(version) } } as T;
    },
  });
  const store = createMcpStore(port, (scope) => dirty.push(scope));
  await store.getState().upsertServer("global", "too-early", { command: "never" });
  assert.equal(writes.length, 0);
  await store.getState().load();
  const write = store.getState().upsertServer("global", "__proto__", { command: "safe-name" });
  await store.getState().load(); // refresh cannot replace the displayed snapshot during a write
  await write;
  assert.equal(store.getState().global.data!.mcpServers!.__proto__.command, "safe-name");
  assert.equal(store.getState().global.data!.extra, "keep");
  await store.getState().upsertServer("global", "added", { command: "node", env: { KEY: "remote-secret" } });
  await store.getState().setDisabled("global", "docs", true);
  assert.equal(store.getState().global.data!.mcpServers!.docs.disabled, true);
  assert.deepEqual(store.getState().global.data!.mcpServers!.docs.custom, { keep: true });
  await store.getState().setDisabled("global", "docs", false);
  assert.equal(store.getState().global.data!.mcpServers!.docs.disabled, undefined);
  await store.getState().upsertServer("global", "renamed-docs", { ...store.getState().global.data!.mcpServers!.docs, command: "edited" }, "docs");
  assert.equal(store.getState().global.data!.mcpServers!.docs, undefined);
  assert.equal(store.getState().global.data!.mcpServers!["renamed-docs"].command, "edited");
  assert.deepEqual(store.getState().global.data!.mcpServers!["renamed-docs"].custom, { keep: true });
  await store.getState().removeServer("global", "added");
  assert.equal(store.getState().global.data!.mcpServers!.added, undefined);
  await store.getState().discoverSources();
  await store.getState().importSource("global", "source", "skip", ["imported"]);
  assert.equal(store.getState().global.data!.mcpServers!.imported.url, "https://example.test/mcp");
  await store.getState().setRaw("global", '{"mcpServers":{"raw":{"command":"custom"}},"custom":42}');
  assert.equal(store.getState().global.data!.custom, 42);
  assert.equal(store.getState().remote, true);
  assert.equal(store.getState().dirtyRestart, true);
  assert.equal(dirty.length, writes.length);
  const displayedToken = store.getState().global.stateToken;
  content = '{"mcpServers":{"external":{"command":"newer"}}}';
  version++;
  failProjectRead = true;
  await store.getState().load(); // global read succeeds, project read fails
  assert.equal(store.getState().global.stateToken, displayedToken, "partial refresh must not pair a new token with old content");
  const beforeDirty = dirty.length;
  await store.getState().upsertServer("global", "stale", { command: "must-not-write" });
  assert.match(store.getState().lastError!, /Remote configuration changed/);
  assert.equal(writes.at(-1)!.expectedState, displayedToken);
  assert.ok(!content.includes("stale"));
  assert.equal(dirty.length, beforeDirty);
  failProjectRead = false;
  content = "{broken";
  version++;
  await store.getState().load();
  assert.ok(store.getState().global.parseError);
  const beforeRepair = writes.length;
  await store.getState().upsertServer("global", "lost-data", { command: "never" });
  assert.equal(writes.length, beforeRepair, "structured edits must not replace malformed configuration");
  await store.getState().setRaw("global", '{"mcpServers":{}}');
  assert.equal(store.getState().global.parseError, null);
  assert.equal(store.getState().global.stateToken, token(version));
  const failedInitial = createMcpStore(createDesktopRemoteMcpConfiguration(binding, {
    invoke: async () => { throw new Error("launcher-upgrade-required"); },
  }));
  await failedInitial.getState().load();
  assert.equal(failedInitial.getState().loaded, false);
});

test("SSH MCP reuses the existing editor design, isolates old reads/saves and marks the original target dirty", async () => {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  const [{ render, waitFor, act, fireEvent, cleanup }, React, browser, container, sessions, mcp, management, page] = await Promise.all([
    import("@testing-library/react"), import("react"),
    import("../../src/lib/backend/composition/browser"), import("../../src/lib/backend/composition/container"),
    import("../../src/lib/pi/sessions"), import("../../src/lib/pi/mcp"), import("../../src/lib/pi/management"), import("../../src/app/mcp/page"),
  ]);
  const originalSessions = sessions.useSessions.getState();
  const originalMcp = mcp.useMcp.getState();
  const originalManagement = management.usePiManagement.getState();
  let localCalls = 0;
  const finishOld: (() => void)[] = [];
  let finishSave!: () => void;
  let failNext = false;
  let deferSave = false;
  const writes: { target: typeof binding; request: Record<string, unknown> }[] = [];
  const dirty: { scope: string; cwd: string }[] = [];
  const ports = browser.createBrowserBackendPorts();
  const preview = ports.createMcpConfiguration(binding);
  await assert.rejects(() => preview.readMcpConfig("global"), /remote-mcp-unavailable-in-preview/);
  ports.createMcpConfiguration = (target) => {
    assert.equal(target.kind, "ssh");
    return createDesktopRemoteMcpConfiguration(target, { invoke: async <T>(_command: string, args?: Record<string, unknown>) => {
      const request = args!.request as Record<string, unknown>;
      if (failNext) throw new Error("launcher-upgrade-required: pi-mcp-config-read-v1");
      if (request.operation === "inspectMcp") return { ok: true, result: snapshot("remote") } as T;
      const name = target.remoteCwd.endsWith("project-c") ? "server-c" : target.profileId === binding.profileId ? "stale-server-a" : "server-b";
      const file = { path: `${target.remoteCwd}/.pi/mcp.json`, exists: true, stateToken: token(1),
        content: JSON.stringify({ mcpServers: request.scope === "global" ? { [name]: { command: "node" } } : {} }) };
      if (request.operation === "writeMcpConfig") {
        writes.push({ target, request });
        const response = { ok: true, result: { ...file, content: request.content, stateToken: token(2) } } as T;
        if (deferSave) return new Promise<T>((resolve) => { finishSave = () => resolve(response); });
        return response;
      }
      if (target.profileId === binding.profileId) return new Promise<T>((resolve) => { finishOld.push(() => resolve({ ok: true, result: file } as T)); });
      return { ok: true, result: file } as T;
    } });
  };
  container.configureBrowserBackend(ports);
  sessions.useSessions.setState({ executionBinding: binding });
  mcp.useMcp.setState({ loaded: false, load: async () => { localCalls++; } });
  management.usePiManagement.setState({ markDirty: (scope, context) => { dirty.push({ scope, cwd: context!.binding.kind === "ssh" ? context!.binding.remoteCwd : "local" }); } });
  try {
    const view = render(React.createElement(page.default));
    await waitFor(() => assert.equal(finishOld.length, 2));
    assert.match(view.container.textContent ?? "", /remote-a/);
    const targetB = { ...binding, profileId: "host-b", hostAlias: "remote-b", remoteCwd: "/remote/project-b" };
    await act(async () => sessions.useSessions.setState({ executionBinding: targetB }));
    await waitFor(() => assert.ok(view.getByText("server-b")));
    await act(async () => finishOld.forEach((finish) => finish()));
    assert.equal(view.queryByText("stale-server-a"), null);
    assert.match(view.container.textContent ?? "", /remote-b/);
    assert.ok(view.getByRole("button", { name: "Add server" }), "the original form editor remains available");
    assert.equal((view.getByRole("button", { name: /Open config folder/ }) as HTMLButtonElement).disabled, true);
    assert.match(view.container.textContent ?? "", /do not verify extension loading or live connections/);
    assert.ok(view.container.querySelector("h1")?.style.fontFamily, "original page shell is retained");
    fireEvent.click(view.getByRole("button", { name: "Edit server" }));
    assert.equal((view.getByLabelText("Server name") as HTMLInputElement).value, "server-b");
    assert.equal((view.getByLabelText("Command") as HTMLInputElement).value, "node");
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    fireEvent.click(view.getByRole("button", { name: /Edit raw JSON/ }));
    assert.equal((view.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(view.getByRole("button", { name: "Project" }));
    assert.equal(view.queryByRole("textbox"), null, "scope switches cannot save an old editor into a different file");
    fireEvent.click(view.getByRole("button", { name: "Global" }));
    fireEvent.click(view.getByRole("button", { name: /Edit raw JSON/ }));
    fireEvent.change(view.getByRole("textbox"), { target: { value: '{"mcpServers":{"saved-b":{"command":"node","env":{"SECRET":"remote-only"}}}}' } });
    deferSave = true;
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => assert.equal(writes.length, 1));
    assert.equal(writes[0].target.remoteCwd, targetB.remoteCwd);
    assert.equal(writes[0].request.scope, "global");
    assert.equal(writes[0].request.expectedState, token(1));
    await act(async () => sessions.useSessions.setState({ executionBinding: { ...targetB, remoteCwd: "/remote/project-c" } }));
    await waitFor(() => assert.ok(view.getByText("server-c")));
    await act(async () => finishSave());
    assert.equal(view.queryByText("saved-b"), null);
    assert.equal(view.queryByRole("textbox"), null, "old raw JSON and secrets are unmounted on a target switch");
    assert.deepEqual(dirty, [{ scope: "global", cwd: "/remote/project-b" }]);
    failNext = true;
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => assert.match(view.getByRole("alert").textContent ?? "", /Update the remote launcher/));
    assert.equal(localCalls, 0);
    assert.equal(mcp.useMcp.getState().global, originalMcp.global);
  } finally {
    cleanup();
    sessions.useSessions.setState(originalSessions, true);
    mcp.useMcp.setState(originalMcp, true);
    management.usePiManagement.setState(originalManagement, true);
    container.resetBackendContainerForTests();
    await GlobalRegistrator.unregister();
  }
});

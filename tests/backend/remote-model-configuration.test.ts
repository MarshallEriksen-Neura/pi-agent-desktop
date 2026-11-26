import assert from "node:assert/strict";
import test from "node:test";
import { remoteEnabledModels, remoteModelChanges, type RemoteModelSnapshot } from "../../src/lib/backend/ports/model-configuration";
import { configureBrowserBackend, resetBackendContainerForTests, type BackendPorts } from "../../src/lib/backend/composition/container";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import { usePiModels } from "../../src/lib/pi/models";
import { usePiManagement } from "../../src/lib/pi/management";

test("remoteModelChanges emits only editable provider and model fields", () => {
  const before = { providers: {
    openai: {
      baseUrl: "https://old.example/v1",
      api: "openai-completions",
      apiKey: "remote-secret",
      headers: { Authorization: "Bearer hidden" },
      models: [{ id: "old", name: "Old", contextWindow: 1024, extra: "preserve" }],
    },
  } };
  const after = { providers: {
    openai: {
      baseUrl: "https://new.example/v1",
      api: "openai-responses",
      apiKey: "local-secret-must-not-cross",
      headers: { Authorization: "Bearer changed" },
      models: [{ id: "new", name: "New", maxTokens: 2048, extra: "drop-from-patch" }],
    },
  } };

  assert.deepEqual(remoteModelChanges(before, after), [
    { kind: "provider.edit", providerId: "openai", baseUrl: "https://new.example/v1", api: "openai-responses" },
    { kind: "model.remove", providerId: "openai", modelId: "old" },
    { kind: "model.edit", providerId: "openai", modelId: "new", fields: {
      name: "New", reasoning: null, thinkingLevelMap: null, input: null, contextWindow: null, maxTokens: 2048,
    } },
  ]);
});

test("remote chat selection follows project settings and the active agent directory", () => {
  const global = ["global/model"];
  const project = ["project/model"];
  const snapshot: RemoteModelSnapshot = {
    scope: "global", stateToken: "initial", data: { providers: {} },
    enabledModels: { global, project: null },
  };
  assert.deepEqual(remoteEnabledModels(snapshot), global);
  assert.deepEqual(remoteEnabledModels({ ...snapshot, enabledModels: { global, project } }), project);
  assert.equal(remoteEnabledModels({ ...snapshot, projectAgent: { enabledModels: null } }), null);
  assert.deepEqual(remoteEnabledModels({ ...snapshot, projectAgent: { enabledModels: project } }), project);
  assert.deepEqual(remoteEnabledModels({ ...snapshot, enabledModels: { global, project: [] } }), []);
});

test("SSH model selections update immediately, coalesce and roll back to the last saved list", async () => {
  const binding: ExecutionBinding = {
    kind: "ssh", profileId: "test", profileRevision: 1, hostAlias: "test",
    remoteCwd: "/project", launcherProtocolVersion: 1,
  };
  let snapshot: RemoteModelSnapshot = {
    scope: "project", stateToken: "initial", data: { providers: {} },
    enabledModels: { global: null, project: null },
  };
  const writes: Array<{ token: string; models: string[] }> = [];
  let releaseFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  const previousModels = usePiModels.getState();
  const previousManagement = usePiManagement.getState();
  usePiManagement.setState({ markDirty: () => {} });
  configureBrowserBackend({
    createPiManagement: () => ({}),
    createModelConfiguration: () => ({
      kind: "ssh",
      port: {
        read: async () => snapshot,
        setEnabled: async (_scope: string, token: string, models: string[]) => {
          writes.push({ token, models });
          if (writes.length === 1) await firstWrite;
          if (writes.length === 3) throw new Error("configurationChanged");
          snapshot = { ...snapshot, stateToken: String(writes.length),
            enabledModels: { global: null, project: models } };
          return snapshot;
        },
      },
    }),
  } as unknown as BackendPorts);

  try {
    await usePiModels.getState().load(binding, "project");
    const { setRemoteEnabledModels } = usePiModels.getState();
    const first = setRemoteEnabledModels("project", ["p/a"]);
    await Promise.resolve();
    assert.equal(writes.length, 1);
    const second = setRemoteEnabledModels("project", ["p/a", "p/b"]);
    const third = setRemoteEnabledModels("project", ["p/b"]);
    assert.deepEqual(usePiModels.getState().pendingEnabledModels?.models, ["p/b"]);
    assert.equal(usePiModels.getState().busy, false);
    assert.equal(writes.length, 1);

    releaseFirstWrite();
    await Promise.all([first, second, third]);
    assert.deepEqual(writes, [
      { token: "initial", models: ["p/a"] },
      { token: "1", models: ["p/b"] },
    ]);
    assert.deepEqual(usePiModels.getState().remoteSnapshot?.enabledModels.project, ["p/b"]);

    await setRemoteEnabledModels("project", []);
    assert.equal(usePiModels.getState().pendingEnabledModels, null);
    assert.deepEqual(usePiModels.getState().remoteSnapshot?.enabledModels.project, ["p/b"]);
    assert.match(usePiModels.getState().lastError ?? "", /configurationChanged/);
  } finally {
    releaseFirstWrite();
    usePiModels.setState(previousModels, true);
    usePiManagement.setState(previousManagement, true);
    resetBackendContainerForTests();
  }
});

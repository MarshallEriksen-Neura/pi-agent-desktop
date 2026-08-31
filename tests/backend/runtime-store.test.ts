import assert from "node:assert/strict";
import test from "node:test";
import {
  configureBrowserBackend,
  resetBackendContainerForTests,
  type BackendPorts,
} from "../../src/lib/backend/composition/container";
import type { RuntimeConfigPort } from "../../src/lib/backend/ports/runtime-config";
import type { RemoteControlPort } from "../../src/lib/backend/ports/remote-control";
import type { RemoteConversationsPort } from "../../src/lib/backend/ports/remote-conversations";
import type { RemotePiProfilePort } from "../../src/lib/backend/ports/remote-profiles";
import type { RemoteProviderSyncPort } from "../../src/lib/backend/ports/remote-provider-sync";
import { resetRuntimeStoreForTests, useRuntime } from "../../src/lib/pi/runtime";
import { unreachablePort } from "./fixtures/unreachable-port";

function ports(runtimeConfig: RuntimeConfigPort): BackendPorts {
  return {
    piProcess: {
      taskId: "default",
      start: async () => undefined,
      send: async () => undefined,
      stop: async () => undefined,
      onLine: () => () => undefined,
      onStderr: () => () => undefined,
      onExit: () => () => undefined,
    },
    createPiProcess: () => ({
      taskId: "default",
      start: async () => undefined,
      send: async () => undefined,
      stop: async () => undefined,
      onLine: () => () => undefined,
      onStderr: () => () => undefined,
      onExit: () => () => undefined,
    }),
    sessionRepository: {
      list: async () => [],
      load: async () => [],
      save: async () => undefined,
      rename: async () => undefined,
      delete: async () => undefined,
      generateTitle: async () => "",
    },
    workspaceFs: {
      root: async () => "",
      listDir: async () => [],
      readFile: async () => "",
      readFileBase64: async () => "",
      writeFile: async () => undefined,
      createFile: async () => undefined,
      createDir: async () => undefined,
      deleteEntry: async () => undefined,
      renameEntry: async () => undefined,
    },
    projectCatalog: {
      resolve: async (path) => path,
      commit: async (path) => path,
      pick: async () => null,
      listRecent: async () => [],
      removeRecent: async () => [],
    },
    providerAuth: {
      listProviders: async () => [],
      beginLogin: async () => undefined,
      answerPrompt: async () => undefined,
      cancelLogin: async () => undefined,
      logout: async () => undefined,
      onEvent: () => () => undefined,
    },
    runtimeConfig,
    piConfiguration: {
      readSettings: async () => ({ path: "", exists: false, content: "" }),
      writeSettings: async () => undefined,
      readMcpConfig: async () => ({ path: "", exists: false, content: "" }),
      writeMcpConfig: async () => undefined,
      openMcpConfigDirectory: async () => undefined,
      checkMcpAdapter: async () => ({ installed: false, otherConfigPaths: [] }),
      discoverMcpSources: async () => [],
      fetchModels: async () => [],
      runPiCli: async () => ({ code: 0, stdout: "", stderr: "" }),
      runSkillsCli: async () => ({ code: 0, stdout: "", stderr: "" }),
      searchSkills: async () => [],
      checkPiCliUpdate: async () => ({
        installed: null,
        latest: null,
        updateAvailable: false,
      }),
      readSkillFile: async () => "",
      listSkillDirectory: async () => [],
    },
    window: {
      close: async () => undefined,
      quit: async () => undefined,
      focus: async () => undefined,
      setFocus: async () => undefined,
      show: async () => undefined,
      hide: async () => undefined,
      minimize: async () => undefined,
      unminimize: async () => undefined,
      toggleMaximize: async () => undefined,
      isMaximized: async () => false,
      isVisible: async () => true,
      isMinimized: async () => false,
      startDragging: async () => undefined,
      setTitle: async () => undefined,
      confirm: async () => true,
      onCloseRequested: async () => () => undefined,
      onEvent: async () => () => undefined,
      emit: async () => undefined,
    },
    notification: {
      requestPermission: async () => false,
      getPermission: () => "unsupported",
      refreshPermission: async () => "unsupported",
      show: () => undefined,
    },
    updater: {
      getCurrentVersion: async () => "0.0.0",
      check: async () => ({
        configured: false,
        repoUrl: "",
        currentVersion: "0.0.0",
        latestVersion: null,
        latestCommit: null,
        updateAvailable: false,
      }),
      downloadAndInstall: async () => undefined,
      relaunch: async () => undefined,
    },
    assetUrl: {
      convertFileSrc: (path) => path,
    },
    petWindow: {
      prewarm: async () => undefined,
      show: async () => undefined,
      hide: async () => undefined,
      toggle: async () => false,
      setPosition: async () => undefined,
      listCustomPets: async () => [],
      onStateUpdate: async () => () => undefined,
      onConfigUpdate: async () => () => undefined,
      onWindowReady: async () => () => undefined,
      onRestoreMain: async () => () => undefined,
      emitStateUpdate: async () => undefined,
      emitConfigUpdate: async () => undefined,
      emitWindowReady: async () => undefined,
      emitRestoreMain: async () => undefined,
    },
    externalNavigation: {
      open: async () => undefined,
      openHtmlFile: async () => undefined,
    },
    // this test only drives runtimeConfig — see fixtures/unreachable-port
    remoteControl: unreachablePort<RemoteControlPort>("remoteControl"),
    remoteConversations: unreachablePort<RemoteConversationsPort>("remoteConversations"),
    remoteProfiles: unreachablePort<RemotePiProfilePort>("remoteProfiles"),
    remoteProviderSync: unreachablePort<RemoteProviderSyncPort>("remoteProviderSync"),
  };
}

test("runtime store loads, saves, and lists distros through the injected port", async () => {
  resetBackendContainerForTests();
  resetRuntimeStoreForTests();

  const writes: unknown[] = [];
  configureBrowserBackend(
    ports({
      read: async () => ({ mode: "wsl", distro: "Ubuntu-24.04" }),
      write: async (config) => {
        writes.push(config);
      },
      listWslDistros: async () => ["Ubuntu-24.04"],
      validateWsl: async () => ({ ok: true }),
      getWslBridgePath: async () => "",
    })
  );

  await useRuntime.getState().load();
  assert.deepEqual(useRuntime.getState().persistedConfig, {
    mode: "wsl",
    distro: "Ubuntu-24.04",
  });

  await useRuntime.getState().loadDistros();
  assert.deepEqual(useRuntime.getState().distros, ["Ubuntu-24.04"]);

  await useRuntime.getState().save({ mode: "native", distro: "" });
  assert.deepEqual(writes, [{ mode: "native", distro: "" }]);
  assert.equal(useRuntime.getState().busy, false);
  assert.deepEqual(useRuntime.getState().persistedConfig, { mode: "native", distro: "" });
});

test("runtime store preserves failure semantics from the port", async () => {
  resetBackendContainerForTests();
  resetRuntimeStoreForTests();
  configureBrowserBackend(
    ports({
      read: async () => ({ mode: "native", distro: "" }),
      write: async () => {
        throw new Error("disk denied");
      },
      listWslDistros: async () => [],
      validateWsl: async () => ({ ok: true }),
      getWslBridgePath: async () => "",
    })
  );

  await assert.rejects(
    () => useRuntime.getState().save({ mode: "wsl", distro: "Ubuntu" }),
    /disk denied/
  );
  assert.equal(useRuntime.getState().lastError, "disk denied");
  assert.equal(useRuntime.getState().busy, false);
});

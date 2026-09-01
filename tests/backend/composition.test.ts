import assert from "node:assert/strict";
import test from "node:test";
import {
  BackendContainerError,
  configureBrowserBackend,
  configureDesktopBackend,
  getBackendKind,
  getPort,
  resetBackendContainerForTests,
  type BackendPorts,
} from "../../src/lib/backend/composition/container";
import {
  DesktopInvokeError,
  normalizeDesktopInvokeError,
} from "../../src/lib/backend/desktop/invoke";
import type { RemoteControlPort } from "../../src/lib/backend/ports/remote-control";
import type { RemoteConversationsPort } from "../../src/lib/backend/ports/remote-conversations";
import type { RemotePiProfilePort } from "../../src/lib/backend/ports/remote-profiles";
import type { RemoteProviderSyncPort } from "../../src/lib/backend/ports/remote-provider-sync";
import type { RemoteTerminalPort } from "../../src/lib/backend/ports/remote-terminal";
import { unreachablePort } from "./fixtures/unreachable-port";
import type { WorkspaceFsPort } from "../../src/lib/backend/ports/workspace-fs";
import { createUnsupportedRemoteWorkspaceFsPort } from "../../src/lib/backend/ports/remote-workspace-fs";

const workspaceFs = (label: string): WorkspaceFsPort => ({
  root: async () => label,
  listDir: async () => [],
  readFile: async () => "",
  readFileBase64: async () => "",
  writeFile: async () => undefined,
  createFile: async () => undefined,
  createDir: async () => undefined,
  deleteEntry: async () => undefined,
  renameEntry: async () => undefined,
});

function fakePorts(label = "fake"): BackendPorts {
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
      generateTitle: async () => label,
    },
    workspaceFs: workspaceFs(label),
    // Mirrors the real compositions: a remote target must not resolve to the
    // local port, or this fixture would hide the property the refactor adds.
    createWorkspaceFs: (targetId) =>
      targetId && targetId !== "local"
        ? createUnsupportedRemoteWorkspaceFsPort(targetId)
        : workspaceFs(label),
    projectCatalog: {
      resolve: async (path) => path,
      commit: async (path) => path,
      pick: async () => null,
      listRecent: async () => [],
      removeRecent: async () => [],
      commitRemote: async () => [],
      browse: async () => ({ path: "/", entries: [] }),
    },
    providerAuth: {
      listProviders: async () => [],
      beginLogin: async () => undefined,
      answerPrompt: async () => undefined,
      cancelLogin: async () => undefined,
      logout: async () => undefined,
      onEvent: () => () => undefined,
    },
    runtimeConfig: {
      read: async () => ({ mode: "native", distro: "" }),
      write: async () => undefined,
      listWslDistros: async () => [],
      validateWsl: async () => ({ ok: true }),
      getWslBridgePath: async () => "",
    },
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
    fileDrop: {
      onDrag: async () => () => undefined,
    },
    /* The LAN gateway has no place in container wiring tests, and no test in
       this suite reaches either port. Rejecting rather than returning empty
       snapshots keeps that true: a stub that answers plausibly would let a
       future test pass against a fake that proves nothing. */
    remoteControl: unreachablePort<RemoteControlPort>("remoteControl"),
    remoteConversations: unreachablePort<RemoteConversationsPort>("remoteConversations"),
    remoteProfiles: unreachablePort<RemotePiProfilePort>("remoteProfiles"),
    remoteProviderSync: unreachablePort<RemoteProviderSyncPort>("remoteProviderSync"),
    remoteTerminal: unreachablePort<RemoteTerminalPort>("remoteTerminal"),
  } satisfies BackendPorts;
}

test("container fails closed before configuration", () => {
  resetBackendContainerForTests();
  assert.equal(getBackendKind(), "unconfigured");
  assert.throws(
    () => getPort("piProcess"),
    (error) =>
      error instanceof BackendContainerError &&
      error.code === "unconfigured" &&
      error.portName === "piProcess"
  );
});

test("desktop and browser configuration expose independently named ports", async () => {
  resetBackendContainerForTests();
  configureDesktopBackend(fakePorts("desktop"));
  assert.equal(getBackendKind(), "desktop-tauri");
  assert.equal(await getPort("workspaceFs").root(), "desktop");

  resetBackendContainerForTests();
  configureBrowserBackend(fakePorts("browser"));
  assert.equal(getBackendKind(), "browser-preview");
  assert.equal(await getPort("sessionRepository").generateTitle({
    prompt: "",
    provider: null,
    modelId: null,
    cwd: null,
  }), "browser");
});

test("container rejects duplicate configuration until explicit reset", () => {
  resetBackendContainerForTests();
  configureBrowserBackend(fakePorts());
  assert.throws(
    () => configureDesktopBackend(fakePorts()),
    (error) =>
      error instanceof BackendContainerError &&
      error.code === "already-configured" &&
      error.backendKind === "browser-preview"
  );
});

test("desktop invoke errors preserve command and classify common failures", () => {
  const denied = normalizeDesktopInvokeError(
    "dialog",
    new Error("dialog.confirm not allowed. Command not found")
  );
  assert.ok(denied instanceof DesktopInvokeError);
  assert.equal(denied.command, "dialog");
  assert.equal(denied.kind, "permission-denied");

  const args = normalizeDesktopInvokeError("runtime_config_write", "invalid args: missing config");
  assert.equal(args.kind, "invalid-args");
});

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

function fakePorts(label = "fake"): BackendPorts {
  return {
    piProcess: {
      start: async () => undefined,
      send: async () => undefined,
      stop: async () => undefined,
      onLine: () => () => undefined,
      onStderr: () => () => undefined,
      onExit: () => () => undefined,
    },
    sessionRepository: {
      list: async () => [],
      load: async () => [],
      save: async () => undefined,
      rename: async () => undefined,
      delete: async () => undefined,
      generateTitle: async () => label,
    },
    workspaceFs: {
      root: async () => label,
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
    },
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

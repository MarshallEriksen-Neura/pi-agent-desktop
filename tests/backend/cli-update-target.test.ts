import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createBrowserBackendPorts } from "../../src/lib/backend/composition/browser";
import {
  configureDesktopBackend,
  resetBackendContainerForTests,
} from "../../src/lib/backend/composition/container";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import {
  cliUpdateTargetKey,
  cliUpdateTargetStamp,
  type PiCliUpdateInfo,
  useCliUpdate,
} from "../../src/lib/pi/cli-update";
import { useSessions } from "../../src/lib/pi/sessions";

const local: ExecutionBinding = { kind: "local", targetId: "local" };
const remote = (profileId: string, profileRevision: number, remoteCwd = "/repo"): ExecutionBinding => ({
  kind: "ssh",
  profileId,
  profileRevision,
  hostAlias: `${profileId}.example`,
  remoteCwd,
  launcherProtocolVersion: 1,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function resetStore(): void {
  useCliUpdate.setState({
    phase: "idle",
    info: null,
    error: null,
    targetStamp: null,
    targetKind: null,
    targetHost: null,
    targetDetached: false,
    generation: 0,
  });
  useSessions.setState({ executionBinding: local });
}

test.afterEach(() => {
  resetBackendContainerForTests();
  resetStore();
});

test("target identity ignores remote cwd but invalidates a changed profile revision", () => {
  const first = remote("alpha", 7, "/one");
  assert.equal(cliUpdateTargetKey(first), "ssh:alpha");
  assert.equal(cliUpdateTargetStamp(first), cliUpdateTargetStamp(remote("alpha", 7, "/two")));
  assert.notEqual(cliUpdateTargetStamp(first), cliUpdateTargetStamp(remote("alpha", 8, "/one")));
  assert.equal(cliUpdateTargetStamp(local), "local");
});

test("remote update UI keeps confirmation, background progress, and detached restart semantics explicit", () => {
  const toast = readFileSync("src/components/CliUpdateToast.tsx", "utf8");
  const page = readFileSync("src/app/update/page.tsx", "utf8");
  for (const source of [toast, page]) {
    assert.match(source, /<ConfirmDialog/);
    assert.match(source, /confirmRemote(?:Title|Message)/);
    assert.match(source, /targetDetached/);
    assert.match(source, /setConfirm(?:Open|Remote)\(false\);\s*start(?:Apply|CliUpdate)\(\)/);
  }
  assert.match(toast, /void u\.apply\(binding\)\.catch/);
  assert.match(page, /void cli\.apply\(binding\)\.catch/);
  assert.match(toast, /u\.phase === "updated" && !u\.targetDetached/);
  assert.match(page, /cli\.phase === "updated" && !cli\.targetDetached/);
  assert.match(toast, /await usePi\.getState\(\)\.restart\(\);\s*u\.dismiss\(binding\)/);
  assert.match(page, /restart\(\)\s*\.then\(\(\) => cli\.dismiss\(binding\)\)/);
});
test("skipped versions are isolated per host", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const alpha = remote("alpha", 1);
    const beta = remote("beta", 1);
    useSessions.setState({ executionBinding: alpha });
    useCliUpdate.setState({
      targetStamp: cliUpdateTargetStamp(alpha),
      info: { installed: "1", latest: "2", updateAvailable: true },
    });
    useCliUpdate.getState().skip(alpha);
    useSessions.setState({ executionBinding: beta });
    useCliUpdate.setState({
      targetStamp: cliUpdateTargetStamp(beta),
      info: { installed: "1", latest: "3", updateAvailable: true },
    });
    useCliUpdate.getState().skip(beta);
    assert.equal(values.get("pi-cli-skip-version:ssh:alpha"), "2");
    assert.equal(values.get("pi-cli-skip-version:ssh:beta"), "3");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});


test("a late check cannot overwrite the newly selected target", async () => {
  const alpha = remote("alpha", 1);
  const beta = remote("beta", 1);
  const alphaReply = deferred<PiCliUpdateInfo>();
  const betaReply = deferred<PiCliUpdateInfo>();
  const ports = createBrowserBackendPorts();
  configureDesktopBackend({
    ...ports,
    piConfiguration: {
      ...ports.piConfiguration,
      checkPiCliUpdate: (binding) => binding.kind === "ssh" && binding.profileId === "alpha"
        ? alphaReply.promise
        : betaReply.promise,
    },
  });

  const alphaCheck = useCliUpdate.getState().check(alpha);
  const betaCheck = useCliUpdate.getState().check(beta);
  betaReply.resolve({ installed: "1.0.0", latest: "2.0.0", updateAvailable: true });
  await betaCheck;
  assert.equal(useCliUpdate.getState().targetStamp, cliUpdateTargetStamp(beta));
  assert.equal(useCliUpdate.getState().info?.installed, "1.0.0");

  alphaReply.resolve({ installed: "0.1.0", latest: "9.0.0", updateAvailable: true });
  await alphaCheck;
  assert.equal(useCliUpdate.getState().targetStamp, cliUpdateTargetStamp(beta));
  assert.equal(useCliUpdate.getState().info?.installed, "1.0.0");
});

test("apply refuses a binding after the selected target changes", async () => {
  const alpha = remote("alpha", 1);
  const beta = remote("beta", 1);
  let applyCalls = 0;
  const ports = createBrowserBackendPorts();
  configureDesktopBackend({
    ...ports,
    piConfiguration: {
      ...ports.piConfiguration,
      applyPiCliUpdate: async () => {
        applyCalls += 1;
        return { output: null };
      },
    },
  });
  useCliUpdate.setState({ targetStamp: cliUpdateTargetStamp(alpha) });
  useSessions.setState({ executionBinding: beta });

  await assert.rejects(useCliUpdate.getState().apply(alpha));
  assert.equal(applyCalls, 0);
});

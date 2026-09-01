import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureLauncherCurrent,
  resetLauncherSettledForTest,
} from "../../src/lib/backend/desktop/project-catalog";
import type { LauncherUpgradeResult } from "../../src/lib/backend/ports/execution-target";
import { createMockProjectCatalogPort } from "../../src/lib/backend/mock/project-catalog";
import {
  clearRemoteHomes,
  rememberRemoteHome,
  remoteHome,
} from "../../src/lib/remote-home-cache";
import { LOCAL_WORKSPACE_TARGET } from "../../src/lib/workspace-target";

/**
 * The two orthogonal axes: the target picker chooses a *machine*, the project picker
 * chooses a *directory on it*. These cover the seam between them — recents keyed by
 * target, and the `$HOME` a remote browser needs to open somewhere useful.
 */

test("a recent project is identified by path and target together", async () => {
  const catalog = createMockProjectCatalogPort();
  await catalog.commit("/srv/app");
  await catalog.commitRemote("/srv/app", "ssh:build-host");
  await catalog.commitRemote("/srv/app", "ssh:other-host");

  const recents = await catalog.listRecent();
  // The same path on three machines is three projects. Keying on path alone would have
  // collapsed them into one and sent "open" to the wrong host.
  assert.equal(recents.length, 3);
  assert.deepEqual(
    recents.map((recent) => recent.targetId).sort(),
    ["local", "ssh:build-host", "ssh:other-host"],
  );

  // Forgetting one must not forget the others.
  const left = await catalog.removeRecent("/srv/app", "ssh:build-host");
  assert.deepEqual(
    left.map((recent) => recent.targetId).sort(),
    ["local", "ssh:other-host"],
  );
});

test("re-opening a project moves it to the front of its own target only", async () => {
  const catalog = createMockProjectCatalogPort();
  await catalog.commitRemote("/srv/first", "ssh:host-a");
  await catalog.commitRemote("/srv/second", "ssh:host-a");
  await catalog.commit("/local/project");
  await catalog.commitRemote("/srv/first", "ssh:host-a");

  const recents = await catalog.listRecent();
  // Most-recent-first is what the target picker reads to decide where a host resumes.
  assert.deepEqual(recents.map((recent) => recent.path), [
    "/srv/first",
    "/local/project",
    "/srv/second",
  ]);
  const forHostA = recents.filter((recent) => recent.targetId === "ssh:host-a");
  assert.equal(forHostA[0].path, "/srv/first");
});

test("removeRecent defaults to the local target rather than guessing", async () => {
  const catalog = createMockProjectCatalogPort();
  await catalog.commit("/srv/app");
  await catalog.commitRemote("/srv/app", "ssh:build-host");

  const left = await catalog.removeRecent("/srv/app");
  assert.deepEqual(left.map((recent) => recent.targetId), ["ssh:build-host"]);
});

test("local selection stays with the native dialog; browsing is remote-only", async () => {
  const catalog = createMockProjectCatalogPort();
  // `pick()` returns a path from an OS dialog and no version of it can enumerate a
  // remote host — which is exactly why `browse` exists beside it rather than replacing
  // it. Locally the dialog is strictly better: it knows shortcuts, drives, and habits.
  await assert.rejects(() => catalog.browse(LOCAL_WORKSPACE_TARGET));
  // The preview has no SSH transport, so it must fail rather than fabricate a tree —
  // a mock listing would make the feature look shipped in preview and absent on desktop.
  await assert.rejects(() => catalog.browse("ssh:build-host"));
});

/**
 * The launcher auto-upgrade runs on the way into browsing, so what it *caches* decides
 * how many SSH round trips a session spends. Every wrong answer here is a real cost: a
 * cached failure never retries a host that came back, and an uncached success pays two
 * round trips on every directory the user opens.
 */
test("the launcher upgrade check caches settled answers and retries unreachable ones", async () => {
  const reply = (outcome: LauncherUpgradeResult["outcome"]): LauncherUpgradeResult => ({
    host: "prod",
    launcherPath: "/opt/pi-desktop-launcher",
    outcome,
    previousRevision: 0,
    currentRevision: 1,
    liveTasks: null,
    error: outcome === "unreachable" ? "ssh_unreachable: no route to host" : null,
  });

  for (const outcome of [
    "already_current",
    "upgraded",
    "remote_is_newer",
    // Cached too: it cannot change until the user's tasks finish, and re-probing on
    // every browse would spend two round trips to re-learn the same answer.
    "blocked_by_live_tasks",
  ] as const) {
    resetLauncherSettledForTest();
    let calls = 0;
    const upgrade = async () => {
      calls += 1;
      return reply(outcome);
    };
    await ensureLauncherCurrent("remote-1", upgrade);
    await ensureLauncherCurrent("remote-1", upgrade);
    assert.equal(calls, 1, `${outcome} should be asked once per session`);
  }

  // A host that could not be reached settles nothing — the network a moment ago is not
  // a fact about the launcher, so the next browse asks again.
  resetLauncherSettledForTest();
  let unreachableCalls = 0;
  const flaky = async () => {
    unreachableCalls += 1;
    return reply("unreachable");
  };
  await ensureLauncherCurrent("remote-1", flaky);
  await ensureLauncherCurrent("remote-1", flaky);
  assert.equal(unreachableCalls, 2);

  // A throwing call must not propagate: the browse the user asked for is more
  // important than the upgrade, and it either works anyway or fails with a better
  // message of its own. It also must not be cached.
  resetLauncherSettledForTest();
  let thrownCalls = 0;
  const broken = async () => {
    thrownCalls += 1;
    throw new Error("command remote_launcher_autoupgrade not found");
  };
  await ensureLauncherCurrent("remote-1", broken);
  await ensureLauncherCurrent("remote-1", broken);
  assert.equal(thrownCalls, 2);

  // Caching is per profile, so one settled host cannot silence another.
  resetLauncherSettledForTest();
  const asked: string[] = [];
  const record = async (id: string) => {
    asked.push(id);
    return reply("already_current");
  };
  await ensureLauncherCurrent("remote-1", record);
  await ensureLauncherCurrent("remote-2", record);
  await ensureLauncherCurrent("remote-1", record);
  assert.deepEqual(asked, ["remote-1", "remote-2"]);
});

test("the remote home cache only keeps absolute POSIX paths", () => {
  clearRemoteHomes();
  rememberRemoteHome("build-host", "/home/u");
  assert.equal(remoteHome("build-host"), "/home/u");

  // Anything the launcher would reject is not worth caching: it would only send the
  // browser somewhere that cannot be listed.
  for (const rejected of [null, undefined, "", "relative/path", "C:\\Users\\u"]) {
    rememberRemoteHome("other-host", rejected);
    assert.equal(remoteHome("other-host"), undefined, String(rejected));
  }
  // A launcher too old to report `home` leaves the previous answer alone rather than
  // clearing it.
  rememberRemoteHome("build-host", undefined);
  assert.equal(remoteHome("build-host"), "/home/u");
  assert.equal(remoteHome("never-checked"), undefined);
});

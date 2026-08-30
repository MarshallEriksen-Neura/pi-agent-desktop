import assert from "node:assert/strict";
import test from "node:test";

import { createMockRemotePiProfilePort } from "../../src/lib/backend/mock/remote-profiles";

const INPUT = {
  name: "Work server",
  sshHost: "work-host",
  remoteCwd: "/srv/work",
};

test("browser remote profile mock preserves unique IDs and revisioned updates", async () => {
  const port = createMockRemotePiProfilePort();
  const originalNow = Date.now;
  Date.now = () => 12345;
  try {
    const first = await port.save(INPUT);
    const second = await port.save({ ...INPUT, name: "Second server" });
    assert.notEqual(first.id, second.id);
    assert.equal(first.revision, 1);

    const updated = await port.save({ ...INPUT, id: first.id, name: "Updated server" });
    assert.equal(updated.id, first.id);
    assert.equal(updated.revision, 2);
    assert.equal(updated.name, "Updated server");

    await port.delete(first.id);
    await port.delete(second.id);
  } finally {
    Date.now = originalNow;
  }
});

test("browser remote profile mock rejects unknown mutations and preflight IDs", async () => {
  const port = createMockRemotePiProfilePort();
  await assert.rejects(
    port.save({ ...INPUT, id: "missing-profile" }),
    /Remote profile `missing-profile` was not found/,
  );
  await assert.rejects(
    port.delete("missing-profile"),
    /Remote profile `missing-profile` was not found/,
  );
  await assert.rejects(
    port.preflight("missing-profile"),
    /Remote profile `missing-profile` was not found/,
  );
});

test("readiness report reports every prerequisite and stops at the first failure", async () => {
  const port = createMockRemotePiProfilePort();

  const noLauncher = await port.checkDraft(INPUT);
  assert.equal(noLauncher.ok, false);
  // Every row is present even when the run stopped early: the UI renders a
  // fixed checklist rather than only the rows that were reached.
  assert.deepEqual(
    noLauncher.checks.map((check) => check.id),
    ["ssh", "launcher", "node", "workspace", "pi", "piAuth"],
  );
  assert.equal(noLauncher.checks[0].status, "ok");
  assert.equal(noLauncher.checks[1].status, "failed");
  assert.equal(noLauncher.checks[1].errorCode, "launcher_missing");
  // Rows after the failure are unobserved, not passing.
  assert.deepEqual(
    noLauncher.checks.slice(2).map((check) => check.status),
    ["skipped", "skipped", "skipped", "skipped"],
  );

  const missingHost = await port.checkDraft({ ...INPUT, sshHost: "" });
  assert.equal(missingHost.checks[0].status, "failed");
  assert.equal(missingHost.checks[0].errorCode, "ssh_host_unknown");
});

test("installing the launcher records an absolute path and clears the launcher check", async () => {
  const port = createMockRemotePiProfilePort();
  const installed = await port.installLauncher(INPUT.sshHost);
  // The installer resolves `$HOME` remotely; the caller stores what came back.
  assert.match(installed.launcherPath, /^\//);
  assert.equal(installed.host, INPUT.sshHost);

  const ready = await port.checkDraft({ ...INPUT, launcherPath: installed.launcherPath });
  assert.equal(ready.ok, true);
  assert.equal(ready.launcherPath, installed.launcherPath);
  assert.ok(ready.checks.every((check) => check.status === "ok"));

  // A relative workspace fails on its own row rather than as an opaque error.
  const badCwd = await port.checkDraft({
    ...INPUT,
    remoteCwd: "relative/path",
    launcherPath: installed.launcherPath,
  });
  const workspace = badCwd.checks.find((check) => check.id === "workspace");
  assert.equal(workspace?.status, "failed");
  assert.equal(workspace?.errorCode, "workspace_missing");
});

test("launcher install is scoped to a host and path pair", async () => {
  const port = createMockRemotePiProfilePort();
  const installed = await port.installLauncher(INPUT.sshHost, "/opt/pi-desktop-launcher");
  assert.equal(installed.launcherPath, "/opt/pi-desktop-launcher");

  const otherHost = await port.checkDraft({
    ...INPUT,
    sshHost: "other-host",
    launcherPath: "/opt/pi-desktop-launcher",
  });
  const launcher = otherHost.checks.find((check) => check.id === "launcher");
  assert.equal(launcher?.status, "failed");

  await assert.rejects(port.installLauncher("  "), /SSH host alias is required/);
});

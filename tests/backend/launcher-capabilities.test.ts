/**
 * Capability degradation.
 *
 * A launcher older than `--capabilities` answers any unknown mode with
 * `invalid launcher mode` and exit 64 — indistinguishable from a corrupt one.
 * Measured on a real host: the launcher installed there was several versions
 * behind and returned exactly that for `--provider-sync`.
 *
 * So the rule is: an unanswered query is not a failure. It means "V1 baseline",
 * because the run/preflight surface shipped before capabilities existed and every
 * already-installed host still has it. Getting this backwards would either break
 * every existing host or silently attempt V2 operations against a launcher that
 * cannot perform them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  hasLauncherCapability,
  type LauncherCapabilities,
} from "../../src/lib/backend/ports/execution-target";

const answered = (capabilities: string[]): LauncherCapabilities => ({
  host: "prod",
  launcherPath: "/opt/pi-desktop-launcher",
  launcherProtocolVersion: 1,
  capabilities,
  supportsCapabilityQuery: true,
  errorCode: null,
  error: null,
});

const unanswered = (errorCode: string | null = null): LauncherCapabilities => ({
  host: "prod",
  launcherPath: "/opt/pi-desktop-launcher",
  launcherProtocolVersion: 0,
  capabilities: [],
  supportsCapabilityQuery: false,
  errorCode,
  error: errorCode ? "something the user must fix" : null,
});

test("an answering launcher grants exactly what it lists", () => {
  const probe = answered(["run-v1", "preflight-v1", "capabilities-v1"]);
  assert.equal(hasLauncherCapability(probe, "run-v1"), true);
  assert.equal(hasLauncherCapability(probe, "capabilities-v1"), true);
  assert.equal(
    hasLauncherCapability(probe, "provider-sync-v1"),
    false,
    "a capability it did not list must not be inferred from the others",
  );
});

test("a launcher too old to answer still has the V1 baseline", () => {
  const probe = unanswered();
  assert.equal(
    hasLauncherCapability(probe, "run-v1"),
    true,
    "every installed host predating the query can still run",
  );
  assert.equal(hasLauncherCapability(probe, "preflight-v1"), true);
  assert.equal(
    hasLauncherCapability(probe, "provider-sync-v1"),
    false,
    "post-V1 capabilities must never be assumed present",
  );
  assert.equal(hasLauncherCapability(probe, "capabilities-v1"), false);
});

test("an unreachable host grants nothing beyond the baseline and carries a code", () => {
  const probe = unanswered("launcherMissing");
  assert.equal(probe.errorCode, "launcherMissing");
  assert.equal(hasLauncherCapability(probe, "provider-sync-v1"), false);
});

test("no probe at all grants nothing", () => {
  assert.equal(hasLauncherCapability(null, "run-v1"), false);
  assert.equal(hasLauncherCapability(undefined, "run-v1"), false);
});

/**
 * The launcher's own reply, verbatim from the host, so this test fails if the
 * shipped capability list and the parsed shape ever drift apart.
 */
test("the launcher's real reply parses into the expected capability set", () => {
  const wire = JSON.parse(
    '{"launcherProtocolVersion":1,"capabilities":["run-v1","preflight-v1","provider-sync-v1","capabilities-v1","detached-tasks-v1","attach-v1","workspace-v1","workspace-writes-v1"]}',
  ) as { launcherProtocolVersion: number; capabilities: string[] };
  const probe = answered(wire.capabilities);
  // Capabilities are versioned independently of the payload protocol: detached
  // tasks and attach both shipped without moving it, so inferring one from the
  // other is wrong.
  assert.equal(wire.launcherProtocolVersion, 1);
  for (const capability of [
    "run-v1",
    "preflight-v1",
    "provider-sync-v1",
    "capabilities-v1",
    "detached-tasks-v1",
    "attach-v1",
    "workspace-v1",
    "workspace-writes-v1",
  ] as const) {
    assert.equal(hasLauncherCapability(probe, capability), true, capability);
  }
});

/**
 * An already-installed launcher predates detached tasks and cannot answer the
 * query at all. It still has the V1 surface, so the degradation must grant exactly
 * that and nothing more — a desktop that inferred detached support here would send
 * `--start-detached` to a launcher that answers `invalid launcher mode`.
 */
test("an old launcher degrades to the V1 surface and never to detached tasks", () => {
  const probe = {
    host: "prod",
    launcherPath: "/opt/pi-desktop-launcher",
    launcherProtocolVersion: 0,
    capabilities: [],
    supportsCapabilityQuery: false,
    errorCode: null,
    error: null,
  };
  assert.equal(hasLauncherCapability(probe, "run-v1"), true);
  assert.equal(hasLauncherCapability(probe, "preflight-v1"), true);
  assert.equal(hasLauncherCapability(probe, "detached-tasks-v1"), false);
  assert.equal(hasLauncherCapability(probe, "attach-v1"), false);
  assert.equal(hasLauncherCapability(probe, "workspace-v1"), false);
  assert.equal(hasLauncherCapability(probe, "workspace-writes-v1"), false);
  assert.equal(hasLauncherCapability(probe, "provider-sync-v1"), false);
});

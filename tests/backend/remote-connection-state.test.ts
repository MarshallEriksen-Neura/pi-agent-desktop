import assert from "node:assert/strict";
import test from "node:test";

import {
  canStopRemoteTask,
  deriveRemoteConnectionState,
  isReattachable,
} from "../../src/lib/pi/remote-connection-state";
import type { RemoteTaskReport } from "../../src/lib/backend/ports/remote-profiles";

/**
 * The rule these tests exist to hold: **`lost` and `orphaned` must stay distinct.**
 *
 * V1 collapsed them into one "unknown" and then guessed, which was defect D2. The guess is
 * wrong for up to ~2h — the local transport gives up at a measured 24.2s while a
 * partitioned pi keeps running until sshd's 7200s keepalive notices it.
 */

const report = (overrides: Partial<RemoteTaskReport> = {}): RemoteTaskReport => ({
  remoteTaskId: "t-0000000a0001",
  state: "running",
  stale: false,
  exists: true,
  pid: 40213,
  piAlive: true,
  exitCode: null,
  stopRequestedAt: null,
  stopConfirmedAt: null,
  baseSequence: 1,
  nextSequence: 42,
  ...overrides,
});

test("an open channel is running, whatever an older report said", () => {
  assert.equal(deriveRemoteConnectionState({ channelOpen: true }), "running");
  // A report fetched while nothing was attached described a different situation.
  assert.equal(
    deriveRemoteConnectionState({ channelOpen: true, report: report({ state: "exited" }) }),
    "running",
  );
});

test("a channel that ended without saying why is lost, not exited", () => {
  // The launcher always announces a deliberate end, so silence means the transport died
  // mid-stream. Calling that `exited` would claim the work stopped when it may well be
  // running for another two hours.
  assert.equal(deriveRemoteConnectionState({ channelOpen: false }), "lost");
  assert.equal(isReattachable("lost"), true);
  // And a stop must still be offered: refusing would leave a user with work running that
  // they cannot stop.
  assert.equal(canStopRemoteTask("lost"), true);
});

test("a reported end is authoritative about the task", () => {
  for (const reason of ["taskExited", "taskGone"] as const) {
    assert.equal(deriveRemoteConnectionState({ channelOpen: false, detachReason: reason }), "exited");
  }
  // `caughtUp` closed the channel deliberately but says nothing about the task, so its
  // state stays unobserved until someone asks.
  assert.equal(deriveRemoteConnectionState({ channelOpen: false, detachReason: "caughtUp" }), "lost");
});

test("a live task with nothing attached is orphaned, and that is recoverable", () => {
  const state = deriveRemoteConnectionState({ channelOpen: false, report: report() });
  assert.equal(state, "orphaned");
  // Distinct from `lost` because here the remote state is *known*. Reattaching is exactly
  // what the cursor exists for.
  assert.notEqual(state, "lost");
  assert.equal(isReattachable(state), true);
  assert.equal(canStopRemoteTask(state), true);
});

test("a report resolves lost into a definite answer", () => {
  // This is the whole point of the Check action: `lost` is not a state to display
  // indefinitely, it is a state with one exit — ask the host.
  assert.equal(
    deriveRemoteConnectionState({ channelOpen: false, report: report({ state: "exited" }) }),
    "exited",
  );
  assert.equal(
    deriveRemoteConnectionState({ channelOpen: false, report: report({ exists: false }) }),
    "exited",
  );
  assert.equal(
    deriveRemoteConnectionState({ channelOpen: false, report: report({ state: "stopping" }) }),
    "orphaned",
  );
});

test("only a finished task hides the stop action", () => {
  assert.equal(canStopRemoteTask("exited"), false);
  assert.equal(isReattachable("exited"), false);
  assert.equal(isReattachable("running"), false, "an attached channel has nothing to reattach");
});

/**
 * The lifecycle save rule, which has three cases and one subtle one.
 *
 * Both the native command and the mock implement it identically: an explicit value wins,
 * an omitted value on an existing profile **keeps what it had**, and a new profile defaults
 * to `attached`. The middle case is the one worth pinning — a caller that round-trips a
 * profile without touching the lifecycle must not silently downgrade it, which is exactly
 * what would happen if omitted meant "default".
 */
test("an omitted lifecycle keeps an existing profile's, and only defaults a new one", async () => {
  const { createMockRemotePiProfilePort } = await import(
    "../../src/lib/backend/mock/remote-profiles"
  );
  const profiles = createMockRemotePiProfilePort();

  const fresh = await profiles.save({ name: "Build", sshHost: "build-host" });
  assert.equal(fresh.lifecycle, "attached", "a new profile is attached unless asked otherwise");

  const detached = await profiles.save({ id: fresh.id, name: "Build", sshHost: "build-host", lifecycle: "detached" });
  assert.equal(detached.lifecycle, "detached");

  // The subtle case: a save that does not mention lifecycle must not reset it.
  const untouched = await profiles.save({ id: fresh.id, name: "Build server", sshHost: "build-host" });
  assert.equal(untouched.lifecycle, "detached", "an omitted lifecycle is not a downgrade");
  assert.equal(untouched.name, "Build server", "the rest of the save still applied");

  // And it can be turned back off explicitly.
  const back = await profiles.save({ id: fresh.id, name: "Build server", sshHost: "build-host", lifecycle: "attached" });
  assert.equal(back.lifecycle, "attached");
});

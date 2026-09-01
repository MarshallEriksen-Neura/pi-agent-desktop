import assert from "node:assert/strict";
import test from "node:test";

import { prepareRemoteBinding } from "../../src/lib/pi/remote-task-binding";
import type { ExecutionBinding, RemotePiProfile } from "../../src/lib/backend/ports/execution-target";
import type {
  RemotePiProfilePort,
  RemoteTaskEnsureRequest,
  RemoteTaskHandle,
} from "../../src/lib/backend/ports/remote-profiles";

/**
 * Completing a detached binding before anything attaches to it.
 *
 * The rule under test is the one that makes replay unambiguous: **one `remoteTaskId` is
 * one remote pi process for its entire life.** A reattach must present the same id; a
 * continuation after pi exits must present a new one.
 */

const profile = (overrides: Partial<RemotePiProfile> = {}): RemotePiProfile => ({
  id: "remote-build",
  revision: 1,
  name: "Build host",
  sshHost: "build-host",
  launcherPath: "/root/.local/bin/pi-desktop-launcher",
  launcherProtocolVersion: 1,
  lifecycle: "detached",
  ...overrides,
});

function fakePort(
  profiles: RemotePiProfile[],
  reply: (request: RemoteTaskEnsureRequest) => RemoteTaskHandle,
) {
  const requests: RemoteTaskEnsureRequest[] = [];
  const port = {
    list: async () => profiles,
    ensureTask: async (request: RemoteTaskEnsureRequest) => {
      requests.push(request);
      return reply(request);
    },
  } as unknown as RemotePiProfilePort;
  return { port, requests };
}

const handle = (overrides: Partial<RemoteTaskHandle> = {}): RemoteTaskHandle => ({
  remoteTaskId: "t-0000000a0001",
  state: "running",
  started: true,
  previousTaskId: null,
  baseSequence: 1,
  nextSequence: 1,
  ...overrides,
});

const ssh = (profileId: string, remoteTaskId?: string | null): ExecutionBinding => ({
  kind: "ssh",
  profileId,
  profileRevision: 1,
  hostAlias: "build-host",
  remoteCwd: "/srv/app",
  launcherProtocolVersion: 1,
  ...(remoteTaskId === undefined ? {} : { remoteTaskId }),
});
test("a local binding is passed through untouched", async () => {
  const { port, requests } = fakePort([profile()], () => handle());
  const local: ExecutionBinding = { kind: "local", targetId: "local" };
  const prepared = await prepareRemoteBinding(local, port);
  assert.equal(prepared.binding, local);
  assert.equal(prepared.taskReplaced, false);
  // There is no task to address, so the host is never contacted.
  assert.deepEqual(requests, []);
});

test("a fresh detached binding gets an id, and the cwd goes with it", async () => {
  const { port, requests } = fakePort([profile()], () => handle({ remoteTaskId: "t-0000000a0001" }));
    const prepared = await prepareRemoteBinding(ssh("remote-build"), port);
  assert.equal(prepared.binding.kind === "ssh" && prepared.binding.remoteTaskId, "t-0000000a0001");
  assert.equal(prepared.taskReplaced, false);
  // The workspace is a per-conversation choice, so it travels on the request rather than
  // being read from the profile on the far side.
  assert.deepEqual(requests, [
    { profileId: "remote-build", remoteTaskId: undefined, remoteCwd: "/srv/app" },
  ]);
});

test("a live task is reattached to by the same id, never a new one", async () => {
  const { port, requests } = fakePort([profile()], (request) =>
    handle({ remoteTaskId: request.remoteTaskId!, started: false, previousTaskId: null }),
  );
    const prepared = await prepareRemoteBinding(ssh("remote-build", "t-0000000a0001"), port);
  assert.equal(prepared.binding.kind === "ssh" && prepared.binding.remoteTaskId, "t-0000000a0001");
  // Nothing was replaced, so a held cursor still points into the same journal and replay
  // resumes rather than restarting.
  assert.equal(prepared.taskReplaced, false);
  assert.equal(requests[0].remoteTaskId, "t-0000000a0001");
});

test("a dead task is replaced, and the replacement is reported as such", async () => {
  const { port, requests } = fakePort([profile()], (request) =>
    handle({ remoteTaskId: "t-0000000b0002", previousTaskId: request.remoteTaskId }),
  );
    const prepared = await prepareRemoteBinding(ssh("remote-build", "t-0000000a0001"), port);
  assert.equal(prepared.binding.kind === "ssh" && prepared.binding.remoteTaskId, "t-0000000b0002");
  // The caller has to know: a cursor into the old journal would resume at a sequence that
  // means something entirely different in the new one.
  assert.equal(prepared.taskReplaced, true);
  assert.equal(requests[0].remoteTaskId, "t-0000000a0001");
});

test("an attached profile drops a stale task id instead of failing every start", async () => {
  const { port, requests } = fakePort([profile({ lifecycle: "attached" })], () => handle());
  // A profile flipped back to attached leaves the conversation's binding carrying an id
  // that `validate_binding` refuses outright — so it has to be dropped, not kept.
  const prepared = await prepareRemoteBinding(ssh("remote-build", "t-0000000a0001"), port);
  assert.equal(prepared.binding.kind === "ssh" && prepared.binding.remoteTaskId, null);
  assert.deepEqual(requests, [], "an attached profile has no task to ensure");
});

test("a deleted profile is left alone rather than repaired", async () => {
  const { port, requests } = fakePort([profile()], () => handle());
  const prepared = await prepareRemoteBinding(ssh("remote-gone", "t-0000000a0001"), port);
  // The target picker already reports this state. Inventing a binding here would hide it.
  assert.equal(prepared.binding.kind === "ssh" && prepared.binding.remoteTaskId, "t-0000000a0001");
  assert.equal(prepared.taskReplaced, false);
  assert.deepEqual(requests, []);
});

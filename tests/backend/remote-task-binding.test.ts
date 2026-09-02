import assert from "node:assert/strict";
import test from "node:test";

import { prepareRemoteBinding } from "../../src/lib/pi/remote-task-binding";
import type { ExecutionBinding, RemotePiProfile } from "../../src/lib/backend/ports/execution-target";
import type {
  RemotePiProfilePort,
  RemoteTaskEnsureRequest,
  RemoteTaskHandle,
  RemoteTaskReport,
} from "../../src/lib/backend/ports/remote-profiles";

/** One remoteTaskId identifies one remote Pi process and journal for its whole life. */

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

const handle = (overrides: Partial<RemoteTaskHandle> = {}): RemoteTaskHandle => ({
  remoteTaskId: "t-0000000a0001",
  state: "running",
  started: true,
  previousTaskId: null,
  baseSequence: 1,
  nextSequence: 1,
  ...overrides,
});

const status = (overrides: Partial<RemoteTaskReport> = {}): RemoteTaskReport => ({
  remoteTaskId: "t-0000000a0001",
  state: "running",
  stale: false,
  exists: true,
  piAlive: true,
  baseSequence: 1,
  nextSequence: 1,
  ...overrides,
});

function fakePort(
  profiles: RemotePiProfile[],
  reply: (request: RemoteTaskEnsureRequest) => RemoteTaskHandle,
  report: (taskId: string) => RemoteTaskReport = (taskId) =>
    status({ remoteTaskId: taskId, state: "exited", exists: false, piAlive: false }),
) {
  const requests: RemoteTaskEnsureRequest[] = [];
  const statusRequests: string[] = [];
  const port = {
    list: async () => profiles,
    ensureTask: async (request: RemoteTaskEnsureRequest) => {
      requests.push(request);
      return reply(request);
    },
    taskStatus: async (_profileId: string, taskId: string) => {
      statusRequests.push(taskId);
      return report(taskId);
    },
  } as unknown as RemotePiProfilePort;
  return { port, requests, statusRequests };
}

const ssh = (
  profileId: string,
  remoteTaskId?: string | null,
  remoteTaskPending = false,
): ExecutionBinding => ({
  kind: "ssh",
  profileId,
  profileRevision: 1,
  hostAlias: "build-host",
  remoteCwd: "/srv/app",
  launcherProtocolVersion: 1,
  ...(remoteTaskId === undefined ? {} : { remoteTaskId }),
  ...(remoteTaskPending ? { remoteTaskPending: true } : {}),
});

const persistedBindings = () => {
  const bindings: ExecutionBinding[] = [];
  return {
    bindings,
    persist: async (binding: ExecutionBinding) => {
      bindings.push(binding);
    },
  };
};

const taskIdOf = (binding: ExecutionBinding) =>
  binding.kind === "ssh" ? binding.remoteTaskId ?? null : null;
const pendingOf = (binding: ExecutionBinding) =>
  binding.kind === "ssh" ? binding.remoteTaskPending ?? false : false;

test("a local binding is passed through without persistence or host calls", async () => {
  const { port, requests, statusRequests } = fakePort([profile()], () => handle());
  const saved = persistedBindings();
  const local: ExecutionBinding = { kind: "local", targetId: "local" };
  const prepared = await prepareRemoteBinding(local, saved.persist, port);
  assert.equal(prepared.binding, local);
  assert.equal(prepared.taskReplaced, false);
  assert.deepEqual(saved.bindings, []);
  assert.deepEqual(requests, []);
  assert.deepEqual(statusRequests, []);
});

test("a fresh task id is persisted before the remote start and acknowledged afterward", async () => {
  const order: string[] = [];
  const { port, requests } = fakePort([profile()], (request) => {
    order.push(`start:${request.remoteTaskId}`);
    return handle({ remoteTaskId: request.remoteTaskId });
  });
  const saved: ExecutionBinding[] = [];
  const persist = async (binding: ExecutionBinding) => {
    saved.push(binding);
    order.push(`save:${taskIdOf(binding)}:${pendingOf(binding)}`);
  };
  const prepared = await prepareRemoteBinding(
    ssh("remote-build"),
    persist,
    port,
    () => "t-0000000a0001",
  );

  assert.deepEqual(order, [
    "save:t-0000000a0001:true",
    "start:t-0000000a0001",
    "save:t-0000000a0001:false",
  ]);
  assert.deepEqual(requests, [{
    profileId: "remote-build",
    remoteTaskId: "t-0000000a0001",
    previousTaskId: undefined,
    remoteCwd: "/srv/app",
  }]);
  assert.equal(taskIdOf(prepared.binding), "t-0000000a0001");
  assert.equal(pendingOf(prepared.binding), false);
  assert.equal(prepared.taskReplaced, false);
  assert.equal(pendingOf(saved[0]), true);
  assert.equal(pendingOf(saved[1]), false);
});

test("a failed write-ahead save prevents any remote start", async () => {
  const { port, requests } = fakePort([profile()], () => handle());
  await assert.rejects(
    prepareRemoteBinding(
      ssh("remote-build"),
      async () => { throw new Error("sqlite unavailable"); },
      port,
      () => "t-0000000a0001",
    ),
    /sqlite unavailable/,
  );
  assert.deepEqual(requests, []);
});

test("a live completed task is reattached without a host start", async () => {
  const { port, requests, statusRequests } = fakePort(
    [profile()],
    () => handle(),
    (taskId) => status({ remoteTaskId: taskId, baseSequence: 7 }),
  );
  const saved = persistedBindings();
  const prepared = await prepareRemoteBinding(
    ssh("remote-build", "t-0000000a0001"),
    saved.persist,
    port,
  );
  assert.equal(taskIdOf(prepared.binding), "t-0000000a0001");
  assert.equal(prepared.baseSequence, 7);
  assert.equal(prepared.taskReplaced, false);
  assert.deepEqual(statusRequests, ["t-0000000a0001"]);
  assert.deepEqual(requests, []);
  assert.deepEqual(saved.bindings, []);
});

test("a pending id recovers a lost start response by retrying the exact id", async () => {
  const { port, requests, statusRequests } = fakePort([profile()], (request) =>
    handle({ remoteTaskId: request.remoteTaskId, started: false }),
  );
  const saved = persistedBindings();
  const prepared = await prepareRemoteBinding(
    ssh("remote-build", "t-0000000a0001", true),
    saved.persist,
    port,
  );
  assert.deepEqual(statusRequests, [], "pending recovery delegates idempotency to ensureTask");
  assert.equal(requests[0].remoteTaskId, "t-0000000a0001");
  assert.equal(taskIdOf(saved.bindings[0]), "t-0000000a0001");
  assert.equal(pendingOf(saved.bindings[0]), false);
  assert.equal(prepared.taskReplaced, true, "a held cursor is unsafe until start is acknowledged");
});

test("a dead completed task gets a write-ahead replacement and clears the old journal", async () => {
  const { port, requests } = fakePort([profile()], (request) =>
    handle({ remoteTaskId: request.remoteTaskId, previousTaskId: request.previousTaskId ?? null }),
  );
  const saved = persistedBindings();
  const prepared = await prepareRemoteBinding(
    ssh("remote-build", "t-0000000a0001"),
    saved.persist,
    port,
    () => "t-0000000b0002",
  );
  assert.equal(prepared.taskReplaced, true);
  assert.equal(requests[0].remoteTaskId, "t-0000000b0002");
  assert.equal(requests[0].previousTaskId, "t-0000000a0001");
  assert.equal(pendingOf(saved.bindings[0]), true);
  assert.equal(pendingOf(saved.bindings[1]), false);
});

test("a pending id that already exited is spent before a replacement starts", async () => {
  let call = 0;
  const { port, requests } = fakePort([profile()], (request) => {
    call += 1;
    return call === 1
      ? handle({ remoteTaskId: request.remoteTaskId, state: "exited", started: false })
      : handle({ remoteTaskId: request.remoteTaskId, previousTaskId: request.previousTaskId ?? null });
  });
  const saved = persistedBindings();
  const minted = ["t-0000000b0002"];
  const prepared = await prepareRemoteBinding(
    ssh("remote-build", "t-0000000a0001", true),
    saved.persist,
    port,
    () => minted.shift()!,
  );
  assert.deepEqual(requests.map((request) => request.remoteTaskId), [
    "t-0000000a0001",
    "t-0000000b0002",
  ]);
  assert.equal(requests[1].previousTaskId, "t-0000000a0001");
  assert.equal(taskIdOf(prepared.binding), "t-0000000b0002");
  assert.equal(prepared.taskReplaced, true);
});

test("an attached profile drops stale detached task state durably", async () => {
  const { port, requests } = fakePort([profile({ lifecycle: "attached" })], () => handle());
  const saved = persistedBindings();
  const prepared = await prepareRemoteBinding(
    ssh("remote-build", "t-0000000a0001", true),
    saved.persist,
    port,
  );
  assert.equal(taskIdOf(prepared.binding), null);
  assert.equal(pendingOf(prepared.binding), false);
  assert.equal(saved.bindings.length, 1);
  assert.deepEqual(requests, []);
});

test("a deleted profile is left alone rather than silently redirected", async () => {
  const { port, requests } = fakePort([profile()], () => handle());
  const saved = persistedBindings();
  const prepared = await prepareRemoteBinding(
    ssh("remote-gone", "t-0000000a0001"),
    saved.persist,
    port,
  );
  assert.equal(taskIdOf(prepared.binding), "t-0000000a0001");
  assert.equal(prepared.taskReplaced, false);
  assert.deepEqual(saved.bindings, []);
  assert.deepEqual(requests, []);
});

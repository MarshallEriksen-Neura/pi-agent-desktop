import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExecutionBinding,
  ProjectCatalogPort,
  WorkspaceFsPort,
} from "../../src/lib/backend/ports";
import {
  bindingForRemoteProject,
  switchRemoteWorkspaceProject,
  type RemoteProjectSwitchServices,
} from "../../src/lib/orchestration/project-switch";
import type { RecentProject } from "../../src/lib/workspace";

const oldBinding: Extract<ExecutionBinding, { kind: "ssh" }> = {
  kind: "ssh",
  profileId: "server-a",
  profileRevision: 3,
  hostAlias: "server-a.example.test",
  remoteCwd: "/srv/old",
  launcherProtocolVersion: 2,
  remoteTaskId: "task-old",
  remoteTaskPending: false,
};

function fixture(options: { failCommit?: boolean; failNextSwitch?: boolean } = {}) {
  const order: string[] = [];
  const switchedBindings: ExecutionBinding[] = [];
  let failNextSwitch = options.failNextSwitch ?? false;
  const recents: RecentProject[] = [
    {
      path: "/srv/next",
      name: "next",
      lastOpenedAt: 123,
      targetId: "ssh:server-a",
    },
  ];
  const projectCatalog = {
    commitRemote: async (path: string, targetId: string) => {
      order.push(`persist:${targetId}:${path}`);
      if (options.failCommit) throw new Error("remote recent write failed");
      return recents;
    },
  } as unknown as ProjectCatalogPort;
  const workspaceFs = {
    listDir: async (path: string) => {
      order.push(`list:${path}`);
      return [{ name: "src", path: `${path}/src`, isDir: true }];
    },
  } as unknown as WorkspaceFsPort;
  const services: RemoteProjectSwitchServices = {
    switchExecutionTarget: async (binding) => {
      switchedBindings.push(binding);
      order.push(
        `scope:${binding.kind === "ssh" ? binding.remoteCwd : binding.targetId}`,
      );
      if (failNextSwitch) {
        failNextSwitch = false;
        throw new Error("remote process failed to start");
      }
    },
  };

  return {
    order,
    switchedBindings,
    recents,
    services,
    input: {
      path: "/srv/next",
      currentRoot: "/srv/old",
      targetId: "ssh:server-a" as const,
      executionBinding: oldBinding,
      projectCatalog,
      workspaceFs,
      setActiveFile: () => order.push("active"),
      applyProjectRoot: () => order.push("commit-ui"),
      applyRecentProjects: (projects: RecentProject[]) => {
        assert.equal(projects, recents);
        order.push("recents");
      },
    },
  };
}

test("a different remote workspace gets a fresh task binding", () => {
  const next = bindingForRemoteProject(oldBinding, "/srv/next");

  assert.notEqual(next, oldBinding);
  assert.equal(next.profileId, oldBinding.profileId);
  assert.equal(next.remoteCwd, "/srv/next");
  assert.equal(next.remoteTaskId, null);
  assert.equal(next.remoteTaskPending, false);
  assert.equal(oldBinding.remoteTaskId, "task-old");
  assert.equal(bindingForRemoteProject(oldBinding, oldBinding.remoteCwd), oldBinding);
});

test("remote project switch scopes sessions before committing workspace UI", async () => {
  const { input, services, order, switchedBindings } = fixture();

  await switchRemoteWorkspaceProject(input, services);

  assert.deepEqual(order, [
    "list:/srv/next",
    "scope:/srv/next",
    "persist:ssh:server-a:/srv/next",
    "commit-ui",
    "active",
    "recents",
  ]);
  assert.equal(switchedBindings[0]?.kind, "ssh");
  assert.equal(
    switchedBindings[0]?.kind === "ssh" ? switchedBindings[0].remoteTaskId : undefined,
    null,
  );
});

test("failed remote project persistence restores the previous session scope", async () => {
  const { input, services, order, switchedBindings } = fixture({ failCommit: true });

  await assert.rejects(
    () => switchRemoteWorkspaceProject(input, services),
    /remote recent write failed/,
  );

  assert.deepEqual(order, [
    "list:/srv/next",
    "scope:/srv/next",
    "persist:ssh:server-a:/srv/next",
    "scope:/srv/old",
  ]);
  assert.equal(switchedBindings[1], oldBinding);
  assert.equal(order.includes("commit-ui"), false);
  assert.equal(order.includes("recents"), false);
});

test("failed remote session startup restores the previous binding", async () => {
  const { input, services, order, switchedBindings } = fixture({
    failNextSwitch: true,
  });

  await assert.rejects(
    () => switchRemoteWorkspaceProject(input, services),
    /remote process failed to start/,
  );

  assert.deepEqual(order, ["list:/srv/next", "scope:/srv/next", "scope:/srv/old"]);
  assert.equal(switchedBindings[1], oldBinding);
  assert.equal(order.includes("persist:ssh:server-a:/srv/next"), false);
  assert.equal(order.includes("commit-ui"), false);
});

test("opening the current remote workspace does not rescope or reload", async () => {
  const { input, services, order } = fixture();
  input.path = oldBinding.remoteCwd;
  input.currentRoot = oldBinding.remoteCwd;

  await switchRemoteWorkspaceProject(input, services);

  assert.deepEqual(order, []);
});

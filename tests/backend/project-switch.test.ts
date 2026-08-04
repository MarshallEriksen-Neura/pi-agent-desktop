import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectCatalogPort, WorkspaceFsPort } from "../../src/lib/backend/ports";
import {
  switchWorkspaceProject,
  type ProjectSwitchServices,
} from "../../src/lib/orchestration/project-switch";

function fixture(restartResults: boolean[] = [true], failCommit = false) {
  const order: string[] = [];
  const projectCatalog = {
    resolve: async () => {
      order.push("resolve");
      return "D:/next";
    },
    commit: async (root: string) => {
      order.push(`persist:${root}`);
      if (failCommit) throw new Error("desktop state write failed");
      return root;
    },
  } as unknown as ProjectCatalogPort;
  const workspaceFs = {
    listDir: async () => {
      order.push("list");
      return [{ name: "src", path: "D:/next/src", isDir: true }];
    },
  } as unknown as WorkspaceFsPort;
  const services: ProjectSwitchServices = {
    flushOutgoingSession: async () => {
      order.push("flush");
    },
    latestSessionPath: async (root) => {
      order.push(`resume:${root}`);
      return root === "D:/old"
        ? "D:/sessions/old.jsonl"
        : "D:/sessions/next.jsonl";
    },
    restartPi: async (root, resumePath) => {
      order.push(`restart:${root}:${resumePath}`);
      return restartResults.shift() ?? true;
    },
    switchSessionProject: async (root) => {
      order.push(`scope:${root}`);
    },
  };
  return {
    order,
    services,
    input: {
      path: "D:/next",
      currentRoot: "D:/old",
      projectCatalog,
      workspaceFs,
      setActiveFile: () => {
        order.push("active");
      },
      loadRecents: async () => {
        order.push("recents");
      },
      applyProjectRoot: () => {
        order.push("commit-ui");
      },
    },
  };
}

test("project switch commits only after flush, load, and Pi restart succeed", async () => {
  const { input, services, order } = fixture();
  await switchWorkspaceProject(input, services);
  assert.deepEqual(order, [
    "flush",
    "resolve",
    "list",
    "resume:D:/old",
    "resume:D:/next",
    "restart:D:/next:D:/sessions/next.jsonl",
    "scope:D:/next",
    "persist:D:/next",
    "commit-ui",
    "active",
    "recents",
  ]);
});

test("project switch keeps UI/session scope unchanged when restart fails", async () => {
  const { input, services, order } = fixture([false, true]);
  await switchWorkspaceProject(input, services);
  assert.equal(order.includes("persist:D:/next"), false);
  assert.equal(order.includes("commit-ui"), false);
  assert.equal(order.includes("active"), false);
  assert.equal(order.includes("scope:D:/next"), false);
  assert.ok(order.includes("restart:D:/old:D:/sessions/old.jsonl"));
  assert.ok(order.includes("scope:D:/old"));
});

test("opening the current project does not restart or rescope Pi", async () => {
  const { input, services, order } = fixture();
  input.currentRoot = "D:/next";
  await switchWorkspaceProject(input, services);
  assert.deepEqual(order, ["flush", "resolve"]);
});

test("failed durable commit rolls Pi and session scope back", async () => {
  const { input, services, order } = fixture([true, true], true);
  await assert.rejects(
    () => switchWorkspaceProject(input, services),
    /desktop state write failed/,
  );
  assert.ok(order.includes("scope:D:/next"));
  assert.ok(order.includes("restart:D:/old:D:/sessions/old.jsonl"));
  assert.ok(order.includes("scope:D:/old"));
  assert.equal(order.includes("commit-ui"), false);
  assert.equal(order.includes("active"), false);
});

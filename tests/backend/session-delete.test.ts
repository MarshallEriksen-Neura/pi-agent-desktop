import assert from "node:assert/strict";
import test from "node:test";

import type { SessionRepositoryPort } from "../../src/lib/backend/ports";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import type { ChatSessionMeta } from "../../src/lib/pi/sessions";
import { configureSessionDependenciesForTests, useSessions } from "../../src/lib/pi/sessions";

/**
 * The Tauri repository owns the complete SQLite/transcript recycle transaction.
 * The frontend must make one repository call and only remove local state after it
 * succeeds; splitting the operation here would duplicate file moves and bypass
 * the backend's compensation protocol.
 */
const SSH_BINDING: ExecutionBinding = {
  kind: "ssh",
  profileId: "profile-1",
  profileRevision: 1,
  hostAlias: "box",
  remoteCwd: "/root/project",
  launcherProtocolVersion: 1,
};

function meta(overrides: Partial<ChatSessionMeta> & { id: string }): ChatSessionMeta {
  return {
    name: "",
    sessionPath: "",
    preview: "",
    projectRoot: "D:/project",
    executionBinding: { kind: "local", targetId: "local" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface Harness {
  order: string[];
  restore: () => void;
}

function harness(failures: { delete?: boolean } = {}): Harness {
  const order: string[] = [];
  const repository = {
    list: async () => [],
    load: async () => [],
    save: async () => {},
    rename: async () => {},
    delete: async (_scope: unknown, id: string) => {
      order.push(`delete:${id}`);
      if (failures.delete) throw new Error("index write failed");
    },
    listTrash: async () => [],
    restoreTrash: async () => {},
    purgeTrash: async () => {},
    generateTitle: async () => "",
  } as unknown as SessionRepositoryPort;

  configureSessionDependenciesForTests({
    repository,
    desktopFeatures: true,
    projectRoot: () => "D:/project",
  });

  return {
    order,
    restore: () => {
      configureSessionDependenciesForTests(null);
      useSessions.setState({ sessions: [], activeId: null });
    },
  };
}

/**
 * Seeds two conversations and returns the id of the one to delete. The survivor
 * is the active one deliberately: deleting a background conversation returns
 * before any process work, which keeps the assertion on storage calls alone.
 */
function seed(doomed: ChatSessionMeta): string {
  useSessions.setState({
    sessions: [meta({ id: "keeper", sessionPath: "D:/sessions/keeper.jsonl" }), doomed],
    activeId: "keeper",
  });
  return doomed.id;
}

test("deleting a conversation delegates the complete recycle operation to the repository", async () => {
  const { order, restore } = harness();
  try {
    const id = seed(meta({ id: "doomed", sessionPath: "D:/sessions/doomed.jsonl" }));

    await useSessions.getState().deleteSession(id);

    assert.deepEqual(order, ["delete:doomed"]);
    assert.deepEqual(
      useSessions.getState().sessions.map((session) => session.id),
      ["keeper"],
    );
  } finally {
    restore();
  }
});

test("a failed index delete keeps the row and never touches the transcript", async () => {
  const { order, restore } = harness({ delete: true });
  try {
    const id = seed(meta({ id: "doomed", sessionPath: "D:/sessions/doomed.jsonl" }));

    await useSessions.getState().deleteSession(id);

    assert.deepEqual(order, ["delete:doomed"]);
    assert.deepEqual(
      useSessions.getState().sessions.map((session) => session.id).sort(),
      ["doomed", "keeper"],
    );
  } finally {
    restore();
  }
});

test("an SSH conversation keeps its transcript — it lives on the remote host", async () => {
  const { order, restore } = harness();
  try {
    const id = seed(
      meta({
        id: "remote",
        sessionPath: "/root/.pi/agent/sessions/--root-project--/a.jsonl",
        executionBinding: SSH_BINDING,
      }),
    );

    await useSessions.getState().deleteSession(id);

    assert.deepEqual(order, ["delete:remote"]);
  } finally {
    restore();
  }
});

test("a conversation that never ran has no transcript to move", async () => {
  const { order, restore } = harness();
  try {
    const id = seed(meta({ id: "empty", sessionPath: "" }));

    await useSessions.getState().deleteSession(id);

    assert.deepEqual(order, ["delete:empty"]);
  } finally {
    restore();
  }
});

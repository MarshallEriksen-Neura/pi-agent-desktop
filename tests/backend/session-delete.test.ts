import assert from "node:assert/strict";
import test from "node:test";

import type { SessionRepositoryPort } from "../../src/lib/backend/ports";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import type { ChatSessionMeta } from "../../src/lib/pi/sessions";
import {
  configureSessionDependenciesForTests,
  trashableTranscript,
  useSessions,
} from "../../src/lib/pi/sessions";

/**
 * Deleting a conversation has to reach two stores: the SQLite index row and pi's
 * own transcript. Before this, only the row went — Desktop reported the
 * conversation deleted while the CLI still listed it, and the orphan transcripts
 * accumulated indefinitely.
 *
 * What is worth locking here is the *order* and the *failure asymmetry*, because
 * both are easy to "simplify" into a bug: moving the file first turns a delete
 * whose row write failed into silent data loss, and letting a failed file move
 * abort the delete puts the row back after the user was told it was gone.
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

function harness(failures: { delete?: boolean; trash?: boolean } = {}): Harness {
  const order: string[] = [];
  const repository = {
    list: async () => [],
    load: async () => [],
    save: async () => {},
    rename: async () => {},
    delete: async (id: string) => {
      order.push(`delete:${id}`);
      if (failures.delete) throw new Error("index write failed");
    },
    trashSessionFile: async (path: string) => {
      order.push(`trash:${path}`);
      if (failures.trash) throw new Error("rename failed");
    },
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

test("deleting a conversation removes the index row, then pi's transcript", async () => {
  const { order, restore } = harness();
  try {
    const id = seed(meta({ id: "doomed", sessionPath: "D:/sessions/doomed.jsonl" }));

    await useSessions.getState().deleteSession(id);

    assert.deepEqual(
      order,
      ["delete:doomed", "trash:D:/sessions/doomed.jsonl"],
      "the row must go first: a transcript moved out from under a surviving row " +
        "would be recreated empty by the next --session resume",
    );
    assert.deepEqual(
      useSessions.getState().sessions.map((session) => session.id),
      ["keeper"],
    );
  } finally {
    restore();
  }
});

test("a failed transcript move still leaves the conversation deleted", async () => {
  const { order, restore } = harness({ trash: true });
  try {
    const id = seed(meta({ id: "doomed", sessionPath: "D:/sessions/doomed.jsonl" }));

    await useSessions.getState().deleteSession(id);

    assert.deepEqual(order, ["delete:doomed", "trash:D:/sessions/doomed.jsonl"]);
    assert.deepEqual(
      useSessions.getState().sessions.map((session) => session.id),
      ["keeper"],
      "an orphan transcript is the pre-existing state, not a reason to restore the row",
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

test("trashableTranscript states the policy on its own", () => {
  assert.equal(trashableTranscript(undefined), null);
  assert.equal(trashableTranscript(meta({ id: "a", sessionPath: "  " })), null);
  assert.equal(
    trashableTranscript(meta({ id: "b", sessionPath: "D:/s/a.jsonl", executionBinding: SSH_BINDING })),
    null,
  );
  assert.equal(
    trashableTranscript(meta({ id: "c", sessionPath: " D:/s/a.jsonl " })),
    "D:/s/a.jsonl",
  );
  assert.equal(
    trashableTranscript({ ...meta({ id: "d", sessionPath: "D:/s/a.jsonl" }), executionBinding: undefined }),
    "D:/s/a.jsonl",
    "rows written before executionBinding existed default to local",
  );
});

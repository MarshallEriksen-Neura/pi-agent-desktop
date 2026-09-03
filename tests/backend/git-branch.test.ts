/**
 * The branch label's caching, which is where its bugs would live: the label reads
 * a file the app does not own, on a host that may not be this one, and it has to
 * be right rather than merely cheap.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserBackendPorts } from "../../src/lib/backend/composition/browser";
import {
  configureBrowserBackend,
  resetBackendContainerForTests,
} from "../../src/lib/backend/composition/container";
import { useGitBranch } from "../../src/lib/git-branch";
import type { WorkspaceFsPort } from "../../src/lib/backend/ports/workspace-fs";

interface FakeFs {
  /** Every path asked for, in order — the cost this store exists to control. */
  reads: string[];
  files: Map<string, string>;
}

/** A filesystem holding exactly these files; anything else rejects, as ports do. */
function withFiles(files: Record<string, string>): { state: FakeFs; port: WorkspaceFsPort } {
  const state: FakeFs = { reads: [], files: new Map(Object.entries(files)) };
  const port = {
    readFile: async (path: string) => {
      state.reads.push(path);
      const hit = state.files.get(path);
      if (hit === undefined) throw new Error(`no such file: ${path}`);
      return hit;
    },
  } as unknown as WorkspaceFsPort;
  return { state, port };
}

/** Async on purpose: a sync `finally` would reset the container mid-body. */
async function withBackend(port: WorkspaceFsPort, run: () => Promise<void>): Promise<void> {
  resetBackendContainerForTests();
  configureBrowserBackend({
    ...createBrowserBackendPorts(),
    createWorkspaceFs: () => port,
  });
  try {
    await run();
  } finally {
    resetBackendContainerForTests();
  }
}

/**
 * The store resolves fire-and-forget, so drain what it queued.
 *
 * Generously more turns than the longest read chain, which is what lets a test
 * assert that an *extra* read did not happen rather than only that one did.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("remembers which HEAD answered, so a refresh is one read and not a search", async () => {
  const { state, port } = withFiles({ "/srv/app/.git/HEAD": "ref: refs/heads/main\n" });
  await withBackend(port, async () => {
    useGitBranch.getState().ensure({ root: "/srv/app", targetId: "local", mock: false });
    await flush();

    assert.deepEqual(useGitBranch.getState().head, { kind: "branch", name: "main" });
    assert.equal(useGitBranch.getState().headPath, "/srv/app/.git/HEAD");

    // Inside the staleness window `ensure` does nothing: it is called from an
    // effect, and a file read per render is not a thing a label gets to do.
    state.reads.length = 0;
    useGitBranch.getState().ensure({ root: "/srv/app", targetId: "local", mock: false });
    await flush();
    assert.deepEqual(state.reads, []);

    // `refresh` — window focus, a finished turn, the local poll — re-reads, and
    // goes straight to the file that answered before.
    useGitBranch.getState().refresh({ root: "/srv/app", targetId: "local", mock: false });
    await flush();
    assert.deepEqual(state.reads, ["/srv/app/.git/HEAD"]);
    assert.deepEqual(useGitBranch.getState().head, { kind: "branch", name: "main" });
  });
});

test("a project switch drops the old branch before the new read lands", async () => {
  const { port } = withFiles({ "/srv/app/.git/HEAD": "ref: refs/heads/main\n" });
  await withBackend(port, async () => {
    useGitBranch.getState().ensure({ root: "/srv/app", targetId: "local", mock: false });
    await flush();
    assert.ok(useGitBranch.getState().head);

    useGitBranch.getState().ensure({ root: "/srv/other", targetId: "local", mock: false });
    // Synchronously, before anything is read: leaving it would print one project's
    // branch beside another project's name for as long as the read takes.
    assert.equal(useGitBranch.getState().head, null);
    assert.equal(useGitBranch.getState().headPath, null);

    await flush();
    assert.equal(useGitBranch.getState().head, null);
    assert.equal(useGitBranch.getState().key, "local /srv/other");
  });
});

test("a remote target reads the directory it was given and stops there", async () => {
  const { state, port } = withFiles({ "/srv/repo/.git/HEAD": "ref: refs/heads/main\n" });
  await withBackend(port, async () => {
    useGitBranch
      .getState()
      .ensure({ root: "/srv/repo/apps/web", targetId: "ssh:prod-1", mock: false });
    await flush();

    // The repository is one level up, and the label stays hidden rather than
    // spending an ssh process per ancestor to find it. Two reads: HEAD, then the
    // `.git` pointer a linked worktree would leave in its place.
    assert.equal(useGitBranch.getState().head, null);
    assert.deepEqual(state.reads, [
      "/srv/repo/apps/web/.git/HEAD",
      "/srv/repo/apps/web/.git",
    ]);

    // The same path locally does climb, because there a miss costs a failed stat.
    // Same root, different host — and the pair is the identity, so this is a
    // different question with a different answer.
    useGitBranch
      .getState()
      .ensure({ root: "/srv/repo/apps/web", targetId: "local", mock: false });
    await flush();
    assert.deepEqual(useGitBranch.getState().head, { kind: "branch", name: "main" });
    assert.equal(useGitBranch.getState().headPath, "/srv/repo/.git/HEAD");
  });
});

test("a HEAD that stops answering is re-searched, not reported stale", async () => {
  const { state, port } = withFiles({
    "/srv/wt/.git": "gitdir: /srv/repo/.git/worktrees/wt\n",
    "/srv/repo/.git/worktrees/wt/HEAD": "ref: refs/heads/spike\n",
  });
  await withBackend(port, async () => {
    useGitBranch.getState().ensure({ root: "/srv/wt", targetId: "local", mock: false });
    await flush();
    assert.deepEqual(useGitBranch.getState().head, { kind: "branch", name: "spike" });

    // `git worktree remove` — the file the label has been re-reading is gone.
    state.files.delete("/srv/repo/.git/worktrees/wt/HEAD");
    state.files.delete("/srv/wt/.git");
    useGitBranch.getState().refresh({ root: "/srv/wt", targetId: "local", mock: false });
    await flush();

    assert.equal(useGitBranch.getState().head, null);
    assert.equal(useGitBranch.getState().headPath, null);
  });
});

test("browser preview shows a branch without a filesystem to read", async () => {
  // The preview is where this label gets looked at during design review, and its
  // root is the empty string — so it answers from nothing rather than reading.
  const { state, port } = withFiles({});
  await withBackend(port, async () => {
    useGitBranch.getState().ensure({ root: "", targetId: "local", mock: true });
    await flush();

    assert.deepEqual(useGitBranch.getState().head, { kind: "branch", name: "main" });
    assert.deepEqual(state.reads, []);
  });
});

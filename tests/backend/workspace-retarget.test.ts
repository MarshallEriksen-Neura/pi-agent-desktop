/**
 * Switching execution target must repoint the workspace.
 *
 * `switchExecutionTarget` reset sessions, the task registry and the active id,
 * but never touched the workspace store. Switching a conversation to an SSH
 * target therefore left the file tree showing the *local* project — same root,
 * same entries, same open documents — with nothing marking them as belonging to
 * another host.
 *
 * That was invisible only because `openProject`/`pickProject` early-returned
 * under SSH, so the stale tree was inert. Once remote reads exist (V2.3), one
 * store would hold entries from two hosts keyed by bare path, and
 * `docs["/src/main.rs"]` becomes ambiguous.
 *
 * Lives in the isolated entry because it drives the real workspace store.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserBackendPorts } from "../../src/lib/backend/composition/browser";
import {
  configureBrowserBackend,
  resetBackendContainerForTests,
} from "../../src/lib/backend/composition/container";
import { useWorkspace } from "../../src/lib/workspace";
import { LOCAL_WORKSPACE_TARGET } from "../../src/lib/workspace-target";
import { useUI } from "../../src/lib/store";

function seedLocalTree(): void {
  useWorkspace.setState({
    root: "D:/project",
    targetId: LOCAL_WORKSPACE_TARGET,
    entries: { "D:/project": [{ name: "main.rs", path: "D:/project/main.rs", isDir: false }] },
    expanded: { "D:/project": true },
    docs: { "D:/project/main.rs": "fn main() {}" },
    loadError: null,
  });
  useUI.getState().setActiveFile("D:/project/main.rs");
}

test("retargeting to a remote host drops the previous host's tree and documents", () => {
  resetBackendContainerForTests();
  configureBrowserBackend(createBrowserBackendPorts());
  try {
    seedLocalTree();
    useWorkspace.getState().retarget("ssh:prod-1");

    const state = useWorkspace.getState();
    assert.equal(state.targetId, "ssh:prod-1");
    assert.equal(state.root, null, "the previous host's root is not valid here");
    assert.deepEqual(state.entries, {}, "tree entries name files on another machine");
    assert.deepEqual(state.docs, {}, "open documents came from another machine");
    assert.deepEqual(state.expanded, {});
    assert.equal(
      useUI.getState().activeFile,
      "",
      "an editor left open on the previous host's file would show foreign content under a remote path",
    );
  } finally {
    resetBackendContainerForTests();
  }
});

test("retargeting to the same target is a no-op", () => {
  resetBackendContainerForTests();
  configureBrowserBackend(createBrowserBackendPorts());
  try {
    seedLocalTree();
    useWorkspace.getState().retarget(LOCAL_WORKSPACE_TARGET);

    const state = useWorkspace.getState();
    assert.equal(state.root, "D:/project", "an idempotent switch must not blank the tree");
    assert.equal(state.docs["D:/project/main.rs"], "fn main() {}");
    assert.equal(useUI.getState().activeFile, "D:/project/main.rs");
  } finally {
    resetBackendContainerForTests();
  }
});

test("project entry points are inert on a remote target", async () => {
  resetBackendContainerForTests();
  configureBrowserBackend(createBrowserBackendPorts());
  try {
    seedLocalTree();
    useWorkspace.getState().retarget("ssh:prod-1");
    const before = useWorkspace.getState();

    await useWorkspace.getState().openProject("D:/must-not-open");
    await useWorkspace.getState().pickProject();

    const after = useWorkspace.getState();
    assert.equal(after.root, before.root);
    assert.equal(after.targetId, "ssh:prod-1");
    assert.equal(after.switching, false);
    // The guard is now belt-and-braces rather than the thing holding the
    // invariant up: even without it, `fs()` resolves to a refusing port.
    assert.deepEqual(after.entries, {});
  } finally {
    resetBackendContainerForTests();
  }
});

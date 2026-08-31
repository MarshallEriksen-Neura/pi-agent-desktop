/**
 * Host-qualified workspace access (V2.R-1).
 *
 * Before this, `WorkspaceFsPort` was a single global instance and every path was
 * a bare string, so nothing structural stopped a remote path from reaching the
 * local filesystem bridge — only `kind === "ssh"` early-returns scattered
 * through the stores, which had to be remembered at each new call site.
 *
 * Two properties are locked here:
 *
 * 1. An SSH target resolves to a port that *refuses*, never to the local one.
 *    That is what makes the invariant structural rather than remembered.
 * 2. Switching execution target repoints the workspace. Before, it did not:
 *    `switchExecutionTarget` reset sessions and tasks but left the tree showing
 *    the previous host's project with nothing marking it stale.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserBackendPorts } from "../../src/lib/backend/composition/browser";
import {
  configureBrowserBackend,
  getPort,
  resetBackendContainerForTests,
} from "../../src/lib/backend/composition/container";
import {
  isRemoteWorkspaceUnsupported,
  REMOTE_WORKSPACE_UNSUPPORTED,
} from "../../src/lib/backend/ports/remote-workspace-fs";
import {
  LOCAL_WORKSPACE_TARGET,
  workspaceFsFor,
  workspaceTargetIdFor,
} from "../../src/lib/workspace-target";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";

const SSH_BINDING: ExecutionBinding = {
  kind: "ssh",
  profileId: "prod-1",
  profileRevision: 4,
  hostAlias: "prod",
  remoteCwd: "/srv/app",
  launcherProtocolVersion: 1,
};

const LOCAL_BINDING: ExecutionBinding = { kind: "local", targetId: "local" };

/** Async on purpose: a sync `finally` would reset the container mid-body. */
async function withBackend(run: () => Promise<void>): Promise<void> {
  resetBackendContainerForTests();
  configureBrowserBackend(createBrowserBackendPorts());
  try {
    await run();
  } finally {
    resetBackendContainerForTests();
  }
}

test("target ids follow the binding, matching the pi-process target", () => {
  assert.equal(workspaceTargetIdFor(LOCAL_BINDING), "local");
  assert.equal(workspaceTargetIdFor(SSH_BINDING), "ssh:prod-1");
  // A missing binding is local: the store's default before any switch.
  assert.equal(workspaceTargetIdFor(null), "local");
  assert.equal(workspaceTargetIdFor(undefined), "local");
});

test("an SSH target never resolves to the local filesystem", async () => {
  await withBackend(async () => {
    const local = workspaceFsFor(LOCAL_WORKSPACE_TARGET);
    const remote = workspaceFsFor("ssh:prod-1");
    assert.notEqual(
      remote,
      local,
      "a remote target resolving to the local port is the bug this refactor removes",
    );

    // Every method refuses, including the read half: V2.3 implements reads, V2.4
    // writes. A port that refused only writes would let a remote path be read
    // through the local bridge.
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["root", () => remote.root()],
      ["listDir", () => remote.listDir("/srv/app")],
      ["readFile", () => remote.readFile("/srv/app/main.rs")],
      ["readFileBase64", () => remote.readFileBase64("/srv/app/logo.png")],
      ["writeFile", () => remote.writeFile("/srv/app/main.rs", "x")],
      ["createFile", () => remote.createFile("/srv/app/new.rs")],
      ["createDir", () => remote.createDir("/srv/app/dir")],
      ["deleteEntry", () => remote.deleteEntry("/srv/app/main.rs")],
      ["renameEntry", () => remote.renameEntry("/srv/app/a", "/srv/app/b")],
    ];
    for (const [name, call] of calls) {
      await assert.rejects(
        call,
        (error: unknown) => {
          assert.ok(
            isRemoteWorkspaceUnsupported(error),
            `${name} must refuse with the stable code, not an arbitrary error`,
          );
          assert.equal((error as { code: string }).code, REMOTE_WORKSPACE_UNSUPPORTED);
          return true;
        },
        `${name} must refuse on a remote target`,
      );
    }
  });
});

test("the local target still resolves to a working filesystem", async () => {
  await withBackend(async () => {
    const local = workspaceFsFor(LOCAL_WORKSPACE_TARGET);
    const root = await local.root();
    assert.equal(typeof root, "string");
    // Same instance as the default port, so a caller that never learned about
    // targets is unaffected by this refactor.
    assert.equal(local, getPort("workspaceFs"));
  });
});

test("a stale error code cannot silently pass the unsupported check", () => {
  assert.equal(isRemoteWorkspaceUnsupported(new Error("nope")), false);
  assert.equal(isRemoteWorkspaceUnsupported({ code: "somethingElse" }), false);
  assert.equal(isRemoteWorkspaceUnsupported(null), false);
  assert.equal(isRemoteWorkspaceUnsupported({ code: REMOTE_WORKSPACE_UNSUPPORTED }), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import { useWorkspace } from "../../src/lib/workspace";
import { workspaceTargetIdFor, LOCAL_WORKSPACE_TARGET } from "../../src/lib/workspace-target";

const REMOTE_BINDING: ExecutionBinding = {
  kind: "ssh",
  profileId: "guard-test",
  profileRevision: 1,
  hostAlias: "guard-host",
  remoteCwd: "/srv/guard",
  launcherProtocolVersion: 1,
};

/**
 * Drives the workspace's own target rather than the session store's binding.
 *
 * This test used to call `useSessions().setExecutionBinding`, which no longer
 * gates the workspace — and never did in production: the only caller of a target
 * change is `switchExecutionTarget`, which announces through the registered seam
 * so the workspace repoints itself. A bare `setExecutionBinding` has no
 * production caller at all, so asserting the guard through it was testing a path
 * the app does not take.
 */
test("workspace project entry points are inert while an SSH target is active", async () => {
  const before = useWorkspace.getState();
  useWorkspace.getState().retarget(workspaceTargetIdFor(REMOTE_BINDING));
  try {
    await useWorkspace.getState().openProject("D:/must-not-open");
    await useWorkspace.getState().pickProject();
    const after = useWorkspace.getState();
    assert.equal(after.root, null, "retarget cleared the root; opening must not restore one");
    assert.equal(after.switching, false);
    assert.equal(after.loadError, null);
  } finally {
    useWorkspace.getState().retarget(LOCAL_WORKSPACE_TARGET);
    useWorkspace.setState({ root: before.root, loadError: before.loadError });
  }
});

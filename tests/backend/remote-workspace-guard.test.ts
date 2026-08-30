import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import { useSessions } from "../../src/lib/pi/sessions";
import { useWorkspace } from "../../src/lib/workspace";

const REMOTE_BINDING: ExecutionBinding = {
  kind: "ssh",
  profileId: "guard-test",
  profileRevision: 1,
  hostAlias: "guard-host",
  remoteCwd: "/srv/guard",
  launcherProtocolVersion: 1,
};

test("workspace project entry points are inert while an SSH target is active", async () => {
  const previousBinding = useSessions.getState().executionBinding;
  const before = useWorkspace.getState();
  useSessions.getState().setExecutionBinding(REMOTE_BINDING);
  try {
    await useWorkspace.getState().openProject("D:/must-not-open");
    await useWorkspace.getState().pickProject();
    const after = useWorkspace.getState();
    assert.equal(after.root, before.root);
    assert.equal(after.switching, false);
    assert.equal(after.loadError, before.loadError);
  } finally {
    useSessions.getState().setExecutionBinding(previousBinding);
  }
});

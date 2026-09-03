import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopRemotePiManagement } from "../../src/lib/backend/desktop/remote-pi-management";
import type { PiManagementSnapshot } from "../../src/lib/backend/ports/pi-management";

const binding = {
  kind: "ssh" as const,
  profileId: "prod",
  profileRevision: 7,
  hostAlias: "prod.example",
  launcherProtocolVersion: 1,
  remoteCwd: "/srv/app",
};

function snapshot(): PiManagementSnapshot {
  return {
    targetKey: "remote",
    stateToken: "sha256-test",
    globalSettings: { path: "$HOME/.pi/agent/settings.json", exists: false, content: "{}" },
    projectSettings: { path: "$PROJECT/.pi/settings.json", exists: false, content: "{}" },
    packageLocks: { global: null, project: null },
    skills: [],
    unscannableSkills: [],
    skillLocks: {},
  };
}

test("remote management normalizes inspect and mutation snapshots to the binding target", async () => {
  const port = createDesktopRemotePiManagement(binding, {
    invoke: async <T>(_command: string, args?: Record<string, unknown>): Promise<T> => {
      const request = args?.request as { operation?: string } | undefined;
      const result = request?.operation === "inspect"
        ? snapshot()
        : { code: 0, stdout: "", stderr: "", snapshot: snapshot() };
      return { ok: true, operation: request?.operation, result } as T;
    },
  });
  const targetKey = "ssh:prod@7:/srv/app";

  assert.equal((await port.inspect()).targetKey, targetKey);
  assert.equal((await port.mutatePackage({
    operation: "updateAll",
    expectedState: "sha256-test",
  })).snapshot.targetKey, targetKey);
  assert.equal((await port.mutateSkill({
    operation: "updateAll",
    scope: "project",
    expectedState: "sha256-test",
  })).snapshot.targetKey, targetKey);
});

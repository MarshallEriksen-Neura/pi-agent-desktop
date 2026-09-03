import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopPiManagementFactory } from "../../src/lib/backend/desktop/pi-management";
import type { PiConfigurationPort } from "../../src/lib/backend/ports";

function configuration(runPiCli: PiConfigurationPort["runPiCli"]): PiConfigurationPort {
  return {
    readSettings: async (scope) => ({
      path: scope === "global" ? "/home/test/.pi/agent/settings.json" : "/project/.pi/settings.json",
      exists: false,
      content: "{}",
    }),
    writeSettings: async () => {},
    readMcpConfig: async () => ({ path: "", exists: false, content: "{}" }),
    writeMcpConfig: async () => {},
    openMcpConfigDirectory: async () => {},
    checkMcpAdapter: async () => ({ installed: false, otherConfigPaths: [] }),
    discoverMcpSources: async () => [],
    fetchModels: async () => [],
    runPiCli,
    runSkillsCli: async () => ({ code: 0, stdout: "", stderr: "" }),
    searchSkills: async () => [],
    checkPiCliUpdate: async () => ({ installed: null, latest: null, updateAvailable: false }),
    readSkillFile: async () => {
      throw new Error("missing");
    },
    listSkillDirectory: async () => [],
    readPackageLock: async () => null,
  };
}

test("local package mutations explicitly approve project configuration", async () => {
  const calls: Array<{ args: string[]; cwd?: string | null }> = [];
  const factory = createDesktopPiManagementFactory(
    configuration(async (args, cwd) => {
      calls.push({ args, cwd });
      return { code: 0, stdout: "", stderr: "" };
    }),
    () => {
      throw new Error("remote port should not be created");
    },
  );
  const port = factory(undefined, "/project");
  const snapshot = await port.inspect();

  await port.mutatePackage({
    operation: "install",
    scope: "project",
    source: "npm:pi-subagents",
    expectedState: snapshot.stateToken,
  });

  assert.deepEqual(calls, [{
    args: ["install", "npm:pi-subagents", "-l", "--approve"],
    cwd: "/project",
  }]);
});

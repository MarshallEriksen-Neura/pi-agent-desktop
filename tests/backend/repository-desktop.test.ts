import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopRepositoryPort } from "../../src/lib/backend/desktop/repository";
import type { LauncherCapabilities } from "../../src/lib/backend/ports/execution-target";

const localBinding = { kind: "local" as const, targetId: "local" as const };
const sshBinding = {
  kind: "ssh" as const,
  profileId: "profile-1",
  profileRevision: 7,
  hostAlias: "build-host",
  remoteCwd: "/srv/work",
  launcherProtocolVersion: 1,
};

function capabilities(names: string[]): LauncherCapabilities {
  return {
    host: "build-host",
    launcherPath: "/home/dev/.local/bin/pi-desktop-launcher",
    launcherProtocolVersion: 1,
    launcherRevision: 6,
    statusVersion: 1,
    capabilities: names,
    supportsCapabilityQuery: true,
  };
}

test("desktop repository status uses the local Tauri command and parses porcelain", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return {
        ok: true,
        repoRoot: "/work",
        porcelain: "# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0? new.ts\0",
        generation: "backend-status-generation",
        operation: null,
      } as T;
    },
  });

  const result = await port.status({
    targetId: "local",
    workspaceRoot: "/work/subdir",
    executionBinding: localBinding,
  });
  assert.equal(result.kind, "repository");
  if (result.kind !== "repository") return;
  assert.equal(result.repoRoot, "/work");
  assert.equal(result.files[0]?.path, "new.ts");
  assert.deepEqual(calls, [{ command: "repository_status", args: { workspaceRoot: "/work/subdir" } }]);
});

test("SSH repository status fails closed when the launcher lacks repository-read-v1", async () => {
  const calls: string[] = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string): Promise<T> {
      calls.push(command);
      return capabilities(["workspace-v1"]) as T;
    },
  });

  const result = await port.status({
    targetId: "ssh:profile-1",
    workspaceRoot: "/srv/work",
    executionBinding: sshBinding,
  });
  assert.deepEqual(result, {
    kind: "unavailable",
    targetId: "ssh:profile-1",
    workspaceRoot: "/srv/work",
    reason: "remoteUnsupported",
  });
  assert.deepEqual(calls, ["remote_profile_capabilities"]);
});

test("SSH repository diff is capability-gated and preserves repository identity", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-read-v1"]) as T;
      }
      return { ok: true, text: "diff --git a/src/a.ts b/src/a.ts\n", truncated: false } as T;
    },
  });

  const result = await port.diff({
    targetId: "ssh:profile-1",
    workspaceRoot: "/srv/work",
    repoRoot: "/srv/work",
    executionBinding: sshBinding,
    path: "src/a.ts",
    diffKind: "staged",
  });
  assert.deepEqual(result.identity, {
    targetId: "ssh:profile-1",
    workspaceRoot: "/srv/work",
    repoRoot: "/srv/work",
  });
  assert.equal(calls[1]?.command, "remote_repository_request");
  assert.deepEqual(calls[1]?.args, {
    id: "profile-1",
    profileRevision: 7,
    operation: "diff",
    workspaceRoot: "/srv/work",
    repoRoot: "/srv/work",
    path: "src/a.ts",
    diffKind: "staged",
  });
});

test("local repository mutation binds identity and generation to the Tauri command", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return {
        ok: true, repoRoot: "/work",
        porcelain: "# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0",
        generation: "backend-mutation-generation",
        repositoryOperation: null, commitOid: null, applied: true,
      } as T;
    },
  });
  const result = await port.mutate({
    operation: "stage", targetId: "local", workspaceRoot: "/work", repoRoot: "/work",
    executionBinding: localBinding, generation: "repo-generation", path: "src/a.ts",
    originalPath: "src/old.ts",
  });
  assert.equal(result.kind, "success");
  assert.deepEqual(calls, [{
    command: "repository_mutate",
    args: { workspaceRoot: "/work", repoRoot: "/work", generation: "repo-generation",
      operation: "stage", path: "src/a.ts", originalPath: "src/old.ts", targetId: "local" },
  }]);
});

test("SSH repository writes require repository-write-v1 independently of reads", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-read-v1"]) as T;
      }
      throw new Error("write transport must not be reached");
    },
  });
  const result = await port.mutate({
    operation: "commit", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "repo-generation",
    message: "Reviewed change",
  });
  assert.deepEqual(result, {
    kind: "failure", operation: "commit", reason: "remoteUnsupported", applied: false,
    detail: "The remote launcher does not support repository writes.",
  });
  assert.deepEqual(calls.map((call) => call.command), ["remote_profile_capabilities"]);
});

test("SSH repository mutation sends only the capability-gated mutation payload", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-write-v1"]) as T;
      }
      return { ok: false, reason: "staleGeneration", detail: "changed", applied: false } as T;
    },
  });
  const result = await port.mutate({
    operation: "unstage", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "repo-generation",
    path: "src/a.ts",
  });
  assert.equal(result.kind, "failure");
  assert.deepEqual(calls[1], {
    command: "remote_repository_request",
    args: { id: "profile-1", profileRevision: 7, workspaceRoot: "/srv/work",
      repoRoot: "/srv/work", generation: "repo-generation", operation: "unstage",
      path: "src/a.ts", originalPath: null },
  });
});

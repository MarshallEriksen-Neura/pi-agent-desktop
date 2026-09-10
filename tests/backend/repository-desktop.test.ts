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

test("local repository batch mutation serializes one exact reviewed request", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return {
        ok: true, repoRoot: "/work",
        porcelain: "# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0",
        generation: "backend-batch-generation",
        repositoryOperation: null, commitOid: null, applied: true,
      } as T;
    },
  });
  const result = await port.mutate({
    operation: "stageBatch", targetId: "local", workspaceRoot: "/work", repoRoot: "/work",
    executionBinding: localBinding, generation: "repo-generation",
    files: [{ path: "src/a.ts" }, { path: "src/new.ts", originalPath: "src/old.ts" }],
  });
  assert.equal(result.kind, "success");
  assert.deepEqual(calls, [{
    command: "repository_mutate",
    args: {
      workspaceRoot: "/work", repoRoot: "/work", generation: "repo-generation",
      operation: "stageBatch", targetId: "local", files: [
        { path: "src/a.ts", originalPath: null },
        { path: "src/new.ts", originalPath: "src/old.ts" },
      ],
    },
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


test("SSH repository batch mutation requires its independent capability and normalizes rename fields", async () => {
  const deniedCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const deniedPort = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      deniedCalls.push({ command, args });
      return capabilities(["repository-write-v1"]) as T;
    },
  });
  const request = {
    operation: "stageBatch" as const, targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "repo-generation",
    files: [{ path: "src/a.ts" }, { path: "src/new.ts", originalPath: "src/old.ts" }],
  };
  const denied = await deniedPort.mutate(request);
  assert.deepEqual(denied, {
    kind: "failure", operation: "stageBatch", reason: "remoteUnsupported", applied: false,
    detail: "Update the remote launcher to stage or unstage reviewed file batches.",
  });
  assert.deepEqual(deniedCalls.map((call) => call.command), ["remote_profile_capabilities"]);

  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-batch-write-v1"]) as T;
      }
      return { ok: false, reason: "staleGeneration", detail: "changed", applied: false } as T;
    },
  });
  await port.mutate(request);
  assert.deepEqual(calls[1], {
    command: "remote_repository_request",
    args: { id: "profile-1", profileRevision: 7, workspaceRoot: "/srv/work",
      repoRoot: "/srv/work", generation: "repo-generation", operation: "stageBatch",
      files: [
        { path: "src/a.ts", originalPath: null },
        { path: "src/new.ts", originalPath: "src/old.ts" },
      ] },
  });
});
test("SSH repository batch capability-probe failures are definitely non-applied", async () => {
  const port = createDesktopRepositoryPort({
    async invoke<T>(): Promise<T> {
      throw new Error("capability probe unavailable");
    },
  });
  const result = await port.mutate({
    operation: "unstageBatch", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "repo-generation",
    files: [{ path: "src/a.ts", originalPath: null }],
  });
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.operation, "unstageBatch");
    assert.equal(result.reason, "remoteUnsupported");
    assert.equal(result.applied, false);
    assert.match(result.detail ?? "", /capability probe unavailable/);
  }
});

test("SSH Phase 3 fails closed on older launchers", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return capabilities(["repository-read-v1", "repository-write-v1"]) as T;
    },
  });
  const result = await port.action({
    operation: "fetch", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "reviewed", remote: "origin",
  });
  assert.deepEqual(result, {
    kind: "failure", operation: "fetch", reason: "remoteUnsupported",
    detail: "Update the remote launcher to use repository sync and branches.", applied: false,
  });
  assert.deepEqual(calls.map((call) => call.command), ["remote_profile_capabilities"]);
});

test("SSH Phase 3 serializes only the reviewed push destination state", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-phase3-v1"]) as T;
      }
      return { ok: false, reason: "nonFastForward", detail: "rejected", applied: false } as T;
    },
  });
  const result = await port.action({
    operation: "push", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "reviewed",
    expectedHeadOid: "1".repeat(40), expectedUpstreamOid: "2".repeat(40),
    expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
  });
  assert.equal(result.kind, "failure");
  assert.deepEqual(calls[1], {
    command: "remote_repository_request",
    args: { id: "profile-1", profileRevision: 7, workspaceRoot: "/srv/work",
      repoRoot: "/srv/work", generation: "reviewed", operation: "push",
      expectedHeadOid: "1".repeat(40), expectedUpstreamOid: "2".repeat(40),
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main" }
  });
});

test("SSH Phase 3 preserves the typed unavailable-credentials failure", async () => {
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string): Promise<T> {
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-phase3-v1"]) as T;
      }
      return {
        ok: false, reason: "remoteAuthenticationUnavailable",
        detail: "Git credentials for this HTTPS remote are unavailable.", applied: false,
      } as T;
    },
  });
  const result = await port.action({
    operation: "fetch", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "reviewed", remote: "origin",
  });
  assert.deepEqual(result, {
    kind: "failure", operation: "fetch", reason: "remoteAuthenticationUnavailable",
    detail: "Git credentials for this HTTPS remote are unavailable.", applied: false,
  });
});

test("local staged diff and branch actions use the dedicated Phase 3 command", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (args?.operation === "stagedDiff") return { ok: true, text: "diff" } as T;
      return {
        ok: true, repoRoot: "/work", porcelain: "# branch.oid 1111111111111111111111111111111111111111\0# branch.head topic\0",
        generation: "refreshed", repositoryOperation: null, remotes: [],
        branches: [{ name: "topic", oid: "1".repeat(40) }], applied: true,
      } as T;
    },
  });
  const staged = await port.stagedDiff({
    targetId: "local", workspaceRoot: "/work", repoRoot: "/work",
    executionBinding: localBinding, generation: "reviewed",
  });
  assert.equal(staged.text, "diff");
  const created = await port.action({
    operation: "createBranch", targetId: "local", workspaceRoot: "/work", repoRoot: "/work",
    executionBinding: localBinding, generation: "reviewed", branchName: "topic",
    expectedHeadOid: "1".repeat(40),
  });
  assert.equal(created.kind, "success");
  assert.deepEqual(calls, [
    { command: "repository_phase3", args: { targetId: "local", workspaceRoot: "/work",
      repoRoot: "/work", generation: "reviewed", operation: "stagedDiff" } },
    { command: "repository_phase3", args: { targetId: "local", workspaceRoot: "/work",
      repoRoot: "/work", generation: "reviewed", operation: "createBranch", branchName: "topic",
      expectedHeadOid: "1".repeat(40) } },
  ]);
});

test("local Phase 4 integration uses the dedicated command and exact reviewed snapshot", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return {
        ok: true, repoRoot: "/work",
        porcelain: `# branch.oid ${"2".repeat(40)}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0`,
        generation: "integrated", repositoryOperation: null,
        upstreamRemote: "origin", upstreamBranch: "main", upstreamOid: "2".repeat(40),
        mergeBaseOid: "2".repeat(40), remotes: ["origin"],
        branches: [{ name: "main", oid: "2".repeat(40) }], applied: true,
      } as T;
    },
  });
  const result = await port.action({
    operation: "integrateFastForward", targetId: "local", workspaceRoot: "/work",
    repoRoot: "/work", executionBinding: localBinding, generation: "reviewed",
    expectedLocalBranch: "main", expectedHeadOid: "1".repeat(40),
    expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
    expectedUpstreamOid: "2".repeat(40), expectedMergeBaseOid: "1".repeat(40),
    strategy: "fastForwardOnly",
  });
  assert.equal(result.kind, "success");
  if (result.kind === "success") assert.equal(result.snapshot.mergeBaseOid, "2".repeat(40));
  assert.deepEqual(calls, [{
    command: "repository_phase4",
    args: {
      targetId: "local", workspaceRoot: "/work", repoRoot: "/work", generation: "reviewed",
      operation: "integrateFastForward", expectedLocalBranch: "main",
      expectedHeadOid: "1".repeat(40), expectedUpstreamRemote: "origin",
      expectedUpstreamBranch: "main", expectedUpstreamOid: "2".repeat(40),
      expectedMergeBaseOid: "1".repeat(40), strategy: "fastForwardOnly",
    },
  }]);
});

test("SSH Phase 4 fails closed when only the Phase 3 capability is available", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return capabilities(["repository-phase3-v1"]) as T;
    },
  });
  const result = await port.action({
    operation: "integrateFastForward", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "reviewed",
    expectedLocalBranch: "main", expectedHeadOid: "1".repeat(40),
    expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
    expectedUpstreamOid: "2".repeat(40), expectedMergeBaseOid: "1".repeat(40),
    strategy: "fastForwardOnly",
  });
  assert.deepEqual(result, {
    kind: "failure", operation: "integrateFastForward", reason: "remoteUnsupported",
    detail: "Update the remote launcher to integrate reviewed fast-forwards.", applied: false,
  });
  assert.deepEqual(calls.map((call) => call.command), ["remote_profile_capabilities"]);
});

test("SSH Phase 4 sends only the reviewed fast-forward payload", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-integration-v1"]) as T;
      }
      return { ok: false, reason: "staleGeneration", detail: "changed", applied: false } as T;
    },
  });
  const result = await port.action({
    operation: "integrateFastForward", targetId: "ssh:profile-1", workspaceRoot: "/srv/work",
    repoRoot: "/srv/work", executionBinding: sshBinding, generation: "reviewed",
    expectedLocalBranch: "main", expectedHeadOid: "1".repeat(40),
    expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
    expectedUpstreamOid: "2".repeat(40), expectedMergeBaseOid: "1".repeat(40),
    strategy: "fastForwardOnly",
  });
  assert.equal(result.kind, "failure");
  assert.deepEqual(calls[1], {
    command: "remote_repository_request",
    args: {
      id: "profile-1", profileRevision: 7, workspaceRoot: "/srv/work", repoRoot: "/srv/work",
      generation: "reviewed", operation: "integrateFastForward", expectedLocalBranch: "main",
      expectedHeadOid: "1".repeat(40), expectedUpstreamRemote: "origin",
      expectedUpstreamBranch: "main", expectedUpstreamOid: "2".repeat(40),
      expectedMergeBaseOid: "1".repeat(40), strategy: "fastForwardOnly",
    },
  });
});

test("local Phase 4B routes reviewed merge and rebase payloads to the dedicated command", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return { ok: false, reason: "integrationConflict", detail: "restored", applied: false } as T;
    },
  });
  const common = {
    targetId: "local" as const, workspaceRoot: "/work", repoRoot: "/work",
    executionBinding: localBinding, generation: "reviewed", expectedLocalBranch: "topic",
    expectedHeadOid: "2".repeat(40), expectedUpstreamRemote: "origin",
    expectedUpstreamBranch: "main", expectedUpstreamOid: "3".repeat(40),
    expectedMergeBaseOid: "1".repeat(40),
  };
  const mergeResult = await port.action({ ...common, operation: "integrateMerge", strategy: "mergeCommit", message: "Reviewed merge" });
  const rebaseResult = await port.action({ ...common, operation: "integrateRebase", strategy: "rebaseLinear" });
  assert.equal(mergeResult.kind === "failure" ? mergeResult.reason : null, "integrationConflict");
  assert.equal(mergeResult.kind === "failure" ? mergeResult.applied : null, false);
  assert.equal(rebaseResult.kind === "failure" ? rebaseResult.reason : null, "integrationConflict");
  assert.deepEqual(calls, [
    { command: "repository_phase4b", args: {
      targetId: "local", workspaceRoot: "/work", repoRoot: "/work", generation: "reviewed",
      operation: "integrateMerge", expectedLocalBranch: "topic", expectedHeadOid: "2".repeat(40),
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main", expectedUpstreamOid: "3".repeat(40),
      expectedMergeBaseOid: "1".repeat(40), strategy: "mergeCommit", message: "Reviewed merge",
    } },
    { command: "repository_phase4b", args: {
      targetId: "local", workspaceRoot: "/work", repoRoot: "/work", generation: "reviewed",
      operation: "integrateRebase", expectedLocalBranch: "topic", expectedHeadOid: "2".repeat(40),
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main", expectedUpstreamOid: "3".repeat(40),
      expectedMergeBaseOid: "1".repeat(40), strategy: "rebaseLinear",
    } },
  ]);
});

test("SSH integration capabilities are independent across Phase 4A and Phase 4B", async () => {
  const common = {
    targetId: "ssh:profile-1", workspaceRoot: "/srv/work", repoRoot: "/srv/work",
    executionBinding: sshBinding, generation: "reviewed", expectedLocalBranch: "topic",
    expectedHeadOid: "2".repeat(40), expectedUpstreamRemote: "origin",
    expectedUpstreamBranch: "main", expectedUpstreamOid: "3".repeat(40),
    expectedMergeBaseOid: "1".repeat(40),
  };
  const v1 = createDesktopRepositoryPort({
    async invoke<T>(): Promise<T> { return capabilities(["repository-integration-v1"]) as T; },
  });
  const merge = await v1.action({ ...common, operation: "integrateMerge", strategy: "mergeCommit", message: "Reviewed merge" });
  assert.deepEqual(merge, {
    kind: "failure", operation: "integrateMerge", reason: "remoteUnsupported",
    detail: "Update the remote launcher to integrate reviewed merges and rebases.", applied: false,
  });
  const v2 = createDesktopRepositoryPort({
    async invoke<T>(): Promise<T> { return capabilities(["repository-integration-v2"]) as T; },
  });
  const fastForward = await v2.action({
    ...common, operation: "integrateFastForward", strategy: "fastForwardOnly",
  });
  assert.deepEqual(fastForward, {
    kind: "failure", operation: "integrateFastForward", reason: "remoteUnsupported",
    detail: "Update the remote launcher to integrate reviewed fast-forwards.", applied: false,
  });
});

test("SSH Phase 4B sends exact operation-specific payloads without a rebase message", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createDesktopRepositoryPort({
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_profile_capabilities") {
        return capabilities(["repository-integration-v2"]) as T;
      }
      return { ok: false, reason: "integrationConflict", detail: "restored", applied: false } as T;
    },
  });
  const common = {
    targetId: "ssh:profile-1", workspaceRoot: "/srv/work", repoRoot: "/srv/work",
    executionBinding: sshBinding, generation: "reviewed", expectedLocalBranch: "topic",
    expectedHeadOid: "2".repeat(40), expectedUpstreamRemote: "origin",
    expectedUpstreamBranch: "main", expectedUpstreamOid: "3".repeat(40),
    expectedMergeBaseOid: "1".repeat(40),
  };
  await port.action({ ...common, operation: "integrateMerge", strategy: "mergeCommit", message: "Exact reviewed message" });
  await port.action({ ...common, operation: "integrateRebase", strategy: "rebaseLinear" });
  assert.deepEqual(calls.filter((call) => call.command === "remote_repository_request"), [
    { command: "remote_repository_request", args: {
      id: "profile-1", profileRevision: 7, workspaceRoot: "/srv/work", repoRoot: "/srv/work",
      generation: "reviewed", operation: "integrateMerge", expectedLocalBranch: "topic",
      expectedHeadOid: "2".repeat(40), expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
      expectedUpstreamOid: "3".repeat(40), expectedMergeBaseOid: "1".repeat(40),
      strategy: "mergeCommit", message: "Exact reviewed message",
    } },
    { command: "remote_repository_request", args: {
      id: "profile-1", profileRevision: 7, workspaceRoot: "/srv/work", repoRoot: "/srv/work",
      generation: "reviewed", operation: "integrateRebase", expectedLocalBranch: "topic",
      expectedHeadOid: "2".repeat(40), expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
      expectedUpstreamOid: "3".repeat(40), expectedMergeBaseOid: "1".repeat(40),
      strategy: "rebaseLinear",
    } },
  ]);
});

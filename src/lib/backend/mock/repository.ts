import type { RepositoryPort } from "../ports/repository";

export function createMockRepositoryPort(): RepositoryPort {
  return {
    status: async (request) => ({
      kind: "unavailable",
      targetId: request.targetId,
      workspaceRoot: request.workspaceRoot,
      reason: request.executionBinding.kind === "ssh" ? "remoteUnsupported" : "notRepository",
    }),
    diff: async () => {
      throw new Error("Repository diff is unavailable in browser preview.");
    },
    stagedDiff: async () => {
      throw new Error("Staged repository diff is unavailable in browser preview.");
    },
    mutate: async (request) => ({
      kind: "failure",
      operation: request.operation,
      reason: "remoteUnsupported",
      detail: "Repository writes are unavailable in browser preview.",
      applied: false,
    }),
    action: async (request) => ({
      kind: "failure",
      operation: request.operation,
      reason: "remoteUnsupported",
      detail: "Repository actions are unavailable in browser preview.",
      applied: false,
    }),
  };
}

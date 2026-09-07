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
    mutate: async (request) => ({
      kind: "failure",
      operation: request.operation,
      reason: "remoteUnsupported",
      detail: "Repository writes are unavailable in browser preview.",
      applied: false,
    }),
  };
}

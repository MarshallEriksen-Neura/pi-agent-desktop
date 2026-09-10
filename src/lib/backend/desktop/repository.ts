import { parseRepositoryStatus, type RawRepositoryStatus } from "../repository-parser";
import { hasLauncherCapability, type LauncherCapabilities } from "../ports/execution-target";
import type {
  RepositoryActionOperation,
  RepositoryActionRequest,
  RepositoryActionResult,
  RepositoryDiff,
  RepositoryDiffRequest,
  RepositoryMutationFailureReason,
  RepositoryMutationOperation,
  RepositoryMutationRequest,
  RepositoryMutationResult,
  RepositoryPort,
  RepositoryStagedDiff,
  RepositoryStagedDiffRequest,
  RepositoryStatus,
  RepositoryStatusRequest,
  RepositoryUnavailableReason,
} from "../ports/repository";
import { desktopInvoke } from "./invoke";

interface RawStatusReply {
  ok: boolean;
  repoRoot?: string;
  porcelain?: string;
  generation?: string;
  operation?: RawRepositoryStatus["operation"];
  upstreamRemote?: string | null;
  upstreamBranch?: string | null;
  upstreamOid?: string | null;
  mergeBaseOid?: string | null;
  remotes?: string[];
  branches?: Array<{ name: string; oid: string }>;
  reason?: RepositoryUnavailableReason;
  detail?: string;
}

interface RawDiffReply {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  reason?: RepositoryUnavailableReason;
  detail?: string;
}

interface RawMutationReply {
  ok: boolean;
  repoRoot?: string;
  porcelain?: string;
  generation?: string;
  repositoryOperation?: RawRepositoryStatus["operation"];
  upstreamRemote?: string | null;
  upstreamBranch?: string | null;
  upstreamOid?: string | null;
  mergeBaseOid?: string | null;
  remotes?: string[];
  branches?: Array<{ name: string; oid: string }>;
  commitOid?: string | null;
  reason?: RepositoryMutationFailureReason;
  detail?: string;
  applied?: boolean;
}

interface RawActionReply extends RawMutationReply {
  text?: string;
}

export interface DesktopRepositoryDependencies {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const DEFAULT_DEPENDENCIES: DesktopRepositoryDependencies = {
  invoke: (command, args) => desktopInvoke(command, args),
};

function unavailable(
  request: Pick<RepositoryStatusRequest, "targetId" | "workspaceRoot">,
  reason: RepositoryUnavailableReason,
  detail?: string,
): RepositoryStatus {
  return {
    kind: "unavailable",
    targetId: request.targetId,
    workspaceRoot: request.workspaceRoot,
    reason,
    ...(detail ? { detail } : {}),
  };
}

function validRawStatus(
  reply: RawStatusReply | RawMutationReply,
 ): reply is (RawStatusReply | RawMutationReply) & Required<Pick<RawStatusReply, "repoRoot" | "porcelain" | "generation">> {
  return (
    reply.ok === true &&
    typeof reply.repoRoot === "string" &&
    typeof reply.porcelain === "string" &&
    typeof reply.generation === "string"
  );
}
function snapshotFromReply(
  request: Pick<RepositoryStatusRequest, "targetId" | "workspaceRoot">,
  reply: RawStatusReply | RawMutationReply,
  operation: RawRepositoryStatus["operation"],
 ) {
  if (!validRawStatus(reply)) return null;
  return parseRepositoryStatus({
    targetId: request.targetId,
    workspaceRoot: request.workspaceRoot,
    raw: {
      repoRoot: reply.repoRoot,
      porcelain: reply.porcelain,
      generation: reply.generation,
      operation,
      upstreamRemote: reply.upstreamRemote ?? null,
      upstreamBranch: reply.upstreamBranch ?? null,
      upstreamOid: reply.upstreamOid ?? null,
      mergeBaseOid: reply.mergeBaseOid ?? null,
      remotes: reply.remotes ?? [],
      branches: reply.branches ?? [],
    },
  });
}


export function createDesktopRepositoryPort(
  dependencies: DesktopRepositoryDependencies = DEFAULT_DEPENDENCIES,
): RepositoryPort {
  async function remoteSupported(
    profileId: string,
    capability: "repository-read-v1" | "repository-write-v1" | "repository-batch-write-v1" | "repository-phase3-v1" | "repository-integration-v1" | "repository-integration-v2",
  ): Promise<boolean> {
    const probe = await dependencies.invoke<LauncherCapabilities>("remote_profile_capabilities", { id: profileId });
    return hasLauncherCapability(probe, capability);
  }

  return {
    async status(request): Promise<RepositoryStatus> {
      let reply: RawStatusReply;
      if (request.executionBinding.kind === "ssh") {
        if (!(await remoteSupported(request.executionBinding.profileId, "repository-read-v1"))) {
          return unavailable(request, "remoteUnsupported");
        }
        reply = await dependencies.invoke<RawStatusReply>("remote_repository_request", {
          id: request.executionBinding.profileId,
          profileRevision: request.executionBinding.profileRevision,
          workspaceRoot: request.workspaceRoot,
          operation: "status",
        });
      } else {
        reply = await dependencies.invoke<RawStatusReply>("repository_status", {
          workspaceRoot: request.workspaceRoot,
        });
      }
      const snapshot = snapshotFromReply(request, reply, reply.operation ?? null);
      if (!snapshot) {
        return unavailable(request, reply.reason ?? "gitUnavailable", reply.detail);
      }
      return snapshot;
    },

    async diff(request: RepositoryDiffRequest): Promise<RepositoryDiff> {
      let reply: RawDiffReply;
      const args = {
        workspaceRoot: request.workspaceRoot,
        repoRoot: request.repoRoot,
        path: request.path,
        diffKind: request.diffKind,
      };
      if (request.executionBinding.kind === "ssh") {
        if (!(await remoteSupported(request.executionBinding.profileId, "repository-read-v1"))) {
          throw new Error("remote repository inspection is not supported by this launcher");
        }
        reply = await dependencies.invoke<RawDiffReply>("remote_repository_request", {
          id: request.executionBinding.profileId,
          profileRevision: request.executionBinding.profileRevision,
          operation: "diff",
          ...args,
        });
      } else {
        reply = await dependencies.invoke<RawDiffReply>("repository_diff", args);
      }
      if (reply.ok !== true || typeof reply.text !== "string") {
        throw new Error(reply.detail ?? reply.reason ?? "repository diff failed");
      }
      return {
        identity: {
          targetId: request.targetId,
          workspaceRoot: request.workspaceRoot,
          repoRoot: request.repoRoot,
        },
        path: request.path,
        diffKind: request.diffKind,
        text: reply.text,
        truncated: reply.truncated === true,
      };
    },

    async stagedDiff(request: RepositoryStagedDiffRequest): Promise<RepositoryStagedDiff> {
      const args = {
        workspaceRoot: request.workspaceRoot,
        repoRoot: request.repoRoot,
        generation: request.generation,
        operation: "stagedDiff",
      };
      let reply: RawActionReply;
      if (request.executionBinding.kind === "ssh") {
        if (!(await remoteSupported(request.executionBinding.profileId, "repository-phase3-v1"))) {
          throw new Error("remoteUnsupported");
        }
        reply = await dependencies.invoke<RawActionReply>("remote_repository_request", {
          id: request.executionBinding.profileId,
          profileRevision: request.executionBinding.profileRevision,
          ...args,
        });
      } else {
        reply = await dependencies.invoke<RawActionReply>("repository_phase3", {
          targetId: request.targetId,
          ...args,
        });
      }
      if (reply.ok !== true || typeof reply.text !== "string") {
        throw new Error(reply.reason ?? reply.detail ?? "staged diff failed");
      }
      return { text: reply.text };
    },

    async mutate(request: RepositoryMutationRequest): Promise<RepositoryMutationResult> {
      const operation: RepositoryMutationOperation = request.operation;
      const args: Record<string, unknown> = {
        workspaceRoot: request.workspaceRoot,
        repoRoot: request.repoRoot,
        generation: request.generation,
        operation,
        ...(request.operation === "commit" ? { message: request.message } : {}),
        ...(request.operation === "stage" || request.operation === "unstage"
          ? { path: request.path, originalPath: request.originalPath ?? null }
          : {}),
        ...(request.operation === "stageBatch" || request.operation === "unstageBatch"
          ? { files: request.files.map((file) => ({ path: file.path, originalPath: file.originalPath ?? null })) }
          : {}),
      };
      let reply: RawMutationReply;
      if (request.executionBinding.kind === "ssh") {
        const batch = operation === "stageBatch" || operation === "unstageBatch";
        const capability = batch ? "repository-batch-write-v1" : "repository-write-v1";
        let supported: boolean;
        try {
          supported = await remoteSupported(request.executionBinding.profileId, capability);
        } catch (error) {
          if (!batch) throw error;
          return {
            kind: "failure",
            operation,
            reason: "remoteUnsupported",
            detail: error instanceof Error ? error.message : String(error),
            applied: false,
          };
        }
        if (!supported) {
          return {
            kind: "failure",
            operation,
            reason: "remoteUnsupported",
            detail: batch
              ? "Update the remote launcher to stage or unstage reviewed file batches."
              : "The remote launcher does not support repository writes.",
            applied: false,
          };
        }
        reply = await dependencies.invoke<RawMutationReply>("remote_repository_request", {
          id: request.executionBinding.profileId,
          profileRevision: request.executionBinding.profileRevision,
          ...args,
        });
      } else {
        reply = await dependencies.invoke<RawMutationReply>("repository_mutate", {
          ...args,
          targetId: request.targetId,
        });
      }
      if (
        reply.ok !== true ||
        typeof reply.repoRoot !== "string" ||
        typeof reply.porcelain !== "string" ||
        typeof reply.generation !== "string"
      ) {
        return {
          kind: "failure",
          operation,
          reason: reply.reason ?? "gitUnavailable",
          ...(reply.detail ? { detail: reply.detail } : {}),
          applied: reply.applied === true,
        };
      }
      const snapshot = snapshotFromReply(request, reply, reply.repositoryOperation ?? null);
      if (!snapshot) {
        return {
          kind: "failure", operation, reason: "refreshFailed",
          detail: "The repository changed but its refreshed status was invalid.", applied: true,
        };
      }
      return {
        kind: "success",
        operation,
        commitOid: reply.commitOid ?? null,
        snapshot,
      };
    },

    async action(request: RepositoryActionRequest): Promise<RepositoryActionResult> {
      const operation: RepositoryActionOperation = request.operation;
      const args: Record<string, unknown> = {
        workspaceRoot: request.workspaceRoot,
        repoRoot: request.repoRoot,
        generation: request.generation,
        operation,
        ...(request.operation === "fetch" ? { remote: request.remote } : {}),
        ...(request.operation === "push" ? {
          expectedHeadOid: request.expectedHeadOid,
          expectedUpstreamOid: request.expectedUpstreamOid,
          expectedUpstreamRemote: request.expectedUpstreamRemote,
          expectedUpstreamBranch: request.expectedUpstreamBranch,
        } : {}),
        ...(request.operation === "createBranch" ? {
          branchName: request.branchName,
          expectedHeadOid: request.expectedHeadOid,
        } : {}),
        ...(request.operation === "switchBranch" ? { branchName: request.branchName } : {}),
        ...(request.operation === "integrateFastForward"
          || request.operation === "integrateMerge"
          || request.operation === "integrateRebase" ? {
          expectedLocalBranch: request.expectedLocalBranch,
          expectedHeadOid: request.expectedHeadOid,
          expectedUpstreamRemote: request.expectedUpstreamRemote,
          expectedUpstreamBranch: request.expectedUpstreamBranch,
          expectedUpstreamOid: request.expectedUpstreamOid,
          expectedMergeBaseOid: request.expectedMergeBaseOid,
          strategy: request.strategy,
        } : {}),
        ...(request.operation === "integrateMerge" ? { message: request.message } : {}),
      };
      let reply: RawActionReply;
      const isPhase4a = request.operation === "integrateFastForward";
      const isPhase4b = request.operation === "integrateMerge" || request.operation === "integrateRebase";
      if (request.executionBinding.kind === "ssh") {
        const capability = isPhase4a
          ? "repository-integration-v1"
          : isPhase4b
            ? "repository-integration-v2"
            : "repository-phase3-v1";
        if (!(await remoteSupported(request.executionBinding.profileId, capability))) {
          return {
            kind: "failure", operation, reason: "remoteUnsupported",
            detail: isPhase4a
              ? "Update the remote launcher to integrate reviewed fast-forwards."
              : isPhase4b
                ? "Update the remote launcher to integrate reviewed merges and rebases."
                : "Update the remote launcher to use repository sync and branches.",
            applied: false,
          };
        }
        reply = await dependencies.invoke<RawActionReply>("remote_repository_request", {
          id: request.executionBinding.profileId,
          profileRevision: request.executionBinding.profileRevision,
          ...args,
        });
      } else if (isPhase4a) {
        reply = await dependencies.invoke<RawActionReply>("repository_phase4", {
          targetId: request.targetId,
          ...args,
        });
      } else if (isPhase4b) {
        reply = await dependencies.invoke<RawActionReply>("repository_phase4b", {
          targetId: request.targetId,
          ...args,
        });
      } else {
        reply = await dependencies.invoke<RawActionReply>("repository_phase3", {
          targetId: request.targetId,
          ...args,
        });
      }
      if (reply.ok !== true) {
        return {
          kind: "failure", operation, reason: reply.reason ?? "gitUnavailable",
          ...(reply.detail ? { detail: reply.detail } : {}), applied: reply.applied === true,
        };
      }
      const snapshot = snapshotFromReply(request, reply, reply.repositoryOperation ?? null);
      if (!snapshot) {
        return {
          kind: "failure", operation, reason: "refreshFailed",
          detail: "The operation completed but its refreshed status was invalid.", applied: true,
        };
      }
      return { kind: "success", operation, snapshot };
    },
  };
}

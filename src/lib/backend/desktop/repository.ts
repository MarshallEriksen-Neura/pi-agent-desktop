import { parseRepositoryStatus, type RawRepositoryStatus } from "../repository-parser";
import { hasLauncherCapability, type LauncherCapabilities } from "../ports/execution-target";
import type {
  RepositoryDiff,
  RepositoryDiffRequest,
  RepositoryMutationFailureReason,
  RepositoryMutationOperation,
  RepositoryMutationRequest,
  RepositoryMutationResult,
  RepositoryPort,
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
  commitOid?: string | null;
  reason?: RepositoryMutationFailureReason;
  detail?: string;
  applied?: boolean;
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
  reply: RawStatusReply,
 ): reply is RawStatusReply & Required<Pick<RawStatusReply, "repoRoot" | "porcelain" | "generation">> {
  return (
    reply.ok === true &&
    typeof reply.repoRoot === "string" &&
    typeof reply.porcelain === "string" &&
    typeof reply.generation === "string"
  );
}

export function createDesktopRepositoryPort(
  dependencies: DesktopRepositoryDependencies = DEFAULT_DEPENDENCIES,
): RepositoryPort {
  async function remoteSupported(profileId: string, capability: "repository-read-v1" | "repository-write-v1"): Promise<boolean> {
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
      if (!validRawStatus(reply)) {
        return unavailable(request, reply.reason ?? "gitUnavailable", reply.detail);
      }
      return parseRepositoryStatus({
        targetId: request.targetId,
        workspaceRoot: request.workspaceRoot,
        raw: {
          repoRoot: reply.repoRoot,
          porcelain: reply.porcelain,
          generation: reply.generation,
          operation: reply.operation ?? null,
        },
      });
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

    async mutate(request: RepositoryMutationRequest): Promise<RepositoryMutationResult> {
      const operation: RepositoryMutationOperation = request.operation;
      const args: Record<string, unknown> = {
        workspaceRoot: request.workspaceRoot,
        repoRoot: request.repoRoot,
        generation: request.generation,
        operation,
        ...(request.operation === "commit"
          ? { message: request.message }
          : { path: request.path, originalPath: request.originalPath ?? null }),
      };
      let reply: RawMutationReply;
      if (request.executionBinding.kind === "ssh") {
        if (!(await remoteSupported(request.executionBinding.profileId, "repository-write-v1"))) {
          return {
            kind: "failure",
            operation,
            reason: "remoteUnsupported",
            detail: "The remote launcher does not support repository writes.",
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
      return {
        kind: "success",
        operation,
        commitOid: reply.commitOid ?? null,
        snapshot: parseRepositoryStatus({
          targetId: request.targetId,
          workspaceRoot: request.workspaceRoot,
          raw: {
            repoRoot: reply.repoRoot,
            porcelain: reply.porcelain,
            generation: reply.generation,
            operation: reply.repositoryOperation ?? null,
          },
        }),
      };
    },
  };
}

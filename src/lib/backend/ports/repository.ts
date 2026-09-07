import type { ExecutionBinding } from "./execution-target";

export type RepositoryDiffKind = "staged" | "unstaged";
export type RepositoryOperation = "merge" | "rebase" | "cherryPick" | "revert" | "bisect" | null;

export interface RepositoryIdentity {
  targetId: string;
  workspaceRoot: string;
  repoRoot: string;
}

export interface RepositoryFileStatus {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export type RepositoryHead =
  | { kind: "branch"; name: string; oid: string | null }
  | { kind: "detached"; oid: string | null }
  | { kind: "unborn"; name: string | null };

export interface RepositorySnapshot extends RepositoryIdentity {
  kind: "repository";
  generation: string;
  head: RepositoryHead;
  upstream: string | null;
  ahead: number;
  behind: number;
  operation: RepositoryOperation;
  files: RepositoryFileStatus[];
}

export type RepositoryUnavailableReason =
  | "notRepository"
  | "gitUnavailable"
  | "unsafeRepositoryConfiguration"
  | "remoteUnsupported";

export interface RepositoryUnavailable {
  kind: "unavailable";
  targetId: string;
  workspaceRoot: string;
  reason: RepositoryUnavailableReason;
  detail?: string;
}

export type RepositoryStatus = RepositorySnapshot | RepositoryUnavailable;

export interface RepositoryStatusRequest {
  targetId: string;
  workspaceRoot: string;
  executionBinding: ExecutionBinding;
}

export interface RepositoryDiffRequest extends RepositoryIdentity {
  executionBinding: ExecutionBinding;
  path: string;
  diffKind: RepositoryDiffKind;
}

export interface RepositoryDiff {
  identity: RepositoryIdentity;
  path: string;
  diffKind: RepositoryDiffKind;
  text: string;
  truncated: boolean;
}

export type RepositoryMutationOperation = "stage" | "unstage" | "commit";

export type RepositoryMutationFailureReason =
  | "remoteUnsupported"
  | "piBusy"
  | "invalidRequest"
  | "repositoryChanged"
  | "staleGeneration"
  | "conflictsPresent"
  | "operationInProgress"
  | "unsafeRepositoryConfiguration"
  | "indexLocked"
  | "nothingStaged"
  | "emptyMessage"
  | "gitUnavailable"
  | "refreshFailed";

interface RepositoryMutationBase extends RepositoryIdentity {
  executionBinding: ExecutionBinding;
  generation: string;
}

export type RepositoryMutationRequest = RepositoryMutationBase & (
  | {
      operation: "stage" | "unstage";
      path: string;
      originalPath?: string | null;
    }
  | {
      operation: "commit";
      message: string;
    }
);

export type RepositoryMutationResult =
  | {
      kind: "success";
      operation: RepositoryMutationOperation;
      snapshot: RepositorySnapshot;
      commitOid: string | null;
    }
  | {
      kind: "failure";
      operation: RepositoryMutationOperation;
      reason: RepositoryMutationFailureReason;
      detail?: string;
      /** True only when Git changed the repository but the authoritative refresh failed. */
      applied: boolean;
    };

export interface RepositoryPort {
  status(request: RepositoryStatusRequest): Promise<RepositoryStatus>;
  diff(request: RepositoryDiffRequest): Promise<RepositoryDiff>;
  mutate(request: RepositoryMutationRequest): Promise<RepositoryMutationResult>;
}

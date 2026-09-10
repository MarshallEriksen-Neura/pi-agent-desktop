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

export interface RepositoryLocalBranch {
  name: string;
  oid: string;
}

export interface RepositorySnapshot extends RepositoryIdentity {
  kind: "repository";
  generation: string;
  head: RepositoryHead;
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  upstreamOid: string | null;
  mergeBaseOid: string | null;
  ahead: number;
  behind: number;
  remotes: string[];
  branches: RepositoryLocalBranch[];
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

export type RepositoryMutationOperation = "stage" | "unstage" | "stageBatch" | "unstageBatch" | "commit";
export type RepositoryActionOperation =
  | "fetch"
  | "push"
  | "createBranch"
  | "switchBranch"
  | "integrateFastForward"
  | "integrateMerge"
  | "integrateRebase";

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
  | "detachedHead"
  | "noUpstream"
  | "remoteUnavailable"
  | "remoteAuthenticationUnavailable"
  | "nothingToPush"
  | "nonFastForward"
  | "branchExists"
  | "branchNotFound"
  | "checkoutConflict"
  | "dirtyWorktree"
  | "nothingToIntegrate"
  | "unsupportedHistory"
  | "identityUnavailable"
  | "integrationConflict"
  | "stagedDiffTooLarge"
  | "gitUnavailable"
  | "refreshFailed";

interface RepositoryMutationBase extends RepositoryIdentity {
  executionBinding: ExecutionBinding;
  generation: string;
}

export interface RepositoryMutationFile {
  path: string;
  originalPath?: string | null;
}

export type RepositoryMutationRequest = RepositoryMutationBase & (
  | {
      operation: "stage" | "unstage";
      path: string;
      originalPath?: string | null;
    }
  | {
      operation: "stageBatch" | "unstageBatch";
      files: RepositoryMutationFile[];
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

export type RepositoryActionRequest = RepositoryMutationBase & (
  | { operation: "fetch"; remote: string }
  | {
      operation: "push";
      expectedHeadOid: string;
      expectedUpstreamOid: string | null;
      expectedUpstreamRemote: string;
      expectedUpstreamBranch: string;
    }
  | { operation: "createBranch"; branchName: string; expectedHeadOid: string }
  | { operation: "switchBranch"; branchName: string }
  | {
      operation: "integrateFastForward";
      expectedLocalBranch: string;
      expectedHeadOid: string;
      expectedUpstreamRemote: string;
      expectedUpstreamBranch: string;
      expectedUpstreamOid: string;
      expectedMergeBaseOid: string;
      strategy: "fastForwardOnly";
    }
  | {
      operation: "integrateMerge";
      expectedLocalBranch: string;
      expectedHeadOid: string;
      expectedUpstreamRemote: string;
      expectedUpstreamBranch: string;
      expectedUpstreamOid: string;
      expectedMergeBaseOid: string;
      strategy: "mergeCommit";
      message: string;
    }
  | {
      operation: "integrateRebase";
      expectedLocalBranch: string;
      expectedHeadOid: string;
      expectedUpstreamRemote: string;
      expectedUpstreamBranch: string;
      expectedUpstreamOid: string;
      expectedMergeBaseOid: string;
      strategy: "rebaseLinear";
    }
);

export type RepositoryActionResult =
  | {
      kind: "success";
      operation: RepositoryActionOperation;
      snapshot: RepositorySnapshot;
    }
  | {
      kind: "failure";
      operation: RepositoryActionOperation;
      reason: RepositoryMutationFailureReason;
      detail?: string;
      applied: boolean;
    };

export interface RepositoryStagedDiffRequest extends RepositoryIdentity {
  executionBinding: ExecutionBinding;
  generation: string;
}

export interface RepositoryStagedDiff {
  text: string;
}

export interface RepositoryPort {
  status(request: RepositoryStatusRequest): Promise<RepositoryStatus>;
  diff(request: RepositoryDiffRequest): Promise<RepositoryDiff>;
  stagedDiff(request: RepositoryStagedDiffRequest): Promise<RepositoryStagedDiff>;
  mutate(request: RepositoryMutationRequest): Promise<RepositoryMutationResult>;
  action(request: RepositoryActionRequest): Promise<RepositoryActionResult>;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDot,
  CloudDownload,
  FileQuestion,
  GitBranch,
  GitMerge,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUI } from "@/lib/store";
import { effectiveBindings, isMacPlatform, matchesBinding, shortcutById } from "@/lib/shortcuts";
import type {
  RepositoryFileStatus,
  RepositorySnapshot,
} from "@/lib/backend/ports/repository";
import { getPort } from "@/lib/backend/composition/container";
import { useRepository, type RepositoryActionIntent, type RepositoryScope, type RepositorySelection } from "@/lib/repository";
import { useWorkspace } from "@/lib/workspace";
import { useSessions } from "@/lib/pi/sessions";
import { useTurnChanges } from "@/lib/pi/turn";
import { usePi } from "@/lib/pi/store";
import { useExtUi } from "@/lib/pi/ext-ui";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffBody } from "./FileDiffView";

interface StatusGroup {
  key: "conflicts" | "staged" | "unstaged" | "untracked";
  files: RepositoryFileStatus[];
  kind: "staged" | "unstaged";
  icon: typeof AlertTriangle;
  color: string;
}

function groupsOf(snapshot: RepositorySnapshot): StatusGroup[] {
  return [
    {
      key: "conflicts",
      files: snapshot.files.filter((file) => file.conflicted),
      kind: "unstaged",
      icon: AlertTriangle,
      color: "var(--danger)",
    },
    {
      key: "staged",
      files: snapshot.files.filter((file) => file.staged && !file.conflicted),
      kind: "staged",
      icon: Check,
      color: "var(--success)",
    },
    {
      key: "unstaged",
      files: snapshot.files.filter((file) => file.unstaged && !file.untracked && !file.conflicted),
      kind: "unstaged",
      icon: CircleDot,
      color: "var(--warning)",
    },
    {
      key: "untracked",
      files: snapshot.files.filter((file) => file.untracked && !file.conflicted),
      kind: "unstaged",
      icon: FileQuestion,
      color: "var(--text-secondary)",
    },
  ];
}

function headLabel(snapshot: RepositorySnapshot, t: ReturnType<typeof useT>): string {
  if (snapshot.head.kind === "branch") return snapshot.head.name;
  if (snapshot.head.kind === "detached") return t("repository.detached");
  return snapshot.head.name || t("repository.unborn");
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

type AiDraftFailureKey =
  | "repository.aiDraftFailed"
  | "repository.aiDraftModelUnavailable"
  | "repository.aiDraftConfigurationInvalid"
  | "repository.aiDraftAuthenticationFailed"
  | "repository.aiDraftRateLimited"
  | "repository.aiDraftTimedOut"
  | "repository.aiDraftBusy"
  | "repository.aiDraftTooLarge"
  | "repository.aiDraftStagedDiffTooLarge"
  | "repository.aiDraftEmpty";

function aiDraftFailureKey(error: unknown): AiDraftFailureKey {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  if (message === "stagedDiffTooLarge") return "repository.aiDraftStagedDiffTooLarge";
  if (message === "nothingStaged") return "repository.aiDraftEmpty";
  const code = message.match(/commit draft generation failed: ([A-Za-z]+)/)?.[1];
  switch (code) {
    case "modelUnavailable": return "repository.aiDraftModelUnavailable";
    case "configurationInvalid": return "repository.aiDraftConfigurationInvalid";
    case "authenticationFailed": return "repository.aiDraftAuthenticationFailed";
    case "rateLimited": return "repository.aiDraftRateLimited";
    case "timedOut": return "repository.aiDraftTimedOut";
    case "busy": return "repository.aiDraftBusy";
    case "diffTooLarge":
    case "responseTooLarge":
      return "repository.aiDraftTooLarge";
    case "emptyDiff":
    case "emptyResponse":
      return "repository.aiDraftEmpty";
    default:
      return "repository.aiDraftFailed";
  }
}

function repositoryRelativePaths(paths: string[], repoRoot: string | null): Set<string> {
  const relative = new Set<string>();
  if (!repoRoot) return relative;
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const windowsRoot = /^[a-zA-Z]:\//.test(root);
  for (const rawPath of paths) {
    const path = rawPath.replace(/\\/g, "/");
    const absolute = path.startsWith("/") || /^[a-zA-Z]:\//.test(path);
    if (!absolute) {
      relative.add(path.replace(/^\.\//, ""));
      continue;
    }
    const matchesRoot = windowsRoot
      ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      : path.startsWith(`${root}/`);
    if (matchesRoot) relative.add(path.slice(root.length + 1));
  }
  return relative;
}

type IntegrationStrategy = "fastForwardOnly" | "mergeCommit" | "rebaseLinear";

type IntegrationIntent =
  | Extract<RepositoryActionIntent, { operation: "integrateFastForward" }>
  | Extract<RepositoryActionIntent, { operation: "integrateMerge" }>
  | Extract<RepositoryActionIntent, { operation: "integrateRebase" }>;

type IntegrationReview = {
  scopeKey: string;
  repoRoot: string;
  generation: string;
  intent: IntegrationIntent;
};

type CommitReview = {
  scopeKey: string;
  repoRoot: string;
  generation: string;
  stagedCount: number;
  message: string;
};

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function RepositoryInspector() {
  const t = useT();
  const root = useWorkspace((state) => state.root);
  const targetId = useWorkspace((state) => state.targetId);
  const binding = useSessions((state) => state.executionBinding);
  const activeTaskId = useSessions((state) => state.activeId);
  const turnChanges = useTurnChanges(activeTaskId);
  const result = useRepository((state) => state.result);
  const piPaths = useMemo(
    () => repositoryRelativePaths(
      turnChanges.files.map((file) => file.path),
      result?.kind === "repository" ? result.repoRoot : null,
    ),
    [result, turnChanges],
  );
  const loading = useRepository((state) => state.loading);
  const error = useRepository((state) => state.error);
  const selected = useRepository((state) => state.selected);
  const diff = useRepository((state) => state.diff);
  const diffLoading = useRepository((state) => state.diffLoading);
  const diffError = useRepository((state) => state.diffError);
  const listRef = useRef<HTMLDivElement>(null);

  const piStatus = usePi((state) => state.status);
  const mutating = useRepository((state) => state.mutating);
  const [commitMessage, setCommitMessage] = useState("");
  const [confirmCommit, setConfirmCommit] = useState<CommitReview | null>(null);
  const currentModel = usePi((state) => state.currentModel);
  const [drafting, setDrafting] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [branchActionsOpen, setBranchActionsOpen] = useState(false);
  const [confirmPush, setConfirmPush] = useState<{
    localBranch: string;
    generation: string;
    remote: string;
    upstreamBranch: string;
    headOid: string;
    upstreamOid: string | null;
  } | null>(null);
  const [integrationStrategy, setIntegrationStrategy] = useState<IntegrationStrategy>("fastForwardOnly");
  const [mergeMessage, setMergeMessage] = useState("");
  const [confirmIntegration, setConfirmIntegration] = useState<IntegrationReview | null>(null);
  const scope = useMemo<RepositoryScope | null>(() => {
    if (!root) return null;
    return { targetId, workspaceRoot: root, binding };
  }, [binding, root, targetId]);

  useEffect(() => {
    setCommitMessage("");
    setMergeMessage("");
    setIntegrationStrategy("fastForwardOnly");
    setBranchActionsOpen(false);
    setConfirmCommit(null);
    setConfirmPush(null);
    setConfirmIntegration(null);
    if (!scope) {
      useRepository.getState().clear();
      return;
    }
    void useRepository.getState().refresh(scope);
  }, [scope]);


  const authoritativeGeneration = result?.kind === "repository" ? result.generation : null;
  useEffect(() => {
    setCommitMessage("");
    setMergeMessage("");
    const current = useRepository.getState().result;
    setIntegrationStrategy(
      current?.kind === "repository" && current.ahead > 0 && current.behind > 0
        ? "mergeCommit"
        : "fastForwardOnly",
    );
    setConfirmCommit(null);
    setConfirmPush(null);
    setConfirmIntegration(null);
  }, [authoritativeGeneration]);
  useEffect(() => {
    if (result?.kind !== "repository") return;
    setSelectedRemote((remote) => result.remotes.includes(remote)
      ? remote
      : result.upstreamRemote || result.remotes[0] || "");
    setSelectedBranch((branch) => result.branches.some((item) => item.name === branch)
      ? branch
      : result.head.kind === "branch" ? result.head.name : result.branches[0]?.name || "");
  }, [result]);

  const refresh = () => {
    if (scope) void useRepository.getState().refresh(scope);
  };


  const writeDisabled = piStatus === "running" || mutating || Boolean(result?.kind === "repository" && (result.operation || result.files.some((file) => file.conflicted)));
  const writeDisabledReason = piStatus === "running"
    ? t("repository.writeDisabledPi")
    : result?.kind === "repository" && result.operation
      ? t("repository.writeDisabledOperation")
      : result?.kind === "repository" && result.files.some((file) => file.conflicted)
        ? t("repository.writeDisabledConflicts")
        : undefined;
  const mutateFile = async (file: RepositoryFileStatus, operation: "stage" | "unstage") => {
    const response = await useRepository.getState().mutate({
      operation, path: file.path, originalPath: file.originalPath,
    });
    if (!response) return;
    if (response.kind === "failure") {
      useExtUi.getState().pushToast(
        t(`repository.error.${response.reason}`), "error", 7000,
      );
    } else {
      useExtUi.getState().pushToast(
        operation === "stage" ? t("repository.stageSuccess") : t("repository.unstageSuccess"),
        "info", 2500,
      );
    }
  };
  const mutateBatch = async (
    files: RepositoryFileStatus[],
    operation: "stageBatch" | "unstageBatch",
  ) => {
    const response = await useRepository.getState().mutate({
      operation,
      files: files.map((file) => ({ path: file.path, originalPath: file.originalPath })),
    });
    if (!response) return;
    if (response.kind === "failure") {
      useExtUi.getState().pushToast(
        t(`repository.error.${response.reason}`), "error", 7000,
      );
      return;
    }
    useExtUi.getState().pushToast(
      operation === "stageBatch"
        ? t("repository.stageBatchSuccess", { count: files.length })
        : t("repository.unstageBatchSuccess", { count: files.length }),
      "info",
      2500,
    );
  };
  const commit = async () => {
    const review = confirmCommit;
    if (!review || !commitReviewIsCurrent(review)) return;
    const response = await useRepository.getState().mutate({
      operation: "commit",
      message: review.message,
    });
    if (!response) return;
    if (response.kind === "failure") {
      useExtUi.getState().pushToast(t(`repository.error.${response.reason}`), "error", 7000);
      return;
    }
    setCommitMessage("");
    setConfirmCommit(null);
    useExtUi.getState().pushToast(t("repository.commitSuccess", { oid: response.commitOid?.slice(0, 7) || "—" }), "info", 4000);
  };
  const runAction = async (
    intent: RepositoryActionIntent,
    successKey:
      | "repository.fetchSuccess"
      | "repository.pushSuccess"
      | "repository.switchSuccess"
      | "repository.createBranchSuccess"
      | "repository.integrationSuccess"
      | "repository.mergeSuccess"
      | "repository.rebaseSuccess",
  ): Promise<boolean> => {
    const reviewedScopeKey = useRepository.getState().scopeKey;
    const response = await useRepository.getState().action(intent);
    if (!response || useRepository.getState().scopeKey !== reviewedScopeKey) return false;
    if (response.kind === "failure") {
      useExtUi.getState().pushToast(t(`repository.error.${response.reason}`), "error", 7000);
      return false;
    }
    const current = useRepository.getState().result;
    if (current?.kind !== "repository" || current.generation !== response.snapshot.generation) return false;
    useExtUi.getState().pushToast(t(successKey), "info", 3500);
    return true;
  };
  const generateDraft = async () => {
    if (drafting) return;
    const reviewed = useRepository.getState();
    if (!reviewed.scopeKey || reviewed.result?.kind !== "repository") return;
    const reviewedScopeKey = reviewed.scopeKey;
    const reviewedGeneration = reviewed.result.generation;
    const isStillReviewedScope = () => {
      const current = useRepository.getState();
      return current.scopeKey === reviewedScopeKey
        && current.result?.kind === "repository"
        && current.result.generation === reviewedGeneration;
    };
    setDrafting(true);
    try {
      const stagedDiff = await useRepository.getState().stagedDiff();
      if (!isStillReviewedScope()) return;
      const draft = await getPort("sessionRepository").generateCommitMessage({
        stagedDiff,
        provider: currentModel?.provider ?? null,
        modelId: currentModel?.id ?? null,
      });
      // Never carry an asynchronously generated message into another repository
      // or across a refresh that invalidated the staged diff it was based on.
      if (!isStillReviewedScope()) return;
      setCommitMessage(draft);
      useExtUi.getState().pushToast(t("repository.aiDraftSuccess"), "info", 2500);
    } catch (error) {
      if (isStillReviewedScope()) {
        useExtUi.getState().pushToast(t(aiDraftFailureKey(error)), "error", 7000);
      }
    } finally {
      setDrafting(false);
    }
  };
  if (!root) {
    return <RepositoryNotice icon={GitBranch} title={t("repository.noWorkspace")} />;
  }

  if (selected) {
    return (
      <div style={{ display: "flex", minHeight: 0, flex: 1, flexDirection: "column" }}>
        <div style={detailHeaderStyle}>
          <button
            type="button"
            className="pi-icon-button"
            aria-label={t("repository.back")}
            onClick={() => useRepository.getState().clearSelection()}
            style={iconButtonStyle}
          >
            <ArrowLeft size={15} />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div title={selected.path} style={pathTitleStyle}>{shortPath(selected.path)}</div>
            <div style={subtitleStyle}>
              {selected.kind === "staged" ? t("repository.diffStaged") : t("repository.diffUnstaged")}
            </div>
          </div>
          <button
            type="button"
            className="pi-button repository-action-button"
            onClick={() => void useWorkspace.getState().openFile(selected.path)}
            style={openButtonStyle}
          >
            {t("repository.openFile")}
          </button>
        </div>
        {diffLoading ? (
          <RepositoryNotice icon={RefreshCw} title={t("repository.loadingDiff")} spin />
        ) : diffError ? (
          <RepositoryNotice icon={AlertTriangle} title={t("repository.diffFailed")} detail={diffError} />
        ) : diff && diff.hunks.length > 0 ? (
          <DiffBody diff={diff} onViewSource={() => void useWorkspace.getState().openFile(selected.path)} />
        ) : (
          <RepositoryNotice icon={Check} title={t("repository.noDiff")} />
        )}
      </div>
    );
  }

  if (loading && !result) {
    return <RepositoryNotice icon={RefreshCw} title={t("repository.loading")} spin />;
  }

  if (error && !result) {
    return (
      <RepositoryNotice
        icon={AlertTriangle}
        title={t("repository.loadFailed")}
        detail={error}
        action={t("repository.retry")}
        onAction={refresh}
      />
    );
  }

  if (result?.kind === "unavailable") {
    const title =
      result.reason === "notRepository"
        ? t("repository.notRepository")
        : result.reason === "remoteUnsupported"
          ? t("repository.remoteUnsupported")
          : result.reason === "unsafeRepositoryConfiguration"
            ? t("repository.error.unsafeRepositoryConfiguration")
            : t("repository.gitUnavailable");
    return <RepositoryNotice icon={AlertTriangle} title={title} detail={result.detail} action={t("repository.retry")} onAction={refresh} />;
  }

  if (result?.kind !== "repository") return null;

  const groups = groupsOf(result);
  const changedCount = result.files.length;
  const ahead = result.ahead;
  const behind = result.behind;

  const conflictFiles = groups.find((group) => group.key === "conflicts")?.files ?? [];
  const unstagedFiles = groups.find((group) => group.key === "unstaged")?.files ?? [];
  const untrackedFiles = groups.find((group) => group.key === "untracked")?.files ?? [];
  const commitStageFiles = [...unstagedFiles, ...untrackedFiles];
  const commitStageAria = unstagedFiles.length > 0 && untrackedFiles.length > 0
    ? t("repository.stageAllCommitAria", { count: commitStageFiles.length })
    : unstagedFiles.length > 0
      ? t("repository.stageAllUnstagedAria", { count: commitStageFiles.length })
      : t("repository.stageAllUntrackedAria", { count: commitStageFiles.length });
  const conflictGuidanceId = conflictFiles.length > 0 ? "repository-conflict-batch-guidance" : undefined;
  const stagedCount = result.files.filter((file) => file.staged && !file.conflicted).length;
  const commitReady = !writeDisabled && stagedCount > 0 && commitMessage.trim().length > 0;
  const openCommitReview = () => {
    const state = useRepository.getState();
    const current = state.result;
    if (!commitReady || !state.scopeKey || current?.kind !== "repository") return;
    setConfirmCommit({
      scopeKey: state.scopeKey,
      repoRoot: current.repoRoot,
      generation: current.generation,
      stagedCount,
      message: commitMessage.trim(),
    });
  };
  const commitReviewIsCurrent = (review: CommitReview): boolean => {
    const state = useRepository.getState();
    const current = state.result;
    return usePi.getState().status !== "running"
      && !state.loading
      && !state.mutating
      && state.scopeKey === review.scopeKey
      && current?.kind === "repository"
      && current.repoRoot === review.repoRoot
      && current.generation === review.generation
      && current.operation === null
      && !current.files.some((file) => file.conflicted)
      && current.files.filter((file) => file.staged && !file.conflicted).length === review.stagedCount;
  };
  const currentBranch = result.head.kind === "branch" ? result.head.name : null;
  const currentHeadOid = result.head.kind === "unborn" ? null : result.head.oid;
  const pushReady = !writeDisabled && Boolean(
    currentBranch
    && result.upstreamRemote
    && result.upstreamBranch
    && currentHeadOid
    && result.ahead > 0
    && result.behind === 0,
  );
  const pushDisabledReason = writeDisabledReason
    || (!result.upstreamRemote
      ? t("repository.error.noUpstream")
      : result.behind > 0
        ? t("repository.error.nonFastForward")
        : t("repository.pushHint", { remote: result.upstreamRemote, branch: result.upstreamBranch || "—" }));
  const integrationTopologyKnown = Boolean(
    currentBranch
    && currentHeadOid
    && result.upstreamRemote
    && result.upstreamBranch
    && result.upstreamOid
    && result.mergeBaseOid,
  );
  const fastForwardTopology = integrationTopologyKnown
    && ahead === 0
    && behind > 0
    && result.mergeBaseOid === currentHeadOid;
  const divergedTopology = integrationTopologyKnown
    && ahead > 0
    && behind > 0
    && result.mergeBaseOid !== currentHeadOid
    && result.mergeBaseOid !== result.upstreamOid;
  const integrationBaseReady = !writeDisabled && changedCount === 0 && integrationTopologyKnown;
  const fastForwardReady = integrationBaseReady && fastForwardTopology;
  const phase4bReady = integrationBaseReady && divergedTopology;
  const reviewedMergeMessage = mergeMessage.trim();
  const mergeMessageBytes = utf8ByteLength(reviewedMergeMessage);
  const mergeMessageReady = reviewedMergeMessage.length > 0 && mergeMessageBytes <= 4096;
  const effectiveIntegrationStrategy: IntegrationStrategy = fastForwardTopology
    ? "fastForwardOnly"
    : integrationStrategy === "rebaseLinear"
      ? "rebaseLinear"
      : "mergeCommit";
  const integrationReady = effectiveIntegrationStrategy === "fastForwardOnly"
    ? fastForwardReady
    : effectiveIntegrationStrategy === "mergeCommit"
      ? phase4bReady && mergeMessageReady
      : phase4bReady;
  const integrationButtonLabel = fastForwardTopology
    ? t("repository.integrate")
    : t("repository.reviewIntegration");
  const integrationDisabledReason = writeDisabledReason
    || (changedCount > 0 ? t("repository.error.dirtyWorktree") : undefined);
  const openIntegrationReview = () => {
    const reviewedScopeKey = useRepository.getState().scopeKey;
    if (
      !integrationReady
      || !reviewedScopeKey
      || !currentBranch
      || !currentHeadOid
      || !result.upstreamRemote
      || !result.upstreamBranch
      || !result.upstreamOid
      || !result.mergeBaseOid
    ) return;
    const common = {
      expectedLocalBranch: currentBranch,
      expectedHeadOid: currentHeadOid,
      expectedUpstreamRemote: result.upstreamRemote,
      expectedUpstreamBranch: result.upstreamBranch,
      expectedUpstreamOid: result.upstreamOid,
      expectedMergeBaseOid: result.mergeBaseOid,
    };
    let intent: IntegrationIntent;
    if (effectiveIntegrationStrategy === "fastForwardOnly") {
      intent = { ...common, operation: "integrateFastForward", strategy: "fastForwardOnly" };
    } else if (effectiveIntegrationStrategy === "mergeCommit") {
      intent = { ...common, operation: "integrateMerge", strategy: "mergeCommit", message: reviewedMergeMessage };
    } else {
      intent = { ...common, operation: "integrateRebase", strategy: "rebaseLinear" };
    }
    setConfirmIntegration({ scopeKey: reviewedScopeKey, repoRoot: result.repoRoot, generation: result.generation, intent });
  };
  const integrationReviewIsCurrent = (review: IntegrationReview): boolean => {
    const state = useRepository.getState();
    const current = state.result;
    const intent = review.intent;
    return state.scopeKey === review.scopeKey
      && current?.kind === "repository"
      && current.repoRoot === review.repoRoot
      && current.generation === review.generation
      && current.head.kind === "branch"
      && current.head.name === intent.expectedLocalBranch
      && current.head.oid === intent.expectedHeadOid
      && current.upstreamRemote === intent.expectedUpstreamRemote
      && current.upstreamBranch === intent.expectedUpstreamBranch
      && current.upstreamOid === intent.expectedUpstreamOid
      && current.mergeBaseOid === intent.expectedMergeBaseOid
      && current.operation === null
      && current.files.length === 0;
  };
  const switchReady = !writeDisabled && Boolean(selectedBranch && selectedBranch !== currentBranch);
  const createReady = !writeDisabled && Boolean(currentHeadOid && newBranch.trim().length > 0);
  const reviewedIntent = confirmIntegration?.intent ?? null;
  const reviewedStrategy = reviewedIntent?.operation === "integrateMerge"
    ? t("repository.strategy.mergeCommit")
    : reviewedIntent?.operation === "integrateRebase"
      ? t("repository.strategy.rebaseLinear")
      : t("repository.strategy.fastForwardOnly");
  const reviewedRelationship = reviewedIntent
    ? `${reviewedIntent.expectedLocalBranch} ← ${reviewedIntent.expectedUpstreamRemote}/${reviewedIntent.expectedUpstreamBranch}`
    : "—";
  return (
    <div
      ref={listRef}
      onKeyDown={(event) => {
        if (!confirmCommit && commitReady) {
          const command = shortcutById("repositoryCommit");
          if (command) {
            const { shortcutOverrides } = useUI.getState();
            const matches = effectiveBindings(command, shortcutOverrides).some((binding) =>
              matchesBinding(event, binding, isMacPlatform())
            );
            if (matches) {
              event.preventDefault();
              openCommitReview();
              return;
            }
          }
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-repository-file]") ?? []);
        if (rows.length === 0) return;
        const at = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
        rows[next]?.focus();
        event.preventDefault();
      }}
      style={inspectorStyle}
    >
      <div style={summaryStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <GitBranch size={15} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
          <strong style={branchStyle}>{headLabel(result, t)}</strong>
          {result.operation && <span style={operationStyle}>{t(`repository.operation.${result.operation}`)}</span>}
        </div>
        <button type="button" className="pi-icon-button" aria-label={t("repository.refresh")} onClick={refresh} disabled={loading} style={iconButtonStyle}>
          <RefreshCw size={14} />
        </button>
        <div style={metaStyle}>
          <span>{t("repository.changedCount", { count: changedCount })}</span>
          {result.upstream && <span title={result.upstream} style={technicalMetaStyle}>{result.upstream}</span>}
          {result.upstream && <span style={technicalMetaStyle}>↑{ahead} ↓{behind}</span>}
          {error && <span title={error} style={{ color: "var(--danger)" }}>{t("repository.loadFailed")}</span>}
          {result.head.kind !== "unborn" && result.head.oid && <span style={technicalMetaStyle}>{result.head.oid.slice(0, 7)}</span>}
        </div>
      </div>
      <section style={operationsStyle} aria-label={t("repository.operations")}>
        <div style={syncGridStyle}>
          <div style={syncCellStyle}>
            <label htmlFor="repository-fetch-remote" style={operationLabelStyle}>{t("repository.fetchRemote")}</label>
            <div style={operationRowStyle}>
              <select
                id="repository-fetch-remote"
                className="pi-native-select repository-control"
                aria-label={t("repository.fetchRemote")}
                value={selectedRemote}
                onChange={(event) => setSelectedRemote(event.target.value)}
                disabled={writeDisabled || result.remotes.length === 0}
                style={{ ...compactFieldStyle, ...technicalFieldStyle }}
              >
                {result.remotes.length === 0 && <option value="">{t("repository.noRemotes")}</option>}
                {result.remotes.map((remote) => <option key={remote} value={remote}>{remote}</option>)}
              </select>
              <button
                type="button" className="pi-button repository-action-button" style={compactButtonStyle}
                disabled={writeDisabled || !selectedRemote}
                title={writeDisabledReason || t("repository.fetchHint", { remote: selectedRemote || "—" })}
                onClick={() => void runAction({ operation: "fetch", remote: selectedRemote }, "repository.fetchSuccess")}
              >
                {mutating ? <Loader2 size={13} className="pi-spin" /> : <CloudDownload size={13} />}
                {t("repository.fetch")}
              </button>
            </div>
          </div>
          <div style={syncCellStyle}>
            <span style={operationLabelStyle}>{t("repository.upstream")}</span>
            <div style={operationRowStyle}>
              <span title={result.upstream || t("repository.error.noUpstream")} style={upstreamValueStyle}>
                {result.upstream || "—"}
              </span>
              <button
                type="button" className="pi-button repository-action-button" style={compactButtonStyle}
                disabled={!pushReady}
                title={pushDisabledReason}
                onClick={() => {
                  if (!currentBranch || !currentHeadOid || !result.upstreamRemote || !result.upstreamBranch) return;
                  setConfirmPush({
                    generation: result.generation,
                    localBranch: currentBranch,
                    remote: result.upstreamRemote,
                    upstreamBranch: result.upstreamBranch,
                    headOid: currentHeadOid,
                    upstreamOid: result.upstreamOid,
                  });
                }}
              >
                <Upload size={13} />
                {t("repository.push")}
              </button>
            </div>
          </div>
        </div>
        {(fastForwardTopology || divergedTopology) && (
          <div style={integrationCardStyle}>
            <div style={integrationHeaderStyle}>
              <span style={integrationTitleStyle}>
                <GitMerge size={13} />
                {fastForwardTopology ? t("repository.integrate") : t("repository.reviewIntegration")}
              </span>
              <span title={`${currentBranch || "—"} ← ${result.upstream || "—"}`} style={relationshipStyle}>
                {currentBranch || "—"} ← {result.upstream || "—"}
              </span>
              <span style={integrationStatusStyle}>
                {fastForwardTopology
                  ? t("repository.integrationBehind", { count: behind })
                  : t("repository.integrationDiverged", { ahead, behind })}
              </span>
            </div>
            {divergedTopology ? (
              <div style={{ display: "grid", gap: 7 }}>
                <div style={operationRowStyle}>
                  <select
                    className="pi-native-select repository-control"
                    aria-label={t("repository.integrationStrategy")}
                    value={integrationStrategy === "rebaseLinear" ? "rebaseLinear" : "mergeCommit"}
                    onChange={(event) => setIntegrationStrategy(event.target.value as IntegrationStrategy)}
                    disabled={writeDisabled}
                    style={compactFieldStyle}
                  >
                    <option value="mergeCommit">{t("repository.strategy.mergeCommit")}</option>
                    <option value="rebaseLinear">{t("repository.strategy.rebaseLinear")}</option>
                  </select>
                  <button
                    type="button" className="pi-button repository-action-button repository-primary-action" style={reviewButtonStyle}
                    disabled={!integrationReady}
                    title={integrationDisabledReason || t("repository.integrationHint", {
                      local: currentBranch || "—",
                      remote: result.upstreamRemote || "—",
                      branch: result.upstreamBranch || "—",
                    })}
                    onClick={openIntegrationReview}
                  >
                    {t("repository.reviewIntegration")}
                  </button>
                </div>
                {effectiveIntegrationStrategy === "mergeCommit" && (
                  <div style={{ display: "grid", gap: 5 }}>
                    <input
                      className="repository-control"
                      aria-label={t("repository.mergeMessage")}
                      value={mergeMessage}
                      onChange={(event) => setMergeMessage(event.target.value)}
                      placeholder={t("repository.mergeMessagePlaceholder")}
                      disabled={writeDisabled}
                      style={compactFieldStyle}
                    />
                    <span style={{ ...helperTextStyle, color: mergeMessageBytes > 4096 ? "var(--danger)" : "var(--text-secondary)" }}>
                      {t("repository.mergeMessageBytes", { count: mergeMessageBytes })}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button" className="pi-button repository-action-button repository-primary-action" style={reviewButtonStyle}
                disabled={!integrationReady}
                title={integrationDisabledReason || t("repository.integrationHint", {
                  local: currentBranch || "—",
                  remote: result.upstreamRemote || "—",
                  branch: result.upstreamBranch || "—",
                })}
                onClick={openIntegrationReview}
              >
                <GitMerge size={13} />
                {integrationButtonLabel}
              </button>
            )}
            {integrationDisabledReason && !integrationReady && (
              <span style={disabledReasonStyle}>{integrationDisabledReason}</span>
            )}
          </div>
        )}
        <div style={branchDisclosureStyle}>
          <button
            type="button"
            className="repository-disclosure"
            aria-expanded={branchActionsOpen}
            aria-controls="repository-branch-actions"
            onClick={() => setBranchActionsOpen((open) => !open)}
            style={branchDisclosureButtonStyle}
          >
            <span style={{ display: "grid", gap: 2, minWidth: 0, textAlign: "left" }}>
              <span style={branchDisclosureTitleStyle}>{t("repository.branchActions")}</span>
              <span style={branchDisclosureHintStyle}>{t("repository.branchActionsHint")}</span>
            </span>
            <ChevronRight size={14} style={{ color: "var(--text-secondary)", transform: branchActionsOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms ease-out" }} />
          </button>
          {branchActionsOpen && (
            <div id="repository-branch-actions" style={branchActionsBodyStyle}>
              <div style={operationRowStyle}>
                <select
                  className="pi-native-select repository-control"
                  aria-label={t("repository.switchBranch")}
                  value={selectedBranch}
                  onChange={(event) => setSelectedBranch(event.target.value)}
                  disabled={writeDisabled || result.branches.length === 0}
                  style={{ ...compactFieldStyle, ...technicalFieldStyle }}
                >
                  {result.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
                </select>
                <button
                  type="button" className="pi-button repository-action-button" style={compactButtonStyle}
                  disabled={!switchReady}
                  title={writeDisabledReason || t("repository.switchHint", { branch: selectedBranch || "—" })}
                  onClick={() => void runAction({ operation: "switchBranch", branchName: selectedBranch }, "repository.switchSuccess")}
                >
                  {t("repository.switch")}
                </button>
              </div>
              <div style={operationRowStyle}>
                <input
                  className="repository-control"
                  aria-label={t("repository.newBranch")}
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  placeholder={t("repository.newBranchPlaceholder")}
                  disabled={writeDisabled}
                  maxLength={255}
                  style={{ ...compactFieldStyle, ...technicalFieldStyle }}
                />
                <button
                  type="button" className="pi-button repository-action-button" style={compactButtonStyle}
                  disabled={!createReady}
                  onClick={() => {
                    if (!currentHeadOid) return;
                    void runAction({
                      operation: "createBranch",
                      branchName: newBranch.trim(),
                      expectedHeadOid: currentHeadOid,
                    }, "repository.createBranchSuccess").then((ok) => { if (ok) setNewBranch(""); });
                  }}
                >
                  <Plus size={13} />
                  {t("repository.createBranch")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <div style={fileListStyle}>
      {changedCount === 0 ? (
        <RepositoryNotice icon={Check} title={t("repository.clean")} detail={t("repository.cleanDetail")} />
      ) : (
        groups.map((group) => group.files.length > 0 && (
          <RepositoryGroup
            key={group.key}
            group={group}
            piPaths={piPaths}
            onSelect={(selection) => void useRepository.getState().select(selection)}
            onMutate={mutateFile}
            onMutateBatch={mutateBatch}
            writeDisabled={writeDisabled}
            writeDisabledReason={writeDisabledReason}
            conflictGuidanceId={conflictGuidanceId}
            mutating={mutating}
            t={t}
          />
        ))
      )}
      </div>
      <div style={commitAreaStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <label htmlFor="repository-commit-message" style={commitLabelStyle}>
            {t("repository.commitMessage")}
          </label>
          <button
            type="button"
            className="pi-button repository-action-button"
            style={aiDraftButtonStyle}
            disabled={drafting || mutating || stagedCount === 0}
            title={stagedCount === 0 ? t("repository.nothingStaged") : t("repository.aiDraftHint")}
            onClick={() => void generateDraft()}
          >
            {drafting ? <Loader2 size={12} className="pi-spin" /> : <Sparkles size={12} />}
            {t("repository.aiDraft")}
          </button>
        </div>
        {stagedCount === 0 && commitStageFiles.length > 0 && (
          <div className="repository-stage-helper" style={stageHelperStyle}>
            <span style={stageHelperTextStyle}>{t("repository.commitStageHint")}</span>
            <button
              type="button"
              className="pi-button repository-action-button"
              aria-label={commitStageAria}
              aria-describedby={writeDisabled ? conflictGuidanceId : undefined}
              disabled={writeDisabled}
              title={writeDisabledReason || t("repository.commitStageHint")}
              onClick={() => void mutateBatch(commitStageFiles, "stageBatch")}
              style={batchButtonStyle}
            >
              {mutating ? <Loader2 size={12} className="pi-spin" /> : <Plus size={12} />}
              {t("repository.stageAllChanges")}
            </button>
          </div>
        )}
        <textarea
          className="repository-control"
          id="repository-commit-message"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder={t("repository.commitPlaceholder")}
          maxLength={4096}
          rows={3}
          disabled={writeDisabled || stagedCount === 0}
          style={commitInputStyle}
        />
        <button
          type="button"
          className="pi-button repository-action-button repository-primary-action"
          disabled={!commitReady}
          title={writeDisabledReason || (stagedCount === 0 ? t("repository.nothingStaged") : undefined)}
          onClick={openCommitReview}
          style={commitButtonStyle}
        >
          {mutating ? <Loader2 size={13} className="pi-spin" /> : null}
          {t("repository.commitStaged", { count: stagedCount })}
        </button>
        {writeDisabledReason && <span style={disabledReasonStyle}>{writeDisabledReason}</span>}
      </div>
      <ConfirmDialog
        open={confirmCommit !== null}
        title={t("repository.confirmCommitTitle")}
        message={t("repository.confirmCommitMessage", { count: confirmCommit?.stagedCount ?? 0 })}
        detail={confirmCommit?.message ?? ""}
        confirmLabel={t("repository.commitConfirm")}
        confirmDisabled={writeDisabled || (confirmCommit !== null && !commitReviewIsCurrent(confirmCommit))}
        danger={false}
        onConfirm={commit}
        onCancel={() => setConfirmCommit(null)}
      />
      <ConfirmDialog
        open={confirmIntegration !== null}
        title={reviewedIntent?.operation === "integrateMerge"
          ? t("repository.confirmMergeTitle")
          : reviewedIntent?.operation === "integrateRebase"
            ? t("repository.confirmRebaseTitle")
            : t("repository.confirmIntegrationTitle")}
        message={t("repository.confirmReviewedIntegrationMessage", {
          relationship: reviewedRelationship,
          strategy: reviewedStrategy,
        })}
        detail={reviewedIntent?.operation === "integrateMerge"
          ? t("repository.confirmMergeDetail", {
              relationship: reviewedRelationship,
              strategy: reviewedStrategy,
              repoRoot: confirmIntegration?.repoRoot || "—",
              generation: confirmIntegration?.generation || "—",
              headOid: reviewedIntent.expectedHeadOid,
              upstreamOid: reviewedIntent.expectedUpstreamOid,
              mergeBaseOid: reviewedIntent.expectedMergeBaseOid,
              message: reviewedIntent.message,
            })
          : t("repository.confirmIntegrationDetail", {
              relationship: reviewedRelationship,
              strategy: reviewedStrategy,
              repoRoot: confirmIntegration?.repoRoot || "—",
              generation: confirmIntegration?.generation || "—",
              headOid: reviewedIntent?.expectedHeadOid || "—",
              upstreamOid: reviewedIntent?.expectedUpstreamOid || "—",
              mergeBaseOid: reviewedIntent?.expectedMergeBaseOid || "—",
            })}
        confirmLabel={reviewedIntent?.operation === "integrateMerge"
          ? t("repository.mergeConfirm")
          : reviewedIntent?.operation === "integrateRebase"
            ? t("repository.rebaseConfirm")
            : t("repository.integrationConfirm")}
        danger={false}
        confirmDisabled={loading || mutating}
        onConfirm={() => {
          const state = useRepository.getState();
          if (state.loading || state.mutating) return;
          const reviewed = confirmIntegration;
          setConfirmIntegration(null);
          if (!reviewed || !integrationReviewIsCurrent(reviewed)) return;
          const successKey = reviewed.intent.operation === "integrateMerge"
            ? "repository.mergeSuccess"
            : reviewed.intent.operation === "integrateRebase"
              ? "repository.rebaseSuccess"
              : "repository.integrationSuccess";
          void runAction(reviewed.intent, successKey);
        }}
        onCancel={() => setConfirmIntegration(null)}
      />
      <ConfirmDialog
        open={confirmPush !== null}
        title={t("repository.confirmPushTitle")}
        message={t("repository.confirmPushMessage", {
          local: confirmPush?.localBranch || "—",
          remote: confirmPush?.remote || "—",
          branch: confirmPush?.upstreamBranch || "—",
        })}
        detail={`${confirmPush?.localBranch || "—"} → ${confirmPush?.remote || "—"}/${confirmPush?.upstreamBranch || "—"}`}
        confirmLabel={t("repository.pushConfirm")}
        danger={false}
        onConfirm={() => {
          const reviewedPush = confirmPush;
          setConfirmPush(null);
          if (!reviewedPush) return;
          const current = useRepository.getState().result;
          if (current?.kind !== "repository" || current.generation !== reviewedPush.generation) return;
          void runAction({
            operation: "push",
            expectedHeadOid: reviewedPush.headOid,
            expectedUpstreamOid: reviewedPush.upstreamOid,
            expectedUpstreamRemote: reviewedPush.remote,
            expectedUpstreamBranch: reviewedPush.upstreamBranch,
          }, "repository.pushSuccess");
        }}
        onCancel={() => setConfirmPush(null)}
      />
    </div>
  );
}

function RepositoryGroup({
  group,
  piPaths,
  onSelect,
  onMutate,
  onMutateBatch,
  writeDisabled,
  writeDisabledReason,
  conflictGuidanceId,
  mutating,
  t,
}: {
  group: StatusGroup;
  piPaths: Set<string>;
  onSelect: (selection: RepositorySelection) => void;
  onMutate: (file: RepositoryFileStatus, operation: "stage" | "unstage") => void;
  onMutateBatch: (files: RepositoryFileStatus[], operation: "stageBatch" | "unstageBatch") => void;
  writeDisabled: boolean;
  writeDisabledReason?: string;
  conflictGuidanceId?: string;
  mutating: boolean;
  t: ReturnType<typeof useT>;
}) {
  const Icon = group.icon;
  const batchOperation = group.kind === "staged" ? "unstageBatch" : "stageBatch";
  const batchLabel = group.kind === "staged" ? t("repository.unstageAll") : t("repository.stageAll");
  const batchAriaLabel = group.key === "staged"
    ? t("repository.unstageAllStagedAria", { count: group.files.length })
    : group.key === "untracked"
      ? t("repository.stageAllUntrackedAria", { count: group.files.length })
      : t("repository.stageAllUnstagedAria", { count: group.files.length });
  return (
    <section style={{ padding: "10px 0 4px" }}>
      <div style={groupHeaderStyle}>
        <Icon size={13} style={{ color: group.color }} />
        <span>{t(`repository.group.${group.key}`)}</span>
        <span style={countStyle}>{group.files.length}</span>
        {group.key !== "conflicts" && (
          <button
            type="button"
            className="pi-button repository-action-button repository-batch-action"
            aria-label={batchAriaLabel}
            aria-describedby={writeDisabled ? conflictGuidanceId : undefined}
            disabled={writeDisabled}
            title={writeDisabledReason || batchLabel}
            onClick={() => onMutateBatch(group.files, batchOperation)}
            style={groupBatchButtonStyle}
          >
            {mutating
              ? <Loader2 size={11} className="pi-spin" />
              : batchOperation === "stageBatch" ? <Plus size={11} /> : <Minus size={11} />}
            {batchLabel}
          </button>
        )}
      </div>
      {group.key === "conflicts" && conflictGuidanceId && (
        <p id={conflictGuidanceId} role="note" style={conflictGuidanceStyle}>
          {t("repository.conflictBatchGuidance", { count: group.files.length })}
        </p>
      )}
      {group.files.map((file) => {
        const mutation = group.kind === "staged" ? "unstage" : "stage";
        const ActionIcon = mutation === "stage" ? Plus : Minus;
        const actionLabel = mutation === "stage" ? t("repository.stage") : t("repository.unstage");
        return (
          <div key={`${group.kind}:${file.path}`} className="pi-row" style={fileRowStyle}>
            <button
              type="button"
              data-repository-file
              onClick={() => onSelect({ path: file.path, kind: group.kind })}
              style={fileSelectStyle}
            >
              <span style={{ minWidth: 0, flex: 1 }}>
                <span title={file.path} style={fileNameStyle}>{shortPath(file.path)}</span>
                {file.originalPath && <span style={renameStyle}>← {shortPath(file.originalPath)}</span>}
              </span>
              {piPaths.has(file.path) && <span style={piBadgeStyle}>{t("repository.piTouched")}</span>}
              <span style={codeStyle}>
                {group.key === "conflicts"
                  ? `${file.indexStatus}${file.worktreeStatus}`
                  : group.kind === "staged"
                    ? file.indexStatus
                    : file.worktreeStatus}
              </span>
              <ChevronRight size={13} style={{ color: "var(--text-tertiary)" }} />
            </button>
            <button
              type="button"
              className="pi-icon-button"
              aria-label={`${actionLabel}: ${file.path}`}
              title={writeDisabledReason || actionLabel}
              disabled={writeDisabled || group.key === "conflicts"}
              onClick={() => onMutate(file, mutation)}
              style={mutationButtonStyle}
            >
              {mutating ? <Loader2 size={12} className="pi-spin" /> : <ActionIcon size={12} />}
            </button>
          </div>
        );
      })}
    </section>
  );
}

function RepositoryNotice({
  icon: Icon,
  title,
  detail,
  spin,
  action,
  onAction,
}: {
  icon: typeof GitBranch;
  title: string;
  detail?: string;
  spin?: boolean;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div style={noticeStyle}>
      <Icon size={20} className={spin ? "pi-spin" : undefined} style={{ color: "var(--text-tertiary)" }} />
      <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>{title}</strong>
      {detail && <span style={{ maxWidth: 300, fontSize: 11.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>{detail}</span>}
      {action && onAction && <button type="button" className="pi-button repository-action-button" onClick={onAction} style={openButtonStyle}>{action}</button>}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = { width: 28, height: 28, display: "grid", placeItems: "center", border: 0, background: "transparent", color: "var(--text-secondary)", borderRadius: 6 };
const detailHeaderStyle: React.CSSProperties = { minHeight: 52, display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--separator)" };
const pathTitleStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-primary)" };
const subtitleStyle: React.CSSProperties = { marginTop: 2, fontSize: 11.5, color: "var(--text-secondary)" };
const openButtonStyle: React.CSSProperties = { minHeight: 30, padding: "0 10px", border: "1px solid var(--separator)", borderRadius: 7, background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 12 };
const inspectorStyle: React.CSSProperties = { minHeight: 0, flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--surface)" };
const summaryStyle: React.CSSProperties = { position: "relative", flexShrink: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "6px 8px", padding: "12px", borderBottom: "1px solid var(--separator)" };
const branchStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 650, color: "var(--text-primary)" };
const operationStyle: React.CSSProperties = { padding: "2px 5px", borderRadius: 4, background: "var(--diff-remove-bg)", color: "var(--danger)", fontSize: 10, fontWeight: 650, textTransform: "uppercase" };
const metaStyle: React.CSSProperties = { gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: "3px 10px", paddingLeft: 23, fontSize: 11.5, lineHeight: 1.35, color: "var(--text-secondary)" };
const technicalMetaStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };
const operationsStyle: React.CSSProperties = { flexShrink: 0, display: "grid", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--separator)", background: "var(--surface)" };
const syncGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 };
const syncCellStyle: React.CSSProperties = { minWidth: 0, display: "grid", gap: 5 };
const operationLabelStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" };
const operationRowStyle: React.CSSProperties = { minWidth: 0, display: "flex", alignItems: "center", gap: 6 };
const compactFieldStyle: React.CSSProperties = { minWidth: 0, minHeight: 32, flex: 1, padding: "0 8px", border: "1px solid var(--separator)", borderRadius: 7, background: "var(--bg-elevated)", color: "var(--text-primary)", fontFamily: "var(--font-ui)", fontSize: 12, outline: "none" };
const technicalFieldStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };
const compactButtonStyle: React.CSSProperties = { minHeight: 32, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "0 9px", border: "1px solid var(--separator)", borderRadius: 7, background: "var(--bg-elevated)", color: "var(--text-primary)", fontFamily: "var(--font-ui)", fontSize: 12, fontWeight: 550, whiteSpace: "nowrap" };
const upstreamValueStyle: React.CSSProperties = { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-primary)" };
const integrationCardStyle: React.CSSProperties = { display: "grid", gap: 8, padding: 9, border: "1px solid var(--separator)", borderRadius: 9, background: "var(--bg-elevated)" };
const integrationHeaderStyle: React.CSSProperties = { minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "3px 8px" };
const integrationTitleStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 650, color: "var(--text-primary)" };
const relationshipStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-primary)", textAlign: "right" };
const integrationStatusStyle: React.CSSProperties = { gridColumn: "1 / -1", fontSize: 11.5, lineHeight: 1.4, color: "var(--text-secondary)" };
const reviewButtonStyle: React.CSSProperties = { ...compactButtonStyle, justifySelf: "end", color: "var(--text-on-accent)", background: "var(--accent)", borderColor: "var(--accent)" };
const helperTextStyle: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.35 };
const branchDisclosureStyle: React.CSSProperties = { borderTop: "1px solid var(--separator)", paddingTop: 7 };
const branchDisclosureButtonStyle: React.CSSProperties = { width: "100%", minHeight: 38, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "2px 1px", border: 0, background: "transparent", color: "var(--text-primary)" };
const branchDisclosureTitleStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text-primary)" };
const branchDisclosureHintStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5, color: "var(--text-secondary)" };
const branchActionsBodyStyle: React.CSSProperties = { display: "grid", gap: 7, paddingTop: 7 };
const fileListStyle: React.CSSProperties = { minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", background: "var(--surface)" };
const groupHeaderStyle: React.CSSProperties = { height: 28, display: "flex", alignItems: "center", gap: 6, padding: "0 12px", color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 650, letterSpacing: "0.03em", textTransform: "uppercase" };
const countStyle: React.CSSProperties = { marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: 550, color: "var(--text-secondary)" };
const groupBatchButtonStyle: React.CSSProperties = { minHeight: 24, display: "inline-flex", alignItems: "center", gap: 4, padding: "0 7px", border: "1px solid var(--separator)", borderRadius: 6, background: "var(--bg-elevated)", color: "var(--text-primary)", fontFamily: "var(--font-ui)", fontSize: 10.5, fontWeight: 600, letterSpacing: 0, textTransform: "none", whiteSpace: "nowrap" };
const conflictGuidanceStyle: React.CSSProperties = { margin: "0 12px 6px 30px", fontSize: 11.5, lineHeight: 1.4, color: "var(--danger)" };
const fileRowStyle: React.CSSProperties = { width: "100%", minHeight: 36, display: "flex", alignItems: "center", padding: "0 8px 0 30px", background: "transparent", color: "var(--text-secondary)" };
const fileSelectStyle: React.CSSProperties = { minWidth: 0, minHeight: 36, flex: 1, display: "flex", alignItems: "center", gap: 7, padding: "5px 2px", border: 0, background: "transparent", color: "var(--text-secondary)", textAlign: "left" };
const mutationButtonStyle: React.CSSProperties = { width: 28, height: 28, flexShrink: 0, display: "grid", placeItems: "center", border: 0, borderRadius: 6, background: "transparent", color: "var(--text-secondary)" };
const fileNameStyle: React.CSSProperties = { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-primary)" };
const renameStyle: React.CSSProperties = { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-secondary)" };
const piBadgeStyle: React.CSSProperties = { flexShrink: 0, padding: "1px 4px", borderRadius: 4, background: "var(--accent-muted)", color: "var(--accent)", fontSize: 10, fontWeight: 650 };
const codeStyle: React.CSSProperties = { width: 18, flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-secondary)", textAlign: "center" };
const noticeStyle: React.CSSProperties = { minHeight: 140, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 24, textAlign: "center" };
const commitAreaStyle: React.CSSProperties = { position: "relative", zIndex: 1, flexShrink: 0, display: "grid", gap: 7, padding: "10px 12px", borderTop: "1px solid var(--separator)", background: "var(--surface)", boxShadow: "0 -6px 18px rgba(0, 0, 0, 0.06)" };
const stageHelperStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 8px", border: "1px solid var(--separator)", borderRadius: 7, background: "var(--bg-elevated)" };
const stageHelperTextStyle: React.CSSProperties = { minWidth: 0, fontSize: 11.5, lineHeight: 1.35, color: "var(--text-secondary)" };
const batchButtonStyle: React.CSSProperties = { minHeight: 28, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4, padding: "0 8px", border: "1px solid var(--separator)", borderRadius: 6, background: "var(--bg-base)", color: "var(--text-primary)", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" };
const commitLabelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 650, color: "var(--text-primary)" };
const aiDraftButtonStyle: React.CSSProperties = { minHeight: 28, display: "inline-flex", alignItems: "center", gap: 5, padding: "0 8px", border: "1px solid var(--separator)", borderRadius: 7, background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 11.5 };
const commitInputStyle: React.CSSProperties = { width: "100%", minHeight: 62, resize: "vertical", padding: "7px 8px", border: "1px solid var(--separator)", borderRadius: 7, background: "var(--bg-elevated)", color: "var(--text-primary)", fontFamily: "var(--font-ui)", fontSize: 12, lineHeight: 1.45, outline: "none" };
const commitButtonStyle: React.CSSProperties = { minHeight: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: "1px solid var(--accent)", borderRadius: 7, background: "var(--accent)", color: "var(--text-on-accent)", fontSize: 12, fontWeight: 650 };
const disabledReasonStyle: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.4, color: "var(--text-secondary)" };

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDot,
  FileQuestion,
  GitBranch,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUI } from "@/lib/store";
import { effectiveBindings, isMacPlatform, matchesBinding, shortcutById } from "@/lib/shortcuts";
import type {
  RepositoryFileStatus,
  RepositorySnapshot,
} from "@/lib/backend/ports/repository";
import { useRepository, type RepositoryScope, type RepositorySelection } from "@/lib/repository";
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
      color: "var(--text-tertiary)",
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
  const [confirmCommit, setConfirmCommit] = useState(false);
  const scope = useMemo<RepositoryScope | null>(() => {
    if (!root) return null;
    return { targetId, workspaceRoot: root, binding };
  }, [binding, root, targetId]);

  useEffect(() => {
    if (!scope) {
      useRepository.getState().clear();
      return;
    }
    void useRepository.getState().refresh(scope);
  }, [scope]);

  const refresh = () => {
    if (scope) void useRepository.getState().refresh(scope);
  };


  const writeDisabled = piStatus === "running" || loading || mutating || Boolean(result?.kind === "repository" && (result.operation || result.files.some((file) => file.conflicted)));
  const writeDisabledReason = piStatus === "running"
    ? t("repository.writeDisabledPi")
    : result?.kind === "repository" && result.operation
      ? t("repository.writeDisabledOperation")
      : result?.kind === "repository" && result.files.some((file) => file.conflicted)
        ? t("repository.writeDisabledConflicts")
        : loading
          ? t("repository.writeDisabledRefreshing")
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
  const commit = async () => {
    const response = await useRepository.getState().mutate({ operation: "commit", message: commitMessage });
    if (!response) return;
    if (response.kind === "failure") {
      useExtUi.getState().pushToast(t(`repository.error.${response.reason}`), "error", 7000);
      return;
    }
    setCommitMessage("");
    setConfirmCommit(false);
    useExtUi.getState().pushToast(t("repository.commitSuccess", { oid: response.commitOid?.slice(0, 7) || "—" }), "info", 4000);
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
            className="pi-button"
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

  const stagedCount = result.files.filter((file) => file.staged && !file.conflicted).length;
  const commitReady = !writeDisabled && stagedCount > 0 && commitMessage.trim().length > 0;
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
              setConfirmCommit(true);
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
      style={{ minHeight: 0, flex: 1, overflow: "auto" }}
    >
      <div style={summaryStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <GitBranch size={15} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
          <strong style={branchStyle}>{headLabel(result, t)}</strong>
          {result.operation && <span style={operationStyle}>{t(`repository.operation.${result.operation}`)}</span>}
        </div>
        <button type="button" className="pi-icon-button" aria-label={t("repository.refresh")} onClick={refresh} disabled={loading} style={iconButtonStyle}>
          <RefreshCw size={14} className={loading ? "pi-spin" : undefined} />
        </button>
        <div style={metaStyle}>
          <span>{t("repository.changedCount", { count: changedCount })}</span>
          {result.upstream && <span title={result.upstream}>↑{ahead} ↓{behind}</span>}
          {error && <span title={error} style={{ color: "var(--danger)" }}>{t("repository.loadFailed")}</span>}
          {result.head.kind !== "unborn" && result.head.oid && <span>{result.head.oid.slice(0, 7)}</span>}
        </div>
      </div>

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
            writeDisabled={writeDisabled}
            writeDisabledReason={writeDisabledReason}
            mutating={mutating}
            t={t}
          />
        ))
      )}
      <div style={commitAreaStyle}>
        <label htmlFor="repository-commit-message" style={commitLabelStyle}>
          {t("repository.commitMessage")}
        </label>
        <textarea
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
          className="pi-button"
          disabled={!commitReady}
          title={writeDisabledReason || (stagedCount === 0 ? t("repository.nothingStaged") : undefined)}
          onClick={() => setConfirmCommit(true)}
          style={commitButtonStyle}
        >
          {mutating ? <Loader2 size={13} className="pi-spin" /> : null}
          {t("repository.commitStaged", { count: stagedCount })}
        </button>
        {writeDisabledReason && <span style={disabledReasonStyle}>{writeDisabledReason}</span>}
      </div>
      <div style={footerStyle}>{t("repository.safeWriteFooter")}</div>
      <ConfirmDialog
        open={confirmCommit}
        title={t("repository.confirmCommitTitle")}
        message={t("repository.confirmCommitMessage", { count: stagedCount })}
        detail={commitMessage.trim()}
        confirmLabel={t("repository.commitConfirm")}
        danger={false}
        onConfirm={commit}
        onCancel={() => setConfirmCommit(false)}
      />
    </div>
  );
}

function RepositoryGroup({
  group,
  piPaths,
  onSelect,
  onMutate,
  writeDisabled,
  writeDisabledReason,
  mutating,
  t,
}: {
  group: StatusGroup;
  piPaths: Set<string>;
  onSelect: (selection: RepositorySelection) => void;
  onMutate: (file: RepositoryFileStatus, operation: "stage" | "unstage") => void;
  writeDisabled: boolean;
  writeDisabledReason?: string;
  mutating: boolean;
  t: ReturnType<typeof useT>;
}) {
  const Icon = group.icon;
  return (
    <section style={{ padding: "10px 0 4px" }}>
      <div style={groupHeaderStyle}>
        <Icon size={13} style={{ color: group.color }} />
        <span>{t(`repository.group.${group.key}`)}</span>
        <span style={countStyle}>{group.files.length}</span>
      </div>
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
      {detail && <span style={{ maxWidth: 300, fontSize: 11.5, lineHeight: 1.5, color: "var(--text-tertiary)" }}>{detail}</span>}
      {action && onAction && <button type="button" className="pi-button" onClick={onAction} style={openButtonStyle}>{action}</button>}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = { width: 28, height: 28, display: "grid", placeItems: "center", border: 0, background: "transparent", color: "var(--text-secondary)", borderRadius: 6 };
const detailHeaderStyle: React.CSSProperties = { minHeight: 52, display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border-subtle)" };
const pathTitleStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-primary)" };
const subtitleStyle: React.CSSProperties = { marginTop: 2, fontSize: 10.5, color: "var(--text-tertiary)" };
const openButtonStyle: React.CSSProperties = { minHeight: 28, padding: "0 9px", border: "1px solid var(--border-subtle)", borderRadius: 6, background: "var(--surface-raised)", color: "var(--text-secondary)", fontSize: 11 };
const summaryStyle: React.CSSProperties = { position: "relative", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "5px 8px", padding: "12px 12px 10px", borderBottom: "1px solid var(--border-subtle)" };
const branchStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: "var(--text-primary)" };
const operationStyle: React.CSSProperties = { padding: "2px 5px", borderRadius: 4, background: "var(--diff-remove-bg)", color: "var(--danger)", fontSize: 9.5, fontWeight: 600, textTransform: "uppercase" };
const metaStyle: React.CSSProperties = { gridColumn: "1 / -1", display: "flex", gap: 10, paddingLeft: 23, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-tertiary)" };
const groupHeaderStyle: React.CSSProperties = { height: 26, display: "flex", alignItems: "center", gap: 6, padding: "0 12px", color: "var(--text-secondary)", fontSize: 10.5, fontWeight: 650, letterSpacing: "0.04em", textTransform: "uppercase" };
const countStyle: React.CSSProperties = { marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: 500, color: "var(--text-tertiary)" };
const fileRowStyle: React.CSSProperties = { width: "100%", minHeight: 34, display: "flex", alignItems: "center", padding: "0 8px 0 30px", background: "transparent", color: "var(--text-secondary)" };
const fileSelectStyle: React.CSSProperties = { minWidth: 0, minHeight: 34, flex: 1, display: "flex", alignItems: "center", gap: 7, padding: "5px 2px", border: 0, background: "transparent", color: "var(--text-secondary)", textAlign: "left" };
const mutationButtonStyle: React.CSSProperties = { width: 26, height: 26, flexShrink: 0, display: "grid", placeItems: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-tertiary)" };
const fileNameStyle: React.CSSProperties = { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-primary)" };
const renameStyle: React.CSSProperties = { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-tertiary)" };
const piBadgeStyle: React.CSSProperties = { flexShrink: 0, padding: "1px 4px", borderRadius: 4, background: "var(--accent-subtle)", color: "var(--accent)", fontSize: 9, fontWeight: 600 };
const codeStyle: React.CSSProperties = { width: 18, flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-tertiary)", textAlign: "center" };
const noticeStyle: React.CSSProperties = { minHeight: 180, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 24, textAlign: "center" };
const commitAreaStyle: React.CSSProperties = { display: "grid", gap: 7, padding: "10px 12px", borderTop: "1px solid var(--border-subtle)", background: "var(--surface-base)" };
const commitLabelStyle: React.CSSProperties = { fontSize: 10.5, fontWeight: 650, color: "var(--text-secondary)" };
const commitInputStyle: React.CSSProperties = { width: "100%", minHeight: 62, resize: "vertical", padding: "7px 8px", border: "1px solid var(--border-subtle)", borderRadius: 6, background: "var(--surface-raised)", color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 11.5, lineHeight: 1.4, outline: "none" };
const commitButtonStyle: React.CSSProperties = { minHeight: 30, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: "1px solid var(--border-subtle)", borderRadius: 6, background: "var(--surface-raised)", color: "var(--text-primary)", fontSize: 11, fontWeight: 600 };
const disabledReasonStyle: React.CSSProperties = { fontSize: 10, lineHeight: 1.35, color: "var(--text-tertiary)" };
const footerStyle: React.CSSProperties = { padding: "12px", borderTop: "1px solid var(--border-subtle)", fontSize: 10.5, color: "var(--text-tertiary)", textAlign: "center" };

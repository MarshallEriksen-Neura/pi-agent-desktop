"use client";

import { useEffect, useMemo, useRef } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { usePi } from "@/lib/pi/store";
import { useSessions } from "@/lib/pi/sessions";
import { useRepository, type RepositoryScope } from "@/lib/repository";
import { useFileInspector } from "@/lib/file-inspector";
import { LOCAL_WORKSPACE_TARGET } from "@/lib/workspace-target";
import { useT } from "@/lib/i18n";

const LOCAL_POLL_MS = 10_000;
const MIN_WIDTH_FOR_BRANCH = 320;
const COMPACT_WIDTH = 380;

/** Compact entry point to the authoritative repository status in the shared inspector. */
export function GitBranchLabel({ width }: { width?: number }) {
  const root = useWorkspace((state) => state.root);
  const targetId = useWorkspace((state) => state.targetId);
  const switching = useWorkspace((state) => state.switching);
  const binding = useSessions((state) => state.executionBinding);
  const piStatus = usePi((state) => state.status);
  const result = useRepository((state) => state.result);
  const loading = useRepository((state) => state.loading);
  const t = useT();
  const previousPiStatus = useRef(piStatus);

  const scope = useMemo<RepositoryScope | null>(() => {
    if (!root) return null;
    return { targetId, workspaceRoot: root, binding };
  }, [binding, root, targetId]);

  useEffect(() => {
    if (scope) void useRepository.getState().refresh(scope);
  }, [scope]);

  useEffect(() => {
    const previous = previousPiStatus.current;
    previousPiStatus.current = piStatus;
    if (previous !== "ready" && piStatus === "ready" && scope) {
      void useRepository.getState().refresh(scope);
    }
  }, [piStatus, scope]);

  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "hidden" && scope) {
        void useRepository.getState().refresh(scope);
      }
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [scope]);

  useEffect(() => {
    if (!scope || targetId !== LOCAL_WORKSPACE_TARGET) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void useRepository.getState().refresh(scope);
    }, LOCAL_POLL_MS);
    return () => clearInterval(timer);
  }, [scope, targetId]);

  if (
    switching ||
    !scope ||
    result?.kind !== "repository" ||
    result.targetId !== scope.targetId ||
    result.workspaceRoot !== scope.workspaceRoot
  ) return null;
  if (width !== undefined && width < MIN_WIDTH_FOR_BRANCH) return null;

  const label = result.head.kind === "branch"
    ? result.head.name
    : result.head.kind === "detached"
      ? result.head.oid?.slice(0, 7) || t("repository.detached")
      : result.head.name || t("repository.unborn");
  const changed = result.files.length;

  return (
    <button
      type="button"
      onClick={() => useFileInspector.getState().openRepository()}
      title={t("repository.open", { branch: label, count: changed })}
      aria-label={t("repository.open", { branch: label, count: changed })}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        marginRight: 4,
        padding: "4px 7px",
        border: "1px solid var(--separator)",
        borderRadius: 99,
        background: "transparent",
        color: changed > 0 ? "var(--text-secondary)" : "var(--text-tertiary)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        lineHeight: 1,
        maxWidth: width !== undefined && width < COMPACT_WIDTH ? 88 : 144,
        minWidth: 0,
        cursor: "pointer",
      }}
    >
      {loading ? (
        <RefreshCw size={12} className="pi-spin" style={{ flexShrink: 0 }} />
      ) : (
        <GitBranch size={12} strokeWidth={1.75} style={{ flexShrink: 0 }} />
      )}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {changed > 0 && (
        <span style={{ flexShrink: 0, color: "var(--accent)", fontWeight: 650 }}>{changed}</span>
      )}
    </button>
  );
}

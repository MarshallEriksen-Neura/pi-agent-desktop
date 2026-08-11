import { memo, useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Folder, RefreshCw, FolderPlus, AlertCircle } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { StateView, FullScreenSpinner } from "@/components/primitives";
import {
  MobileCard,
  MobileRow,
  BlockButton,
  EmptyState,
} from "@/components/visual";
import { NetError } from "@/net/errors";
import type { RemoteProjectSummary } from "@pi/remote-control-contracts";

/** Get the live RemoteControlClient from the connection store (non-reactive). */
function useClient() {
  return useConnectionStore((s) => s.client);
}

/**
 * ProjectsPage — 列出已授权的桌面项目。只展示 name + opaque projectId,
 * 不显示绝对路径(设计约束)。
 *
 * State matrix:
 *  - loading: spinner
 *  - empty: EmptyState
 *  - offline: offline StateView
 *  - auth_failed: re-pair StateView
 *  - success: project list, tap → /projects/:id/tree
 */
export const ProjectsPage = memo(function ProjectsPage() {
  const navigate = useNavigate();
  const { isOnline, isIdentityFailed } = useConnection();
  const client = useClient();
  const [projects, setProjects] = useState<RemoteProjectSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) {
      setError("not_paired");
      setLoading(false);
      return;
    }
    const isFirst = !projects;
    setLoading(isFirst);
    setRefreshing(!isFirst);
    setError(null);
    try {
      const list = await client.getProjects();
      setProjects(list);
    } catch (e) {
      const kind = e instanceof NetError ? e.kind : "unknown";
      const message = e instanceof NetError ? e.message : "fetch_failed";
      setError(kind === "auth_failed" ? "auth_failed" : message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [client, projects]);

  useEffect(() => {
    void load();
  }, [load]);

  if (isIdentityFailed) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-danger)" }} />}
        title={t("error.identityRotated")}
        detail={t("error.identityRotatedDetail")}
        action={
          <BlockButton variant="outline" onClick={() => navigate("/pair")}>
            {t("onboarding.start")}
          </BlockButton>
        }
      />
    );
  }

  if (!isOnline) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.offline")}
        detail={t("error.offlineDetail")}
      />
    );
  }

  if (loading) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  if (error === "auth_failed") {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-danger)" }} />}
        title={t("error.authFailed")}
        detail={t("error.authFailedDetail")}
        action={
          <BlockButton variant="outline" onClick={() => navigate("/pair")}>
            {t("onboarding.start")}
          </BlockButton>
        }
      />
    );
  }

  if (error && projects === null) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.unknown")}
        detail={error}
        action={
          <BlockButton variant="primary" onClick={load}>
            {t("common.retry")}
          </BlockButton>
        }
      />
    );
  }

  if (projects && projects.length === 0) {
    return (
      <EmptyState icon={<FolderPlus size={28} />}>
        {t("projects.emptyDetail")}
      </EmptyState>
    );
  }

  return (
    <div className="page-scroll">
      <Header refreshing={refreshing} onRefresh={load} />

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <MobileCard>
          {projects!.map((p) => (
            <MobileRow
              key={p.projectId}
              icon={<Folder size={16} />}
              title={p.name}
              detail={p.lastOpenedAt ? formatRelative(p.lastOpenedAt) : undefined}
              onClick={() =>
                navigate(`/projects/${encodeURIComponent(p.projectId)}/tree`)
              }
            />
          ))}
        </MobileCard>
      </motion.div>
    </div>
  );
});

function Header({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 16,
      }}
    >
      <h1
        style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          margin: "8px 0",
        }}
      >
        {t("projects.title")}
      </h1>
      <motion.button
        whileTap={{ scale: 0.92 }}
        onClick={onRefresh}
        disabled={refreshing}
        style={{
          background: "transparent",
          border: "none",
          cursor: refreshing ? "default" : "pointer",
          color: "var(--color-accent)",
          display: "grid",
          placeItems: "center",
          padding: 8,
        }}
      >
        <RefreshCw size={20} className={refreshing ? "pi-spin" : ""} />
      </motion.button>
    </div>
  );
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("projects.justNow");
  if (min < 60) return `${min} ${t("projects.minutesAgo")}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${t("projects.hoursAgo")}`;
  const day = Math.floor(hr / 24);
  return `${day} ${t("projects.daysAgo")}`;
}

import { memo, useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Folder, ChevronRight, RefreshCw, FolderPlus, AlertCircle } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { Card, Row, StateView, FullScreenSpinner, PrimaryButton } from "@/components/primitives";
import { NetError } from "@/net/errors";
import type { RemoteProjectSummary } from "@pi/remote-control-contracts";

/** Get the live RemoteControlClient from the connection store (non-reactive). */
function useClient() {
  return useConnectionStore((s) => s.client);
}

/**
 * ProjectsPage — lists explicitly authorized desktop projects. Never displays
 * absolute paths (design constraint: only name + opaque projectId).
 *
 * State matrix:
 *  - loading: spinner
 *  - empty: empty state with hint
 *  - offline: offline state
 *  - 401/auth_failed: auth-failed state → re-pair
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

  // Identity failed — needs re-pair
  if (isIdentityFailed) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-danger)" }} />}
        title={t("error.identityRotated")}
        detail={t("error.identityRotatedDetail")}
        action={<PrimaryButton onClick={() => navigate("/pair")}>{t("onboarding.start")}</PrimaryButton>}
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
        action={<PrimaryButton onClick={() => navigate("/pair")}>{t("onboarding.start")}</PrimaryButton>}
      />
    );
  }

  if (error && projects === null) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.unknown")}
        detail={error}
        action={<PrimaryButton onClick={load}>{t("common.retry")}</PrimaryButton>}
      />
    );
  }

  if (projects && projects.length === 0) {
    return (
      <StateView
        icon={<FolderPlus size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("projects.empty")}
        detail={t("projects.emptyDetail")}
      />
    );
  }

  return (
    <div style={{ padding: "16px", overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", margin: "8px 0" }}>
          {t("projects.title")}
        </h1>
        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={load}
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

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <Card>
          {projects!.map((p) => (
            <Row
              key={p.projectId}
              icon={<Folder size={16} />}
              title={p.name}
              detail={p.lastOpenedAt ? formatRelative(p.lastOpenedAt) : undefined}
              trailing={<ChevronRight size={18} style={{ color: "var(--color-text-tertiary)" }} />}
              onClick={() => navigate(`/projects/${encodeURIComponent(p.projectId)}/tree`)}
            />
          ))}
        </Card>
      </motion.div>
    </div>
  );
});

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

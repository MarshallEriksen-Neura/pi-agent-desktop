import { memo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  RefreshCw,
  AlertCircle,
  MessageSquare,
  Plus,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useTaskStore, type OutputFragment } from "@/stores/task-store";
import { useInteractionStore, selectPendingCount } from "@/stores/interaction-store";
import { StateView, FullScreenSpinner } from "@/components/primitives";
import {
  SectionLabel,
  MobileCard,
  MobileRow,
  BlockButton,
  EmptyState,
} from "@/components/visual";
import { TaskCard } from "@/components/task-visual";
import type { RemoteTaskSnapshot } from "@pi/remote-control-contracts";
import { REMOTE_TASK_TERMINAL_STATES } from "@pi/remote-control-contracts";

/**
 * TasksPage — 任务列表,按 active / history 分组。
 *
 * Visual(对齐 demo):
 *  - active:独立 TaskCard(running 态 tdot 脉冲;awaiting_input 态光晕边框)
 *  - history:独立 TaskCard(终态 tdot)
 *  - pending interactions:accent 高亮 MobileCard 横幅
 */
export const TasksPage = memo(function TasksPage() {
  const navigate = useNavigate();
  const { isOnline, isIdentityFailed } = useConnection();
  const tasks = useTaskStore((s) => s.tasks);
  const loading = useTaskStore((s) => s.loading);
  const refreshing = useTaskStore((s) => s.refreshing);
  const error = useTaskStore((s) => s.error);
  const refresh = useTaskStore((s) => s.refresh);
  const pendingInteractionCount = useInteractionStore(selectPendingCount);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  if (loading && tasks.length === 0) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  if (error && tasks.length === 0) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.unknown")}
        detail={error}
        action={
          <BlockButton variant="primary" onClick={refresh}>
            {t("common.retry")}
          </BlockButton>
        }
      />
    );
  }

  const active = tasks.filter(
    (task) => !REMOTE_TASK_TERMINAL_STATES.includes(task.state),
  );
  const history = tasks.filter((task) =>
    REMOTE_TASK_TERMINAL_STATES.includes(task.state),
  );

  if (tasks.length === 0) {
    return (
      <div className="page-scroll">
        <Header refreshing={refreshing} onRefresh={refresh} />
        <EmptyState icon={<Plus size={28} />}>
          <div style={{ marginBottom: 8 }}>{t("home.noTasksDetail")}</div>
          <BlockButton variant="outline" onClick={() => navigate("/projects")}>
            {t("home.projects")}
          </BlockButton>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page-scroll">
      <Header refreshing={refreshing} onRefresh={refresh} />

      {/* Pending interactions banner */}
      {pendingInteractionCount > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ marginBottom: 16 }}
        >
          <MobileCard
            style={{
              background: "var(--color-accent-muted)",
              borderColor: "var(--color-accent)",
              boxShadow: "none",
            }}
          >
            <MobileRow
              icon={<MessageSquare size={16} />}
              title={t("interaction.pendingBanner", {
                count: pendingInteractionCount,
              })}
              detail={t("interaction.pendingBannerDetail")}
              onClick={() => navigate("/interactions")}
            />
          </MobileCard>
        </motion.div>
      )}

      {/* Active tasks — 独立 TaskCard */}
      {active.length > 0 && (
        <>
          <SectionLabel>{t("tasks.active")}</SectionLabel>
          {active.map((task) => (
            <TaskCard
              key={task.taskId}
              title={taskLabel(task)}
              meta={`${t(`tasks.state.${task.state}`)} · ${formatTime(task.updatedAt)}`}
              state={task.state}
              awaiting={task.state === "awaiting_input"}
              onClick={() => navigate(`/tasks/${task.taskId}`)}
            />
          ))}
          <div style={{ height: 16 }} />
        </>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <SectionLabel>{t("tasks.history")}</SectionLabel>
          {history.map((task) => (
            <TaskCard
              key={task.taskId}
              title={taskLabel(task)}
              meta={`${t(`tasks.state.${task.state}`)} · ${formatTime(task.updatedAt)}`}
              state={task.state}
              onClick={() => navigate(`/tasks/${task.taskId}`)}
            />
          ))}
        </>
      )}
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
        {t("tasks.title")}
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

function taskLabel(task: RemoteTaskSnapshot): string {
  // Snapshot 不携带 prompt(设计:只暴露元数据)。用首个 context file 作提示,
  // 回退到短 taskId。
  if (task.contextFiles.length > 0) {
    const first =
      task.contextFiles[0].relativePath.split("/").pop() ??
      task.contextFiles[0].relativePath;
    const extra =
      task.contextFiles.length > 1 ? ` +${task.contextFiles.length - 1}` : "";
    return `${first}${extra}`;
  }
  return `${t("tasks.untitled")} ${task.taskId.slice(0, 8)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// Re-export OutputFragment type for consumers (keeps the import surface stable).
export type { OutputFragment };

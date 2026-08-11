import { memo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  RefreshCw,
  ChevronRight,
  AlertCircle,
  MessageSquare,
  Plus,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import {
  useTaskStore,
  type OutputFragment,
} from "@/stores/task-store";
import { useInteractionStore, selectPendingCount } from "@/stores/interaction-store";
import { Card, Row, StateView, FullScreenSpinner, PrimaryButton } from "@/components/primitives";
import type { RemoteTaskSnapshot, RemoteTaskState } from "@pi/remote-control-contracts";
import { REMOTE_TASK_TERMINAL_STATES } from "@pi/remote-control-contracts";

/**
 * TasksPage — lists tasks grouped by active vs. history. The active group
 * includes queued/starting/running/awaiting_input; history includes terminal
 * states. A pending-interactions banner provides a clear entry point to the
 * InteractionsPage (design §6: awaiting_input must not be hidden in logs).
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

  // Identity failed
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

  if (loading && tasks.length === 0) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  if (error && tasks.length === 0) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.unknown")}
        detail={error}
        action={<PrimaryButton onClick={refresh}>{t("common.retry")}</PrimaryButton>}
      />
    );
  }

  const active = tasks.filter((task) => !REMOTE_TASK_TERMINAL_STATES.includes(task.state));
  const history = tasks.filter((task) => REMOTE_TASK_TERMINAL_STATES.includes(task.state));

  if (tasks.length === 0) {
    return (
      <div style={{ padding: "16px", height: "100%", overflowY: "auto" }}>
        <Header refreshing={refreshing} onRefresh={refresh} />
        <StateView
          icon={<Plus size={28} style={{ color: "var(--color-text-tertiary)" }} />}
          title={t("home.noTasks")}
          detail={t("home.noTasksDetail")}
          action={<PrimaryButton onClick={() => navigate("/projects")}>{t("home.projects")}</PrimaryButton>}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: "16px", overflowY: "auto", height: "100%" }}>
      <Header refreshing={refreshing} onRefresh={refresh} />

      {/* Pending interactions banner */}
      {pendingInteractionCount > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ marginBottom: 16 }}
        >
          <Card style={{ background: "var(--color-accent-muted)", borderColor: "var(--color-accent)" }}>
            <Row
              icon={<MessageSquare size={16} />}
              title={t("interaction.pendingBanner", { count: pendingInteractionCount })}
              detail={t("interaction.pendingBannerDetail")}
              trailing={<ChevronRight size={18} style={{ color: "var(--color-accent)" }} />}
              onClick={() => navigate("/interactions")}
            />
          </Card>
        </motion.div>
      )}

      {/* Active tasks */}
      {active.length > 0 && (
        <>
          <SectionLabel>{t("tasks.active")}</SectionLabel>
          <Card style={{ marginBottom: 24 }}>
            {active.map((task) => (
              <TaskRow key={task.taskId} task={task} onClick={() => navigate(`/tasks/${task.taskId}`)} />
            ))}
          </Card>
        </>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <SectionLabel>{t("tasks.history")}</SectionLabel>
          <Card>
            {history.map((task) => (
              <TaskRow key={task.taskId} task={task} onClick={() => navigate(`/tasks/${task.taskId}`)} />
            ))}
          </Card>
        </>
      )}
    </div>
  );
});

function Header({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", margin: "8px 0" }}>
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

function TaskRow({ task, onClick }: { task: RemoteTaskSnapshot; onClick: () => void }) {
  const { icon } = stateVisual(task.state);
  return (
    <Row
      icon={icon}
      title={taskLabel(task)}
      detail={`${t(`tasks.state.${task.state}`)} · ${formatTime(task.updatedAt)}`}
      trailing={<ChevronRight size={18} style={{ color: "var(--color-text-tertiary)" }} />}
      onClick={onClick}
    />
  );
}

function taskLabel(task: RemoteTaskSnapshot): string {
  // The snapshot doesn't carry the prompt (design: only metadata is exposed).
  // Use the first context file as a hint, falling back to a short taskId.
  if (task.contextFiles.length > 0) {
    const first = task.contextFiles[0].relativePath.split("/").pop() ?? task.contextFiles[0].relativePath;
    const extra = task.contextFiles.length > 1 ? ` +${task.contextFiles.length - 1}` : "";
    return `${first}${extra}`;
  }
  return `${t("tasks.untitled")} ${task.taskId.slice(0, 8)}`;
}

function stateVisual(state: RemoteTaskState): { icon: React.ReactNode } {
  switch (state) {
    case "queued":
    case "starting":
      return { icon: <Clock size={16} /> };
    case "running":
      return { icon: <Loader2 size={16} className="pi-spin" /> };
    case "awaiting_input":
      return { icon: <MessageSquare size={16} /> };
    case "succeeded":
      return { icon: <CheckCircle2 size={16} /> };
    case "failed":
      return { icon: <XCircle size={16} /> };
    case "cancelled":
      return { icon: <XCircle size={16} /> };
  }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: "var(--color-text-tertiary)",
        padding: "0 4px 8px",
      }}
    >
      {children}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// Re-export OutputFragment type for consumers (keeps the import surface stable).
export type { OutputFragment };

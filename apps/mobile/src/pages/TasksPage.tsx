import { memo, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import {
  RefreshCw,
  AlertCircle,
  MessageSquare,
  Plus,
  ChevronRight,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useTaskStore, type OutputFragment } from "@/stores/task-store";
import { usePromptCache } from "@/stores/prompt-cache";
import { useConversationStore } from "@/stores/conversation-store";
import { useInteractionStore, selectPending } from "@/stores/interaction-store";
import { StateView, FullScreenSpinner } from "@/components/primitives";
import { BlockButton, EmptyState } from "@/components/visual";
import { TaskCard } from "@/components/task-visual";
import { taskTitle, formatClock } from "@/lib/task-label";
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
  const pending = useInteractionStore(useShallow(selectPending));
  const promptCache = usePromptCache((s) => s.prompts);
  const v2Available = useConversationStore((s) => s.v2Available);
  const probeCapabilities = useConversationStore((s) => s.probeCapabilities);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeOpen, setActiveOpen] = useState(true);

  useEffect(() => {
    void probeCapabilities();
  }, [probeCapabilities]);

  useEffect(() => {
    if (v2Available !== true) void refresh();
  }, [refresh, v2Available]);

  if (v2Available === true) {
    return <ConversationList />;
  }

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

  const firstPending = pending[0];

  return (
    <div className="page-scroll">
      <Header refreshing={refreshing} onRefresh={refresh} />

      {/* Awaiting a reply is pinned above the groups — it must never be buried
          among ordinary tasks. Tapping goes to the task, where the request is
          answerable inline with its context. */}
      {firstPending && (
        <motion.button
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="awaiting-banner"
          onClick={() => navigate(`/tasks/${encodeURIComponent(firstPending.taskId)}`)}
        >
          <span className="ai">
            <MessageSquare size={16} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="at" style={{ display: "block" }}>
              {t("interaction.pendingBanner", { count: pending.length })}
            </span>
            <span
              className="as"
              style={{
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {firstPending.prompt}
            </span>
          </span>
          <ChevronRight size={16} className="chev" style={{ flexShrink: 0 }} />
        </motion.button>
      )}

      {active.length > 0 && (
        <TaskGroup
          label={t("tasks.active")}
          count={active.length}
          open={activeOpen}
          onToggle={() => setActiveOpen((v) => !v)}
        >
          {active.map((task) => (
            <TaskCard
              key={task.taskId}
              title={taskTitle(task, promptCache)}
              meta={`${t(`tasks.state.${task.state}`)} · ${formatClock(task.updatedAt)}`}
              state={task.state}
              awaiting={task.state === "awaiting_input"}
              onClick={() => navigate(`/tasks/${encodeURIComponent(task.taskId)}`)}
            />
          ))}
        </TaskGroup>
      )}

      {history.length > 0 && (
        <TaskGroup
          label={t("tasks.history")}
          count={history.length}
          open={historyOpen}
          onToggle={() => setHistoryOpen((v) => !v)}
        >
          {history.map((task) => (
            <TaskCard
              key={task.taskId}
              title={taskTitle(task, promptCache)}
              meta={`${t(`tasks.state.${task.state}`)} · ${formatClock(task.updatedAt)}`}
              state={task.state}
              onClick={() => navigate(`/tasks/${encodeURIComponent(task.taskId)}`)}
            />
          ))}
        </TaskGroup>
      )}
    </div>
  );
});

const ConversationList = memo(function ConversationList() {
  const navigate = useNavigate();
  const { isOnline, isIdentityFailed } = useConnection();
  const summaries = useConversationStore((s) => s.summaries);
  const loading = useConversationStore((s) => s.loading);
  const error = useConversationStore((s) => s.error);
  const refresh = useConversationStore((s) => s.refreshConversations);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (isIdentityFailed) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-danger)" }} />}
        title={t("error.identityRotated")}
        detail={t("error.identityRotatedDetail")}
        action={<BlockButton variant="outline" onClick={() => navigate("/pair")}>{t("onboarding.start")}</BlockButton>}
      />
    );
  }

  if (!isOnline) {
    return <StateView icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />} title={t("error.offline")} detail={t("error.offlineDetail")} />;
  }

  if (loading && summaries.length === 0) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  if (error && summaries.length === 0) {
    return <StateView icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />} title={t("error.unknown")} detail={error} action={<BlockButton variant="primary" onClick={refresh}>{t("common.retry")}</BlockButton>} />;
  }

  return (
    <div className="page-scroll">
      <Header refreshing={loading} onRefresh={refresh} />
      {summaries.length === 0 ? (
        <EmptyState icon={<Plus size={28} />}>
          <div style={{ marginBottom: 8 }}>{t("home.noTasksDetail")}</div>
          <BlockButton variant="outline" onClick={() => navigate("/projects")}>{t("home.projects")}</BlockButton>
        </EmptyState>
      ) : (
        summaries.map((conversation) => (
          <button
            key={conversation.conversationId}
            className="task-card"
            onClick={() => navigate(`/tasks/${encodeURIComponent(conversation.conversationId)}`)}
          >
            <span className={`tdot ${conversation.status === "idle" ? "done" : "live"}`} />
            <span className="tmain">
              <span className="ttitle">{conversation.title || conversation.latestMessagePreview || t("tasks.title")}</span>
              <span className="tmeta">{conversation.status} · {formatClock(conversation.updatedAt)}</span>
            </span>
            <ChevronRight size={16} className="chev" />
          </button>
        ))
      )}
    </div>
  );
});

/**
 * Collapsible task group. The header always shows the count, so a collapsed
 * group still tells you how much is inside.
 */
const TaskGroup = memo(function TaskGroup({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <button className="grp-head" aria-expanded={open} onClick={onToggle}>
        <span className="gt">{label}</span>
        <span className="gc">{count}</span>
        <ChevronRight size={14} className="gchev" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 340, damping: 32 }}
            style={{ overflow: "hidden" }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
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

// Re-export OutputFragment type for consumers (keeps the import surface stable).
export type { OutputFragment };

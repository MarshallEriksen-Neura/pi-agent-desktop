import { memo, useEffect, useMemo, useState } from "react";
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
import { StateView } from "@/components/primitives";
import { BlockButton, EmptyState } from "@/components/visual";
import { TaskCard } from "@/components/task-visual";
import { TaskCardSkeleton } from "@/components/skeleton";
import { SegmentedControl, type Segment } from "@/components/segmented";
import { AwaitingCard } from "@/components/awaiting-card";
import { IdentityFailedView, OfflineView } from "@/components/connection-trouble";
import { taskTitle, formatClock } from "@/lib/task-label";
import { REMOTE_TASK_TERMINAL_STATES } from "@pi/remote-control-contracts";

/**
 * TasksPage — 任务中心。复刻设计稿「任务中心」。
 *
 * 从可折叠分组改成四分段(待处理 / 进行中 / 已完成 / 全部),默认落在
 * 「待处理」。理由:
 *
 *  1. 「Pi 在等我回答」是这个 app 里唯一真正紧急的状态。旧版把它做成列表顶部
 *     一条横幅,横幅之下是普通任务 —— 用户滚两屏就看不见它了。分段让它成为
 *     默认视图,不滚动就在眼前。
 *  2. 待处理项现在**就地可答**,不再是「点进任务再答」。远程决策的价值在于快,
 *     多一跳就多一次放弃的机会。
 *  3. 折叠分组的计数需要展开才知道内容,分段的计数直接长在标签上。
 *
 * 「全部」段保留,因为前三段是互斥切分,用户偶尔需要一个不分类的总览。
 */

type Seg = "awaiting" | "active" | "done" | "all";

export const TasksPage = memo(function TasksPage() {
  const navigate = useNavigate();
  const { isOnline, isIdentityFailed, lastError, stored, connect, wake } = useConnection();
  const tasks = useTaskStore((s) => s.tasks);
  const loading = useTaskStore((s) => s.loading);
  const refreshing = useTaskStore((s) => s.refreshing);
  const error = useTaskStore((s) => s.error);
  const refresh = useTaskStore((s) => s.refresh);
  const pending = useInteractionStore(useShallow(selectPending));
  const promptCache = usePromptCache((s) => s.prompts);
  const refreshInteractions = useInteractionStore((s) => s.refresh);
  const v2Available = useConversationStore((s) => s.v2Available);
  const probeCapabilities = useConversationStore((s) => s.probeCapabilities);
  const [seg, setSeg] = useState<Seg>("awaiting");

  useEffect(() => {
    void probeCapabilities();
  }, [probeCapabilities]);

  useEffect(() => {
    if (v2Available !== true) void refresh();
  }, [refresh, v2Available]);

  // 待处理段是默认视图,交互列表必须和任务列表一起拉。
  useEffect(() => {
    if (isOnline) void refreshInteractions();
  }, [isOnline, refreshInteractions]);

  const active = useMemo(
    () => tasks.filter((task) => !REMOTE_TASK_TERMINAL_STATES.includes(task.state)),
    [tasks],
  );
  const history = useMemo(
    () => tasks.filter((task) => REMOTE_TASK_TERMINAL_STATES.includes(task.state)),
    [tasks],
  );

  if (v2Available === true) {
    return <ConversationList />;
  }

  if (isIdentityFailed) {
    return <IdentityFailedView detail={lastError} onRepair={() => navigate("/pair")} />;
  }

  if (!isOnline) {
    return (
      <OfflineView
        canWake={Boolean(stored?.wakeOnLan?.targets.length)}
        cachedTasks={tasks.slice(0, 3)}
        onReconnect={connect}
        onWake={wake}
      />
    );
  }

  // 首屏骨架:形状与 TaskCard 一致,落地时不跳版。
  if (loading && tasks.length === 0) {
    return (
      <div className="page-scroll">
        <Header refreshing={refreshing} onRefresh={refresh} />
        <TaskCardSkeleton count={3} />
      </div>
    );
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

  const segments: readonly Segment<Seg>[] = [
    {
      key: "awaiting",
      label: t("tasks.segAwaiting"),
      count: pending.length,
      awaiting: true,
    },
    { key: "active", label: t("tasks.segActive"), count: active.length },
    { key: "done", label: t("tasks.segDone") },
    { key: "all", label: t("tasks.segAll") },
  ];

  const taskRow = (task: (typeof tasks)[number]) => (
    <TaskCard
      key={task.taskId}
      title={taskTitle(task, promptCache)}
      meta={`${t(`tasks.state.${task.state}`)} · ${formatClock(task.updatedAt)}`}
      state={task.state}
      awaiting={task.state === "awaiting_input"}
      onClick={() => navigate(`/tasks/${encodeURIComponent(task.taskId)}`)}
    />
  );

  return (
    <div className="page-scroll">
      <Header refreshing={refreshing} onRefresh={refresh} />

      <SegmentedControl
        segments={segments}
        value={seg}
        onChange={setSeg}
        label={t("tasks.filter")}
      />

      {/* 待处理 —— 就地可答,不用点进任务 */}
      {seg === "awaiting" &&
        (pending.length === 0 ? (
          <EmptyState icon={<MessageSquare size={26} />}>
            <div style={{ marginBottom: 4 }}>{t("tasks.emptyAwaiting")}</div>
            <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
              {t("tasks.emptyAwaitingDetail")}
            </div>
          </EmptyState>
        ) : (
          <>
            <p
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--color-text-tertiary)",
                margin: "0 0 10px",
              }}
            >
              {t("interaction.expiresHint")}
            </p>
            <AnimatePresence>
              {pending.map((ix) => (
                <AwaitingCard key={ix.interactionId} interaction={ix} />
              ))}
            </AnimatePresence>
          </>
        ))}

      {seg === "active" &&
        (active.length === 0 ? (
          <EmptyState icon={<Plus size={26} />}>
            <div style={{ marginBottom: 8 }}>{t("tasks.emptyActive")}</div>
            <BlockButton variant="outline" onClick={() => navigate("/projects")}>
              {t("home.newTask")}
            </BlockButton>
          </EmptyState>
        ) : (
          active.map(taskRow)
        ))}

      {seg === "done" &&
        (history.length === 0 ? (
          <EmptyState icon={<Plus size={26} />}>{t("tasks.emptyDone")}</EmptyState>
        ) : (
          history.map(taskRow)
        ))}

      {seg === "all" &&
        (tasks.length === 0 ? (
          <EmptyState icon={<Plus size={26} />}>
            <div style={{ marginBottom: 8 }}>{t("tasks.emptyAll")}</div>
            <BlockButton variant="outline" onClick={() => navigate("/projects")}>
              {t("home.newTask")}
            </BlockButton>
          </EmptyState>
        ) : (
          tasks.map(taskRow)
        ))}
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
    return (
      <div className="page-scroll">
        <Header refreshing onRefresh={refresh} />
        <TaskCardSkeleton count={3} />
      </div>
    );
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

// TaskGroup(可折叠分组)已被 SegmentedControl 取代 —— 分段的计数直接长在标签
// 上,不需要展开才知道里面有多少。

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

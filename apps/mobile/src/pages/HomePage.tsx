import { memo, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { Plus, MessageSquare, ChevronRight } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useTaskStore } from "@/stores/task-store";
import { useInteractionStore, selectPending } from "@/stores/interaction-store";
import { usePromptCache } from "@/stores/prompt-cache";
import { SecureTetherHero } from "@/components/SecureTether";
import { TaskCard } from "@/components/task-visual";
import { TaskCardSkeleton } from "@/components/skeleton";
import {
  IdentityFailedView,
  OfflineView,
  ReconnectingView,
  WakingView,
} from "@/components/connection-trouble";
import { taskTitle, formatClock } from "@/lib/task-label";
import { REMOTE_TASK_TERMINAL_STATES } from "@pi/remote-control-contracts";

/** How many recent tasks the home page surfaces before deferring to /tasks. */
const RECENT_LIMIT = 3;

/**
 * HomePage — an overview, not a navigation menu.
 *
 * The old version offered two link rows, so the user had to drill in before
 * learning whether anything needed attention. Now the page answers "what's the
 * state of things?" at a glance: three stat cards, the highest-frequency action
 * (new task) as the primary CTA, anything awaiting a reply pinned above the
 * fold, and the most recent tasks tappable straight through to their transcript.
 *
 * Deliberately absent: the backend capability table (queue ceiling, protocol
 * version). Those are developer-facing numbers; a phone home screen is not where
 * they belong.
 */
export const HomePage = memo(function HomePage() {
  const navigate = useNavigate();
  const {
    stored,
    phase,
    lastError,
    isOnline,
    isReconnecting,
    isWaking,
    isIdentityFailed,
    connect,
    wake,
    disconnect,
  } = useConnection();

  const tasks = useTaskStore((s) => s.tasks);
  const refreshTasks = useTaskStore((s) => s.refresh);
  const pending = useInteractionStore(useShallow(selectPending));
  const promptCache = usePromptCache((s) => s.prompts);

  // Keep the counters honest when returning to the tab.
  useEffect(() => {
    if (isOnline) void refreshTasks();
  }, [isOnline, refreshTasks]);

  const active = useMemo(
    () => tasks.filter((task) => !REMOTE_TASK_TERMINAL_STATES.includes(task.state)),
    [tasks],
  );
  const recent = useMemo(() => tasks.slice(0, RECENT_LIMIT), [tasks]);

  // 连接异常四态各自渲染完整信息屏。核心信息是「桌面端的任务还在跑」——
  // 原来的 StateView 单行文案答不了这个问题,用户会以为一切都停了。
  if (isWaking) {
    return (
      <div>
        <SecureTetherHero phase={phase} showLabel={false} />
        <WakingView onCancel={disconnect} />
      </div>
    );
  }

  if (isReconnecting) {
    return (
      <div>
        <SecureTetherHero phase={phase} showLabel={false} />
        <ReconnectingView onRetryNow={connect} />
      </div>
    );
  }

  if (isIdentityFailed) {
    return (
      <div>
        <SecureTetherHero phase={phase} showLabel={false} />
        <IdentityFailedView detail={lastError} onRepair={() => navigate("/pair")} />
      </div>
    );
  }

  if (phase === "offline") {
    return (
      <div>
        <SecureTetherHero phase={phase} showLabel={false} />
        <OfflineView
          canWake={Boolean(stored?.wakeOnLan?.targets.length)}
          // 离线时 store 里的 tasks 是上次在线时的快照,可读但已陈旧。
          cachedTasks={tasks.slice(0, RECENT_LIMIT)}
          detail={lastError === "wake_timeout" ? t("wake.timeoutDetail") : undefined}
          onReconnect={connect}
          onWake={wake}
        />
      </div>
    );
  }

  // 首屏加载:骨架而非转圈。形状与真实内容一致,落地时不跳版。
  if (!stored || !isOnline) {
    return (
      <div style={{ padding: "8px 16px" }}>
        <TaskCardSkeleton count={2} />
      </div>
    );
  }

  const awaitingCount = pending.length;
  const firstPending = pending[0];

  return (
    <div>
      {/* Tether mark — the label lives in the hero below, not here */}
      <SecureTetherHero phase={phase} showLabel={false} />

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="mhero"
        data-st="online"
      >
        <div className="desk-name">{stored.desktopName}</div>
        <div className="status-line">
          <span className="sdot" />
          <span>{t("connection.online")}</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12 }}
        style={{ padding: "0 16px" }}
      >
        {/* Three numbers that answer "anything need me?" */}
        <div className="stats">
          <button className="stat accent" onClick={() => navigate("/tasks")}>
            <div className="sv">{active.length}</div>
            <div className="sl">{t("home.inProgress")}</div>
          </button>
          <button
            className="stat awaiting"
            onClick={() => navigate(awaitingCount > 0 ? "/interactions" : "/tasks")}
          >
            <div className="sv">{awaitingCount}</div>
            <div className="sl">{t("home.awaitingYou")}</div>
          </button>
          {/* Finished count — distinct from "active", so the three numbers
              partition the task list instead of overlapping. */}
          <button className="stat" onClick={() => navigate("/tasks")}>
            <div className="sv">{tasks.length - active.length}</div>
            <div className="sl">{t("tasks.history")}</div>
          </button>
        </div>

        {/* Primary action — starting a task is why the app exists */}
        <button className="cta-primary" onClick={() => navigate("/projects")}>
          <span className="ci">
            <Plus size={18} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="ct" style={{ display: "block" }}>
              {t("home.newTask")}
            </span>
            <span className="cs" style={{ display: "block" }}>
              {t("home.newTaskDetail")}
            </span>
          </span>
          <ChevronRight size={18} style={{ opacity: 0.9, flexShrink: 0 }} />
        </button>

        {/* Anything awaiting a reply is pinned above the task list */}
        {firstPending && (
          <motion.button
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className="awaiting-banner"
            onClick={() => navigate(`/tasks/${encodeURIComponent(firstPending.taskId)}`)}
          >
            <span className="ai">
              <MessageSquare size={16} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="at" style={{ display: "block" }}>
                {t("home.awaitingBanner", { count: awaitingCount })}
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

        {/* Recent tasks, tappable straight into the transcript */}
        {recent.length > 0 && (
          <>
            <div className="msec-row">
              <h4>{t("home.recentTasks")}</h4>
              <button className="see-all" onClick={() => navigate("/tasks")}>
                {t("home.seeAll")}
              </button>
            </div>
            {recent.map((task) => (
              <TaskCard
                key={task.taskId}
                title={taskTitle(task, promptCache)}
                meta={`${t(`tasks.state.${task.state}`)} · ${formatClock(task.updatedAt)}`}
                state={task.state}
                awaiting={task.state === "awaiting_input"}
                onClick={() => navigate(`/tasks/${encodeURIComponent(task.taskId)}`)}
              />
            ))}
          </>
        )}
      </motion.div>
    </div>
  );
});

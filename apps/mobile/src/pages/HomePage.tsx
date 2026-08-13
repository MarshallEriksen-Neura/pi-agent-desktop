import { memo, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { Monitor, Power, Plus, MessageSquare, ChevronRight } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useTaskStore } from "@/stores/task-store";
import { useInteractionStore, selectPending } from "@/stores/interaction-store";
import { usePromptCache } from "@/stores/prompt-cache";
import { SecureTetherHero } from "@/components/SecureTether";
import { StateView, FullScreenSpinner } from "@/components/primitives";
import { BlockButton } from "@/components/visual";
import { TaskCard } from "@/components/task-visual";
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

  if (isWaking) {
    return <FullScreenSpinner label={t("wake.waking")} />;
  }

  if (isReconnecting) {
    return (
      <div>
        <SecureTetherHero phase={phase} showLabel={false} />
        <FullScreenSpinner label={t("connection.reconnecting")} />
      </div>
    );
  }

  if (isIdentityFailed) {
    return (
      <StateView
        icon={<Monitor size={28} style={{ color: "var(--color-danger)" }} />}
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

  if (phase === "offline") {
    const canWake = Boolean(stored?.wakeOnLan?.targets.length);
    return (
      <StateView
        icon={
          canWake ? (
            <Power size={28} style={{ color: "var(--color-accent)" }} />
          ) : (
            <Monitor size={28} style={{ color: "var(--color-text-tertiary)" }} />
          )
        }
        title={t("error.unreachable")}
        detail={
          lastError === "wake_timeout"
            ? t("wake.timeoutDetail")
            : t("error.unreachableDetail")
        }
        action={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              width: "100%",
              maxWidth: 260,
            }}
          >
            {canWake && (
              <BlockButton variant="primary" onClick={wake}>
                {t("wake.action")}
              </BlockButton>
            )}
            <BlockButton variant={canWake ? "outline" : "primary"} onClick={connect}>
              {t("connection.reconnect")}
            </BlockButton>
          </div>
        }
      />
    );
  }

  if (!stored || !isOnline) {
    return <FullScreenSpinner label={t("common.loading")} />;
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

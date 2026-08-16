import { memo, useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Folder, RefreshCw, FolderPlus, AlertCircle, Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { useTaskStore } from "@/stores/task-store";
import { useInteractionStore, selectPending } from "@/stores/interaction-store";
import { StateView } from "@/components/primitives";
import {
  MobileCard,
  MobileRow,
  BlockButton,
  EmptyState,
} from "@/components/visual";
import { ListSkeleton } from "@/components/skeleton";
import { IdentityFailedView, OfflineView } from "@/components/connection-trouble";
import { NetError } from "@/net/errors";
import {
  REMOTE_TASK_TERMINAL_STATES,
  type RemoteProjectSummary,
} from "@pi/remote-control-contracts";

/** Get the live RemoteControlClient from the connection store (non-reactive). */
function useClient() {
  return useConnectionStore((s) => s.client);
}

/** 单个项目的任务聚合数。 */
interface ProjectStats {
  active: number;
  awaiting: number;
  done: number;
}

/**
 * ProjectsPage — 已授权项目列表,每项带任务聚合数。
 *
 * 与设计稿「项目详情」的偏差,以及为什么:
 *
 * 设计稿画的是单项目工作台,含 git 分支、未提交改动数、仓库绝对路径。这三项在
 * 当前协议里都拿不到 —— RemoteProjectSummary 只有 projectId / name /
 * lastOpenedAt,而绝对路径是**故意**不下发到手机端的(见旧版注释里的「设计约束」)。
 * 硬做的话只能塞假数据,那比不做更糟:用户会以为看到的是真实分支状态。
 *
 * 所以这一屏改成「项目 + 每个项目的任务态」:进行中 / 待我处理 / 已完成三个
 * 真实计数,从 task-store 和 interaction-store 按 projectId 聚合。这保留了设计
 * 稿数据格子的信息密度意图,但每个数字都是真的。
 *
 * 分支和未提交改动如果确实需要,得先在 remote-control-contracts 里给
 * RemoteProjectSummary 加字段并在桌面端实现 —— 那是协议层改动,不是 UI 改动。
 */
export const ProjectsPage = memo(function ProjectsPage() {
  const navigate = useNavigate();
  const { isOnline, isIdentityFailed, lastError, stored, connect, wake } = useConnection();
  const client = useClient();
  const tasks = useTaskStore((s) => s.tasks);
  const pending = useInteractionStore(useShallow(selectPending));
  const [projects, setProjects] = useState<RemoteProjectSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 按 projectId 聚合任务态。交互请求只带 taskId,所以要先经任务表反查
   * projectId —— 找不到对应任务的交互不计入(那通常是任务已被清理)。
   */
  const statsByProject = useMemo(() => {
    const map = new Map<string, ProjectStats>();
    const projectOfTask = new Map<string, string>();

    for (const task of tasks) {
      projectOfTask.set(task.taskId, task.projectId);
      const stat = map.get(task.projectId) ?? { active: 0, awaiting: 0, done: 0 };
      if (REMOTE_TASK_TERMINAL_STATES.includes(task.state)) stat.done += 1;
      else stat.active += 1;
      map.set(task.projectId, stat);
    }

    for (const ix of pending) {
      const projectId = projectOfTask.get(ix.taskId);
      if (!projectId) continue;
      const stat = map.get(projectId) ?? { active: 0, awaiting: 0, done: 0 };
      stat.awaiting += 1;
      map.set(projectId, stat);
    }

    return map;
  }, [tasks, pending]);

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
    return <IdentityFailedView detail={lastError} onRepair={() => navigate("/pair")} />;
  }

  if (!isOnline) {
    return (
      <OfflineView
        canWake={Boolean(stored?.wakeOnLan?.targets.length)}
        cachedTasks={[]}
        onReconnect={connect}
        onWake={wake}
      />
    );
  }

  if (loading) {
    return (
      <div className="page-scroll">
        <Header refreshing={false} onRefresh={load} />
        <ListSkeleton count={4} />
      </div>
    );
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
        <div style={{ marginBottom: 4 }}>{t("projects.empty")}</div>
        <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
          {t("projects.emptyDetail")}
        </div>
      </EmptyState>
    );
  }

  const list = projects ?? [];
  // 有任务在跑的项目排前面 —— 列表长了之后,用户关心的一定是有动静的那几个。
  const sorted = [...list].sort((a, b) => {
    const sa = statsByProject.get(a.projectId);
    const sb = statsByProject.get(b.projectId);
    const wa = (sa?.awaiting ?? 0) * 10 + (sa?.active ?? 0);
    const wb = (sb?.awaiting ?? 0) * 10 + (sb?.active ?? 0);
    return wb - wa;
  });

  return (
    <div className="page-scroll">
      <Header refreshing={refreshing} onRefresh={load} />

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {sorted.map((p) => (
          <ProjectCard
            key={p.projectId}
            project={p}
            stats={statsByProject.get(p.projectId)}
            onOpen={() => navigate(`/projects/${encodeURIComponent(p.projectId)}/tree`)}
            onCompose={() =>
              navigate(`/projects/${encodeURIComponent(p.projectId)}/compose`)
            }
            onOpenTasks={() => navigate("/tasks")}
          />
        ))}
      </motion.div>
    </div>
  );
});

/**
 * 项目卡片 —— 项目名 + 三个真实计数 + 两个动作。
 *
 * 计数格子可点:它们是「这个项目现在什么情况」到「让我去处理」之间最短的一跳。
 * 全 0 时不渲染格子,避免一屏三个 0 的视觉噪音。
 */
const ProjectCard = memo(function ProjectCard({
  project,
  stats,
  onOpen,
  onCompose,
  onOpenTasks,
}: {
  project: RemoteProjectSummary;
  stats?: ProjectStats;
  onOpen: () => void;
  onCompose: () => void;
  onOpenTasks: () => void;
}) {
  const hasActivity = Boolean(stats && (stats.active || stats.awaiting || stats.done));

  return (
    <MobileCard style={{ marginBottom: 10 }}>
      <MobileRow
        icon={<Folder size={16} />}
        title={project.name}
        detail={
          project.lastOpenedAt ? formatRelative(project.lastOpenedAt) : undefined
        }
        onClick={onOpen}
      />

      {hasActivity && (
        <div className="stats" style={{ padding: "10px 12px 0", marginBottom: 0 }}>
          <button className="stat accent" onClick={onOpenTasks}>
            <div className="sv">{stats?.active ?? 0}</div>
            <div className="sl">{t("tasks.segActive")}</div>
          </button>
          <button className="stat awaiting" onClick={onOpenTasks}>
            <div className="sv">{stats?.awaiting ?? 0}</div>
            <div className="sl">{t("tasks.segAwaiting")}</div>
          </button>
          <button className="stat" onClick={onOpenTasks}>
            <div className="sv">{stats?.done ?? 0}</div>
            <div className="sl">{t("tasks.segDone")}</div>
          </button>
        </div>
      )}

      <div style={{ padding: "10px 12px 12px" }}>
        <BlockButton variant="outline" onClick={onCompose}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              justifyContent: "center",
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t("home.newTask")}
          </span>
        </BlockButton>
      </div>
    </MobileCard>
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

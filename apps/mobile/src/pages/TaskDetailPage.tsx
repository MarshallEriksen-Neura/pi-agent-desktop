import { memo, useEffect, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "motion/react";
import {
  FileText,
  AlertCircle,
  MessageSquare,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { useTaskStore } from "@/stores/task-store";
import { useInteractionStore } from "@/stores/interaction-store";
import { StateView } from "@/components/primitives";
import {
  SectionLabel,
  MobileCard,
  MobileRow,
  BlockButton,
  DetailHeader,
} from "@/components/visual";
import {
  Timeline,
  TimelineNode,
  OutputStream,
  StreamBlock,
} from "@/components/task-visual";
import { NetError } from "@/net/errors";
import type { RemoteTaskSnapshot, RemoteTaskState } from "@pi/remote-control-contracts";
import { REMOTE_TASK_TERMINAL_STATES } from "@pi/remote-control-contracts";

/**
 * TaskDetailPage — single task view. Streams output from the task-store (fed
 * by the WSS event stream), shows the status timeline, context files, error
 * details, and a cancel action for non-terminal tasks.
 *
 * If the task is awaiting_input, a prominent banner links to the
 * InteractionsPage (design §6: awaiting_input must have a clear entry point).
 */
export const TaskDetailPage = memo(function TaskDetailPage() {
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const { isOnline } = useConnection();
  const client = useConnectionStore((s) => s.client);

  const tasks = useTaskStore((s) => s.tasks);
  const output = useTaskStore((s) => s.output);
  const fetchTask = useTaskStore((s) => s.fetchTask);
  const clearOutput = useTaskStore((s) => s.clearOutput);
  const interactions = useInteractionStore((s) => s.interactions);

  const [localSnapshot, setLocalSnapshot] = useState<RemoteTaskSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Prefer the store's task (live); fall back to a local fetch result.
  const storeTask = tasks.find((t) => t.taskId === taskId);
  const task = storeTask ?? localSnapshot;
  const pendingInteractions = Object.values(interactions).filter(
    (ix) => ix.taskId === taskId && ix.status === "pending",
  );

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const snap = await client.getTask(taskId);
      if (snap) setLocalSnapshot(snap);
    } catch (e) {
      setError(e instanceof NetError ? e.message : "fetch_failed");
    } finally {
      setLoading(false);
    }
  }, [client, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Also push into the store so the event stream can update it.
  useEffect(() => {
    void fetchTask(taskId);
  }, [fetchTask, taskId]);

  const handleCancel = useCallback(async () => {
    if (!client || !task) return;
    setCancelling(true);
    try {
      await client.cancelTask(taskId);
      void fetchTask(taskId);
    } catch {
      // The event stream will reconcile.
    } finally {
      setCancelling(false);
    }
  }, [client, task, taskId, fetchTask]);

  // Cleanup output when leaving the page.
  useEffect(() => {
    return () => clearOutput(taskId);
  }, [clearOutput, taskId]);

  if (!isOnline && !task) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.offline")}
        detail={t("error.offlineDetail")}
      />
    );
  }

  if (loading && !task) {
    return <TaskDetailSkeleton onBack={() => navigate(-1)} />;
  }

  if (error && !task) {
    return (
      <div className="page-scroll">
        <DetailHeader title={t("detail.pageTitle")} onBack={() => navigate(-1)} />
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
      </div>
    );
  }

  if (!task) return null;

  const isTerminal = REMOTE_TASK_TERMINAL_STATES.includes(task.state);
  const isAwaitingInput = task.state === "awaiting_input";
  const fragments = output[taskId] ?? [];

  return (
    <div className="page-scroll" style={{ paddingBottom: 80 }}>
      <DetailHeader title={t("detail.pageTitle")} onBack={() => navigate(-1)} />

      {/* Status banner */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <MobileCard style={{ marginBottom: 16 }}>
          <div className="status-banner">
            {stateIcon(task.state)}
            <span className="sb-label">{t(`tasks.state.${task.state}`)}</span>
          </div>
          <div className="detail-meta">
            <span>
              <b>{t("detail.taskId")}</b> {task.taskId.slice(0, 12)}
            </span>
          </div>
        </MobileCard>
      </motion.div>

      {/* Awaiting input banner */}
      {isAwaitingInput && pendingInteractions.length > 0 && (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          style={{ marginBottom: 16 }}
        >
          <MobileCard style={{ background: "var(--color-accent-muted)" }}>
            <MobileRow
              icon={<MessageSquare size={16} />}
              title={t("interaction.awaitingInput")}
              detail={t("interaction.pendingBannerDetail")}
              trailing={
                <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>
                  {t("interaction.respond")}
                </span>
              }
              onClick={() => navigate("/interactions")}
            />
          </MobileCard>
        </motion.div>
      )}

      {/* Timeline */}
      <SectionLabel>{t("detail.timeline")}</SectionLabel>
      <MobileCard style={{ marginBottom: 16 }}>
        <Timeline>
          <TimelineNode
            label={t("detail.stateCreated")}
            time={formatTime(task.createdAt)}
            dot="done"
          />
          <TimelineNode
            label={t("detail.stateStarted")}
            time={task.startedAt ? formatTime(task.startedAt) : undefined}
            dot={task.startedAt ? "done" : "live"}
          />
          <TimelineNode
            label={
              isTerminal ? t(`tasks.state.${task.state}`) : t("detail.stateRunning")
            }
            time={task.finishedAt ? formatTime(task.finishedAt) : undefined}
            dot={isTerminal ? "done" : isAwaitingInput ? "await" : "live"}
          />
        </Timeline>
      </MobileCard>

      {/* Context files */}
      {task.contextFiles.length > 0 && (
        <>
          <SectionLabel>{t("detail.contextFiles")}</SectionLabel>
          <MobileCard style={{ marginBottom: 16 }}>
            {task.contextFiles.map((f) => (
              <MobileRow
                key={f.relativePath}
                icon={<FileText size={16} />}
                title={f.relativePath.split("/").pop() ?? f.relativePath}
                detail={f.relativePath}
              />
            ))}
          </MobileCard>
        </>
      )}

      {/* Error details */}
      {task.error && (
        <>
          <SectionLabel>{t("detail.error")}</SectionLabel>
          <MobileCard style={{ marginBottom: 16, borderColor: "var(--color-danger)" }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--color-danger)",
                marginBottom: 4,
              }}
            >
              {task.error.code}
            </div>
            <div
              style={{
                fontSize: 14,
                color: "var(--color-text-secondary)",
                lineHeight: 1.4,
              }}
            >
              {task.error.message}
            </div>
            {task.error.retryable && (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--color-text-tertiary)",
                  marginTop: 8,
                }}
              >
                {t("detail.retryable")}
              </div>
            )}
          </MobileCard>
        </>
      )}

      {/* Output */}
      <SectionLabel>{t("detail.output")}</SectionLabel>
      {fragments.length === 0 ? (
        <MobileCard>
          <div className="hint">{t("detail.noOutput")}</div>
        </MobileCard>
      ) : (
        <OutputStream>
          {fragments.map((frag, i) => (
            <StreamBlock key={i} stream={frag.stream}>
              {frag.fragment}
            </StreamBlock>
          ))}
        </OutputStream>
      )}

      {/* Cancel bar */}
      {!isTerminal && (
        <div className="sticky-bar">
          <BlockButton variant="outline" onClick={handleCancel} disabled={cancelling}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "center",
              }}
            >
              <Ban size={16} />
              {cancelling ? t("common.loading") : t("detail.cancel")}
            </span>
          </BlockButton>
        </div>
      )}
    </div>
  );
});

// ----------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------

function TaskDetailSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="page-scroll">
      <DetailHeader title={t("detail.pageTitle")} onBack={onBack} />
      <Loader2 size={24} className="pi-spin" style={{ color: "var(--color-accent)" }} />
    </div>
  );
}

function stateIcon(state: RemoteTaskState): React.ReactNode {
  const common = { size: 20 };
  switch (state) {
    case "queued":
    case "starting":
      return <Clock {...common} style={{ color: "var(--color-text-secondary)" }} />;
    case "running":
      return (
        <Loader2 {...common} className="pi-spin" style={{ color: "var(--color-accent)" }} />
      );
    case "awaiting_input":
      return <MessageSquare {...common} style={{ color: "var(--color-warning)" }} />;
    case "succeeded":
      return <CheckCircle2 {...common} style={{ color: "var(--color-success)" }} />;
    case "failed":
      return <XCircle {...common} style={{ color: "var(--color-danger)" }} />;
    case "cancelled":
      return <XCircle {...common} style={{ color: "var(--color-text-tertiary)" }} />;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

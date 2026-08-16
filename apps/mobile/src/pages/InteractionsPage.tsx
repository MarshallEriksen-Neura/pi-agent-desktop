import { memo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence } from "motion/react";
import { MessageSquare, CheckCircle2, XCircle } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useInteractionStore } from "@/stores/interaction-store";
import {
  SectionLabel,
  MobileCard,
  BlockButton,
  EmptyState,
} from "@/components/visual";
import { AwaitingCard } from "@/components/awaiting-card";
import { DetailSkeleton } from "@/components/skeleton";
import { OfflineView } from "@/components/connection-trouble";
import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

/**
 * InteractionsPage — 交互请求中心。复刻设计稿「交互详情」。
 *
 * 待处理项复用 AwaitingCard(和任务中心同一个组件),历史项保留在本页。
 * 这一页与任务中心「待处理」段的分工:
 *  - 任务中心:只有 pending,是日常入口
 *  - 本页:pending + 已处理历史,是「我刚才回答了什么」的追溯入口
 *
 * 顶部提示条讲清过期语义 —— 交互请求带 expiresAt,过期后 Pi 会按默认方式继续,
 * 用户需要知道「不回答」也是一种结果。
 */
export const InteractionsPage = memo(function InteractionsPage() {
  const navigate = useNavigate();
  const { isOnline, stored, connect, wake } = useConnection();
  const loading = useInteractionStore((s) => s.loading);
  const order = useInteractionStore((s) => s.order);
  const interactions = useInteractionStore((s) => s.interactions);
  const refresh = useInteractionStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  if (loading && order.length === 0) {
    return (
      <div className="page-scroll">
        <h1 className="page-title">{t("interaction.title")}</h1>
        <DetailSkeleton />
      </div>
    );
  }

  const pending = order
    .map((id) => interactions[id])
    .filter((i): i is RemoteInteractionSnapshot => Boolean(i) && i.status === "pending");
  const history = order
    .map((id) => interactions[id])
    .filter(
      (i): i is RemoteInteractionSnapshot => Boolean(i) && i.status !== "pending",
    );

  if (order.length === 0) {
    return (
      <EmptyState icon={<MessageSquare size={28} />}>
        <div style={{ marginBottom: 4 }}>{t("interaction.empty")}</div>
        <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
          {t("interaction.emptyDetail")}
        </div>
      </EmptyState>
    );
  }

  return (
    <div className="page-scroll">
      <h1 className="page-title">{t("interaction.title")}</h1>

      {/* Pending — 就地可答 */}
      {pending.length > 0 && (
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
      )}

      {/* History — resolved/expired */}
      {history.length > 0 && (
        <>
          <SectionLabel>{t("interaction.history")}</SectionLabel>
          {history.map((ix) => (
            <HistoryCard
              key={ix.interactionId}
              interaction={ix}
              onOpenTask={() => navigate(`/tasks/${encodeURIComponent(ix.taskId)}`)}
            />
          ))}
        </>
      )}
    </div>
  );
});

// confirm / select / input 三种表单已统一由 AwaitingCard 承担 —— 任务中心和
// 本页用同一个组件,避免两处各自演化出不同的交互语义。

// ----------------------------------------------------------------
// History card — resolved/expired
// ----------------------------------------------------------------

/**
 * 已处理的交互。
 *
 * expired 与 resolved 用不同措辞:过期不是「没回答」,而是「Pi 已按默认继续」——
 * 用户需要知道那次沉默产生了后果,并能点进任务看它做了什么。
 */
const HistoryCard = memo(function HistoryCard({
  interaction,
  onOpenTask,
}: {
  interaction: RemoteInteractionSnapshot;
  onOpenTask: () => void;
}) {
  const isResolved = interaction.status === "resolved";
  const Icon = isResolved ? CheckCircle2 : XCircle;
  const color = isResolved ? "var(--color-success)" : "var(--color-status-degraded)";
  const label = isResolved ? t("interaction.resolved") : t("interaction.expired");

  return (
    <MobileCard style={{ marginBottom: 8, padding: 12, opacity: 0.78 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Icon size={16} style={{ color, flexShrink: 0 }} aria-hidden="true" />
        <span style={{ fontSize: 13, fontWeight: 600, color }}>{label}</span>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--color-text-tertiary)",
          }}
        >
          {interaction.taskId}
        </span>
      </div>
      <p
        style={{
          fontSize: 14,
          color: "var(--color-text-primary)",
          margin: "0 0 8px",
          lineHeight: 1.45,
        }}
      >
        {interaction.prompt}
      </p>

      {interaction.response ? (
        <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", margin: 0 }}>
          {t("interaction.response")}:{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {typeof interaction.response.value === "boolean"
              ? interaction.response.value
                ? t("interaction.yes")
                : t("interaction.no")
              : String(interaction.response.value)}
          </span>
        </p>
      ) : (
        // 过期项没有 response —— 说明后果是 Pi 自行决定的,给一条追溯出口。
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", margin: 0 }}>
            {t("state.interactionExpiredDetail")}
          </p>
          <BlockButton variant="outline" onClick={onOpenTask}>
            {t("state.viewTask")}
          </BlockButton>
        </div>
      )}
    </MobileCard>
  );
});

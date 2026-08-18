import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ChevronRight, MessageSquare } from "lucide-react";
import { t } from "@/i18n";
import { useInteractionStore } from "@/stores/interaction-store";
import { useExpiryCountdown } from "@/hooks/useExpiryCountdown";
import { MobileCard } from "@/components/visual";
import { Countdown } from "@/components/countdown";
import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

/**
 * AwaitingCard — 待处理交互的**状态卡**,不再是内嵌表单。
 *
 * 回答统一收进 InteractionSheet(底部弹层):卡片只回答「是什么、还剩多久、
 * 点哪去答」。这样任务中心与交互中心只是入口,回答的交互语义(长按批准、
 * 选项核对、多题切换)只有一份实现。
 */
export const AwaitingCard = memo(function AwaitingCard({
  interaction,
  /** 显示「查看完整任务」入口。任务中心里已有上下文,详情页里才需要。 */
  showTaskLink = true,
}: {
  interaction: RemoteInteractionSnapshot;
  showTaskLink?: boolean;
}) {
  const navigate = useNavigate();
  const openSheet = useInteractionStore((s) => s.openSheet);
  const remaining = useExpiryCountdown(interaction.expiresAt);
  const expired = remaining === 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      style={{ marginBottom: 10 }}
    >
      <MobileCard style={{ padding: 14, opacity: expired ? 0.55 : 1 }}>
        {/* 头部:任务归属 + 剩余时间。两者都是决策前要先看到的信息。 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--color-accent)",
              wordBreak: "break-all",
              minWidth: 0,
            }}
          >
            {interaction.taskId}
          </span>
          <Countdown expiresAt={interaction.expiresAt} />
        </div>

        {/* Pi 的提问 —— 卡片的视觉重心 */}
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--color-text-primary)",
            margin: "0 0 12px",
            wordBreak: "break-word",
          }}
        >
          {interaction.prompt}
        </p>

        {/* 回答入口 —— 弹出底部回答层 */}
        {!expired && (
          <button
            className="btn-block primary"
            onClick={() => openSheet(interaction.interactionId)}
            style={{ gap: 8 }}
          >
            <MessageSquare size={15} aria-hidden="true" />
            {t("interaction.respond")}
          </button>
        )}

        {showTaskLink && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              marginTop: 8,
            }}
          >
            <button
              onClick={() => navigate(`/tasks/${encodeURIComponent(interaction.taskId)}`)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                minHeight: "var(--tap-min)",
                padding: "0 2px",
                border: "none",
                background: "transparent",
                color: "var(--color-accent)",
                fontFamily: "var(--font-ui)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {t("interaction.viewFullTask")}
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>
        )}

        {expired && (
          <p
            style={{
              fontSize: 12,
              color: "var(--color-text-tertiary)",
              margin: "8px 0 0",
            }}
          >
            {t("state.interactionExpiredDetail")}
          </p>
        )}
      </MobileCard>
    </motion.div>
  );
});

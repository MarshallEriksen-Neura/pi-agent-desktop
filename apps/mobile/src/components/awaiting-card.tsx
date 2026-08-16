import { memo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ChevronRight, Send } from "lucide-react";
import { t } from "@/i18n";
import { useInteractionStore } from "@/stores/interaction-store";
import { useExpiryCountdown } from "@/hooks/useExpiryCountdown";
import { MobileCard } from "@/components/visual";
import { Countdown } from "@/components/countdown";
import { LongPressButton } from "@/components/confirm";
import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

/**
 * AwaitingCard — 一个待处理交互请求的可操作卡片。
 *
 * 复刻设计稿「任务中心 · 待处理」的三张卡片(select / confirm / input)。相对
 * 旧 InteractionsPage 的 CountdownRing 版本,这里的改动都是从「手机上远程决策」
 * 这个场景倒推的:
 *
 *  - 倒计时从圆环改成行内徽标,并在最后一分钟变红脉冲。圆环占掉卡片顶部一整行
 *    垂直空间,而列表里可能同时有三四张卡片;徽标能让更多卡片进入首屏。
 *  - confirm 的「批准」改成长按。这是 confirm 唯一的破坏性分支,而「拒绝」是
 *    安全默认 —— 两者不该是对称的两个按钮。
 *  - 选项按钮显示 value 的等宽体形态:select 的候选值往往是 URI、路径、分支名,
 *    用户要能逐字核对,不能只看 label。
 *  - 补「跳过,让 Pi 自行决定」出口。原来只有回答或等它过期两条路;主动跳过
 *    比让它静默过期更诚实。
 *
 * 卡片自身不做过期后的清理 —— interaction-store 收到 expired 事件会改 status,
 * 列表随之重算。这里只负责把「已过期」渲染成禁用态。
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
  const respond = useInteractionStore((s) => s.respond);
  const isResponding = useInteractionStore((s) =>
    s.responding.has(interaction.interactionId),
  );
  const remaining = useExpiryCountdown(interaction.expiresAt);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  const expired = remaining === 0;
  const locked = isResponding || expired;

  const answer = (value: boolean | string) => {
    void respond(interaction.interactionId, interaction.kind, value);
  };

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
          }}
        >
          {interaction.prompt}
        </p>

        {/* confirm:拒绝(安全默认)+ 长按批准。不做成对称双按钮。 */}
        {interaction.kind === "confirm" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button
              className="btn-block outline"
              onClick={() => answer(false)}
              disabled={locked}
            >
              {t("interaction.reject")}
            </button>
            <LongPressButton onConfirm={() => answer(true)} disabled={locked}>
              {t("confirm.longPress")}
            </LongPressButton>
          </div>
        )}

        {/* select:候选值整行按钮,等宽体显示 value 供逐字核对。 */}
        {interaction.kind === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(interaction.options ?? []).map((opt) => (
              <button
                key={opt.value}
                className="opt"
                onClick={() => answer(opt.value)}
                disabled={locked}
                style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}
              >
                <span style={{ fontSize: 15 }}>{opt.label}</span>
                {/* label 与 value 不同时才显示 value,避免重复渲染同一个字符串 */}
                {opt.value !== opt.label && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--color-text-tertiary)",
                      wordBreak: "break-all",
                    }}
                  >
                    {opt.value}
                  </span>
                )}
              </button>
            ))}

            {!showCustom ? (
              <button
                className="btn-block outline"
                onClick={() => setShowCustom(true)}
                disabled={locked}
              >
                {t("interaction.otherValue")}
              </button>
            ) : (
              <CustomValueField
                value={custom}
                onChange={setCustom}
                disabled={locked}
                onSubmit={() => custom.trim() && answer(custom.trim())}
              />
            )}
          </div>
        )}

        {/* input:单行输入 + 发送。占位符说明这个值不会写进仓库。 */}
        {interaction.kind === "input" && (
          <CustomValueField
            value={custom}
            onChange={setCustom}
            disabled={locked}
            onSubmit={() => custom.trim() && answer(custom.trim())}
          />
        )}

        {/* 主动跳过 —— 比让它静默过期更诚实 */}
        {!expired && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 10,
            }}
          >
            <button
              onClick={() => answer(interaction.kind === "confirm" ? false : "")}
              disabled={locked}
              style={{
                minHeight: "var(--tap-min)",
                padding: "0 2px",
                border: "none",
                background: "transparent",
                color: "var(--color-text-tertiary)",
                fontFamily: "var(--font-ui)",
                fontSize: 12,
                textAlign: "left",
                cursor: locked ? "default" : "pointer",
              }}
            >
              {t("interaction.skip")}
            </button>

            {showTaskLink && (
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
                  flexShrink: 0,
                }}
              >
                {t("interaction.viewFullTask")}
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            )}
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

/** 自定义值输入 —— 只有下边框的极简样式,聚焦时下边框加粗。 */
function CustomValueField({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSubmit();
        }}
        disabled={disabled}
        placeholder={t("interaction.inputPlaceholder")}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: "var(--tap-min)",
          padding: "0 2px",
          border: "none",
          borderBottom: "1px solid var(--color-separator-strong)",
          background: "transparent",
          color: "var(--color-text-primary)",
          // 16px 以下 iOS Safari 会在聚焦时自动放大页面
          fontSize: 16,
          fontFamily: "var(--font-ui)",
          outline: "none",
        }}
      />
      <button
        onClick={onSubmit}
        disabled={disabled || !value.trim()}
        aria-label={t("interaction.submit")}
        style={{
          display: "grid",
          placeItems: "center",
          width: "var(--tap-min)",
          height: "var(--tap-min)",
          flexShrink: 0,
          border: "none",
          borderRadius: "var(--radius-sm)",
          background: value.trim() ? "var(--color-accent)" : "var(--material-regular)",
          color: value.trim() ? "#fff" : "var(--color-text-tertiary)",
          cursor: disabled || !value.trim() ? "default" : "pointer",
        }}
      >
        <Send size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

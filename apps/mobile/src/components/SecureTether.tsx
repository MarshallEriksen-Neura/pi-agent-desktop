import { memo } from "react";
import { motion } from "motion/react";
import type { ConnectionPhase } from "@/stores/connection.store";
import { t } from "@/i18n";

/**
 * SecureTether — 产品标志视觉:桌面端点 — 流光链路 — 锁节点 — 手机端点。
 *
 * 产品含义:链路即 TLS 证书锁定隧道,锁节点即 Certificate Pin。状态随
 * WSS 连接与身份 epoch 实时变化——它不是装饰,而是「手机与桌面之间安全
 * 连接」的可读状态(设计 §7)。
 *
 * 四态(由 data-state 驱动,见 components.css):
 *  - online:         链路流光 + 绿锁
 *  - reconnecting:   虚线脉冲 + accent 锁
 *  - offline:        断口 + 去饱和
 *  - identity_failed:断口 + 红锁抖动
 *
 * reduced-motion 下流光/脉冲/抖动退化为静态颜色,断口语义保留。
 */

/** demo 四态;ConnectionPhase 其余值映射到最接近的视觉态 */
type TetherVisualState = "online" | "reconnecting" | "offline" | "identity_failed";

const PHASE_TO_VISUAL: Record<ConnectionPhase, TetherVisualState> = {
  online: "online",
  reconnecting: "reconnecting",
  waking: "reconnecting",
  pairing: "reconnecting",
  offline: "offline",
  idle: "offline",
  identity_failed: "identity_failed",
};

const STATE_META: Record<
  TetherVisualState,
  { labelKey: string; color: string }
> = {
  online: { labelKey: "connection.online", color: "var(--color-status-online)" },
  reconnecting: {
    labelKey: "connection.reconnecting",
    color: "var(--color-status-reconnecting)",
  },
  offline: { labelKey: "connection.offline", color: "var(--color-status-offline)" },
  identity_failed: {
    labelKey: "connection.identityFailed",
    color: "var(--color-danger)",
  },
};

/**
 * SVG 图形:桌面显示器 — 链路 — 锁节点 — 手机(对齐 demo tetherSVG)。
 * 纯静态结构,所有状态变化由 .tether[data-state] CSS 驱动。
 */
const TetherSvg = memo(function TetherSvg() {
  return (
    <svg width="180" height="64" viewBox="0 0 180 64" aria-hidden="true">
      {/* desktop glyph */}
      <rect className="desktop-glyph" x="6" y="10" width="56" height="40" rx="6" />
      <line className="desktop-glyph" x1="24" y1="54" x2="44" y2="54" />
      {/* link (TLS-pinned tunnel) */}
      <path className="link" d="M64 30 Q90 8 116 30" />
      {/* lock node at midpoint — Certificate Pin */}
      <g transform="translate(83,8)">
        <rect className="lock" x="0" y="6" width="14" height="11" rx="2.5" />
        <path className="lock" d="M3 6 V4 a4 4 0 0 1 8 0 V6" />
      </g>
      {/* phone glyph */}
      <rect className="phone-glyph" x="124" y="8" width="34" height="50" rx="8" />
      <line className="phone-glyph" x1="135" y1="14" x2="147" y2="14" />
    </svg>
  );
});

/** Hero 变体 — Home 页全宽标志视觉 + 状态文案。 */
export const SecureTetherHero = memo(function SecureTetherHero({
  phase,
}: {
  phase: ConnectionPhase;
}) {
  const visual = PHASE_TO_VISUAL[phase];
  const meta = STATE_META[visual];
  return (
    <motion.div
      initial={{ scale: 0.92, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 280, damping: 24 }}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        padding: "20px 0 8px",
      }}
    >
      <div
        className="tether"
        data-state={visual}
        role="img"
        aria-label={t(meta.labelKey)}
      >
        <TetherSvg />
      </div>
      <span style={{ fontSize: 17, fontWeight: 600, color: meta.color }}>
        {t(meta.labelKey)}
      </span>
    </motion.div>
  );
});

/** Badge 变体 — ConnectionBar / Settings 小号标志 + 状态文案。 */
export const SecureTetherBadge = memo(function SecureTetherBadge({
  phase,
  showLabel = true,
}: {
  phase: ConnectionPhase;
  showLabel?: boolean;
}) {
  const visual = PHASE_TO_VISUAL[phase];
  const meta = STATE_META[visual];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        className="tether badge"
        data-state={visual}
        role="img"
        aria-label={t(meta.labelKey)}
      >
        <TetherSvg />
      </span>
      {showLabel && (
        <span style={{ fontSize: 12, fontWeight: 600, color: meta.color }}>
          {t(meta.labelKey)}
        </span>
      )}
    </span>
  );
});

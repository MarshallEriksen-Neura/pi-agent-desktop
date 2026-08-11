import { memo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronRight } from "lucide-react";

/**
 * 通用视觉原子 — 用语义化 CSS 类(components.css)封装,对齐高保真 demo。
 * 这些是页面级组合的积木,与 primitives.tsx 的功能型组件(StateView /
 * FullScreenSpinner)互补。页面改造时优先用本文件 + task-visual.tsx。
 */

/** Section 小标题(msec > h4,11px 大写)。 */
export const SectionLabel = memo(function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="msec">
      <h4>{children}</h4>
    </div>
  );
});

/** 分组卡片(mcard,带 1px 边框 + shadow-sm)。 */
export const MobileCard = memo(function MobileCard({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`mcard${className ? ` ${className}` : ""}`} style={style}>
      {children}
    </div>
  );
});

/**
 * iOS 风格行(mrow + mic + mt + md + trail)。
 * 传入 onClick 时渲染为 button(可点),否则为 div。可点击且未传 trailing
 * 时自动追加 chev。
 */
export const MobileRow = memo(function MobileRow({
  icon,
  iconBg = "var(--color-accent)",
  title,
  detail,
  trailing,
  onClick,
  danger,
}: {
  icon?: React.ReactNode;
  iconBg?: string;
  title: string;
  detail?: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  const Comp = onClick ? motion.button : motion.div;
  return (
    <Comp
      whileTap={onClick ? { scale: 0.99 } : undefined}
      onClick={onClick}
      className="mrow"
      style={danger ? { color: "var(--color-danger)" } : undefined}
    >
      {icon && (
        <span
          className="mic"
          style={{ background: danger ? "var(--color-danger)" : iconBg }}
        >
          {icon}
        </span>
      )}
      <div className="mb">
        <div className="mt">{title}</div>
        {detail && <div className="md">{detail}</div>}
      </div>
      {trailing ?? (onClick && !danger ? <ChevronRight size={16} className="chev" /> : null)}
    </Comp>
  );
});

/** 全宽块按钮(btn-block,primary/outline/danger/success 四变体)。 */
export const BlockButton = memo(function BlockButton({
  children,
  onClick,
  disabled,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "outline" | "danger" | "success";
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      disabled={disabled}
      className={`btn-block ${variant}`}
    >
      {children}
    </motion.button>
  );
});

/** 空状态(empty + ei 图标)。 */
export const EmptyState = memo(function EmptyState({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="ei">{icon}</div>}
      {children}
    </div>
  );
});

/** 详情页头(detail-head:返回 + 标题 + 可选操作)。 */
export const DetailHeader = memo(function DetailHeader({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="detail-head">
      <button className="back" onClick={onBack} aria-label="返回">
        ‹
      </button>
      <span className="dh">{title}</span>
      {action}
    </div>
  );
});

/** 详情元信息行(detail-meta:等宽 mono 键值)。 */
export const DetailMeta = memo(function DetailMeta({
  items,
}: {
  items: { label: string; value: string }[];
}) {
  return (
    <div className="detail-meta">
      {items.map((it) => (
        <span key={it.label}>
          <b>{it.label}</b> {it.value}
        </span>
      ))}
    </div>
  );
});

/**
 * 确认弹窗(modal-backdrop + modal-card)。
 * 复用 CloseConfirmDialog 的 motion + backdrop blur 模式,保持视觉一致性。
 * dismissible=false 时点击背景不关闭(用于不可逆操作的二次确认)。
 */
export const ConfirmModal = memo(function ConfirmModal({
  open,
  title,
  detail,
  confirmLabel,
  cancelLabel,
  variant = "danger",
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
  variant?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => !busy && onCancel()}
          className="modal-backdrop"
        >
          <motion.div
            initial={{ scale: 0.94, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 6 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className="modal-card"
          >
            <h2>{title}</h2>
            <p>{detail}</p>
            <div className="btns2">
              <BlockButton variant="outline" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </BlockButton>
              <BlockButton variant={variant} onClick={onConfirm} disabled={busy}>
                {busy ? "…" : confirmLabel}
              </BlockButton>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

import { memo, useRef, useEffect } from "react";
import { motion } from "motion/react";
import type { RemoteTaskState } from "@pi/remote-control-contracts";

/**
 * 任务/交互专用视觉组件 — 对齐高保真 demo 的任务流视觉:
 * TaskCard / CapabilityRow / Timeline / OutputStream / CountdownRing /
 * ScanFrame / Sheet / OptionRow。
 */

/** 任务状态 → 状态点类(tdot.*)。 */
const TASK_DOT_CLASS: Record<RemoteTaskState, string> = {
  queued: "tdot queued",
  starting: "tdot queued",
  running: "tdot running",
  awaiting_input: "tdot awaiting",
  succeeded: "tdot succeeded",
  failed: "tdot failed",
  cancelled: "tdot failed",
};

/** 任务状态点(running 态自动 pulse)。 */
export const TaskDot = memo(function TaskDot({ state }: { state: RemoteTaskState }) {
  return <span className={TASK_DOT_CLASS[state] ?? "tdot queued"} />;
});

/** 能力摘要键值行(cap-row)。 */
export const CapabilityRow = memo(function CapabilityRow({
  k,
  v,
}: {
  k: string;
  v: string;
}) {
  return (
    <div className="cap-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
});

/**
 * 任务卡(taskcard)。awaiting=true 时加 awaiting 边框 + 光晕;
 * badge 传入则显示倒计时徽章(如 "剩 00:42")。
 */
export const TaskCard = memo(function TaskCard({
  title,
  meta,
  state,
  awaiting,
  badge,
  onClick,
}: {
  title: string;
  meta?: string;
  state: RemoteTaskState;
  awaiting?: boolean;
  badge?: string;
  onClick?: () => void;
}) {
  return (
    <motion.div
      whileTap={onClick ? { scale: 0.99 } : undefined}
      onClick={onClick}
      className={`taskcard${awaiting ? " awaiting" : ""}`}
    >
      <div className="th">
        <TaskDot state={state} />
        <span className="tt">{title}</span>
        {badge && <span className="badge-await">{badge}</span>}
      </div>
      {meta && <div className="tmeta">{meta}</div>}
    </motion.div>
  );
});

/** 扫码取景框(scanframe + scanline + 可选 target 文案)。 */
export const ScanFrame = memo(function ScanFrame({
  target,
}: {
  target?: string;
}) {
  return (
    <div className="scanframe">
      <div className="scanline" />
      {target && <div className="scan-target">{target}</div>}
    </div>
  );
});

/**
 * 倒计时圆环(cd-ring)。remaining/total 比例驱动 stroke-dashoffset;
 * 中央显示 mm:ss。用于交互等待倒计时。
 */
export const CountdownRing = memo(function CountdownRing({
  remaining,
  total,
}: {
  remaining: number;
  total: number;
}) {
  // 64px ring (see .cd-ring): a lighter presence than the original 74px.
  const r = 27;
  const circ = 2 * Math.PI * r;
  const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const offset = circ * (1 - ratio);
  const mm = Math.floor(remaining / 60)
    .toString()
    .padStart(2, "0");
  const ss = (remaining % 60).toString().padStart(2, "0");
  return (
    <div className="cd-ring">
      <svg width="64" height="64" viewBox="0 0 64 64">
        {/* Track uses the sunken surface rather than a hairline stroke — less
            visual weight at this smaller size. */}
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="var(--color-bg-sunken)"
          strokeWidth="5"
        />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="var(--color-status-awaiting)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="val">
        {mm}:{ss}
      </div>
    </div>
  );
});

/** 底部 sheet(sheet + grip + 可选标题/副标题)。 */
export const Sheet = memo(function Sheet({
  children,
  title,
  sub,
}: {
  children: React.ReactNode;
  title?: string;
  sub?: string;
}) {
  return (
    <div className="sheet" role="dialog" aria-modal="true">
      <div className="grip" />
      {title && <h3>{title}</h3>}
      {sub && <p className="ssub">{sub}</p>}
      {children}
    </div>
  );
});

/** 单选项行(opt + radio,selected 时高亮 + 实心圆)。 */
export const OptionRow = memo(function OptionRow({
  label,
  selected,
  onClick,
  disabled,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      disabled={disabled}
      className={`opt${selected ? " sel" : ""}`}
    >
      <span className="radio" />
      <span className="ol">{label}</span>
    </motion.button>
  );
});

/** 等宽 prompt 框(prompt-box,展示 Pi 的操作请求文本)。 */
export const PromptBox = memo(function PromptBox({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="prompt-box">{children}</div>;
});

/** 时间线节点(tl-node + tl-dot + tl-c)。dot: done/live/await。 */
export const TimelineNode = memo(function TimelineNode({
  label,
  time,
  dot = "done",
}: {
  label: string;
  time?: string;
  dot?: "done" | "live" | "await";
}) {
  return (
    <div className="tl-node">
      <span className={`tl-dot ${dot}`} />
      <div className="tl-c">
        <div className="tl-t">{label}</div>
        {time && <div className="tl-x">{time}</div>}
      </div>
    </div>
  );
});

/** 时间线容器。 */
export const Timeline = memo(function Timeline({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="timeline">{children}</div>;
});

/** 输出流块(blk + tag,stdout/stderr/tool 三色)。 */
export const StreamBlock = memo(function StreamBlock({
  stream,
  children,
}: {
  stream: "stdout" | "stderr" | "tool";
  children: React.ReactNode;
}) {
  return (
    <div className={`blk ${stream}`}>
      <div className="tag">{stream}</div>
      {children}
    </div>
  );
});

/** 输出流容器(stream,自动滚动到底)。 */
export const OutputStream = memo(function OutputStream({
  children,
}: {
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [children]);
  return (
    <div className="stream" ref={ref}>
      {children}
    </div>
  );
});

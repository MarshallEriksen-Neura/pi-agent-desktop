"use client";

/**
 * ActivityLine — the compact, one-line-per-action idiom used for everything the
 * agent is doing: an icon on the left, the action's text on the right, no card,
 * no border. New lines mount as work starts, so a turn reads as a list growing
 * downward rather than one big loading panel.
 *
 * `PiSpark` is the small activity mark that carries the "still working" signal
 * (iOS-style 8-spoke indicator, CSS-animated so it costs nothing at 13px).
 */

import { motion } from "motion/react";
import {
  Bot,
  FilePenLine,
  FileText,
  Globe,
  ListChecks,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { toolKind, type ToolKind } from "@/lib/pi/tool-label";
import type { TaskStatus } from "@/lib/store";

const KIND_ICON: Record<ToolKind, typeof Wrench> = {
  read: FileText,
  write: FilePenLine,
  bash: Terminal,
  search: Search,
  web: Globe,
  task: ListChecks,
  agent: Bot,
  other: Wrench,
};

const SPOKES = 8;

/** Small activity mark — 8 spokes fading in sequence around a circle. */
export function PiSpark({
  size = 13,
  color = "var(--agent-thinking)",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      style={{ display: "block", flexShrink: 0 }}
    >
      {Array.from({ length: SPOKES }).map((_, i) => (
        <line
          key={i}
          x1={12}
          y1={4.5}
          x2={12}
          y2={9}
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          transform={`rotate(${(i * 360) / SPOKES} 12 12)`}
          className="pi-spark-spoke"
          style={{ animationDelay: `${(-i / SPOKES) * 0.8}s` }}
        />
      ))}
    </svg>
  );
}

/** Text that shimmers while the agent has nothing visible to show yet. */
export function ShimmerText({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span className="pi-shimmer" style={style}>
      {children}
    </span>
  );
}

const ICON_COLOR: Record<TaskStatus, string> = {
  running: "var(--agent-thinking)",
  done: "var(--text-tertiary)",
  queued: "var(--text-tertiary)",
  error: "var(--danger)",
};

export function ActivityLine({
  status,
  title,
  detail,
  toolName,
  delay = 0,
  animateIn = true,
}: {
  status: TaskStatus;
  title: string;
  /** dimmed trailing text — args, a result summary, anything secondary */
  detail?: string;
  /** picks the icon; omit for a generic action row */
  toolName?: string;
  /** stagger, in seconds, when several rows appear at once */
  delay?: number;
  animateIn?: boolean;
}) {
  const Icon = KIND_ICON[toolName ? toolKind(toolName) : "other"];
  const running = status === "running";

  return (
    <motion.div
      initial={animateIn ? { opacity: 0, y: -3 } : false}
      animate={{ opacity: status === "queued" ? 0.5 : 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 32, delay }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "3px 2px",
        minWidth: 0,
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <span
        className={running ? "pi-icon-breathe" : undefined}
        style={{
          display: "flex",
          flexShrink: 0,
          color: ICON_COLOR[status],
        }}
      >
        <Icon size={13} strokeWidth={2} />
      </span>
      <span
        style={{
          color: status === "error" ? "var(--danger)" : "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      {detail && (
        <span
          style={{
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {detail}
        </span>
      )}
    </motion.div>
  );
}

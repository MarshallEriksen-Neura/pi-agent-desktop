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

import type { ReactNode } from "react";
import { motion } from "motion/react";
import {
  Bot,
  FilePenLine,
  FileText,
  Globe,
  ListChecks,
  PlugZap,
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
  mcp: PlugZap,
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
  onClick,
  active = false,
  trailing,
  ariaLabel,
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
  /**
   * Makes the row itself the control — used by tool calls that own an inspector.
   * Renders as a real button so the row stays keyboard-reachable.
   */
  onClick?: () => void;
  /** this row's inspector is the one currently open — ties the two together */
  active?: boolean;
  /** pinned to the right edge: elapsed time, a chevron, a count */
  trailing?: ReactNode;
  ariaLabel?: string;
}) {
  const Icon = KIND_ICON[toolName ? toolKind(toolName) : "other"];
  const running = status === "running";
  const interactive = onClick !== undefined;

  return (
    <motion.div
      {...(interactive
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-pressed": active,
            "aria-label": ariaLabel ?? title,
            onClick,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            },
            whileHover: { x: 1 },
            whileTap: { scale: 0.995 },
          }
        : {})}
      initial={animateIn ? { opacity: 0, y: -3 } : false}
      animate={{ opacity: status === "queued" ? 0.5 : 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 32, delay }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 1.45,
        // an inactive clickable row keeps the plain row's geometry, so a
        // transcript of tool calls does not turn into a column of boxes
        padding: interactive ? "3px 6px 3px 5px" : "3px 2px",
        ...(interactive
          ? {
              cursor: "pointer",
              borderRadius: "var(--radius-sm)",
              borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
              background: active
                ? "color-mix(in srgb, var(--accent) 9%, transparent)"
                : "transparent",
              transition: "background var(--duration-fast) ease, border-color var(--duration-fast) ease",
            }
          : {}),
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
          minWidth: 0,
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
      {trailing !== undefined && (
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 5,
            flexShrink: 0,
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
          }}
        >
          {trailing}
        </span>
      )}
    </motion.div>
  );
}

"use client";

import { motion } from "motion/react";
import clsx from "clsx";
import { Kbd as AppicaKbd } from "@appica/ui-react/kbd";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@appica/ui-react/tooltip";

/** Keyboard shortcut chip — Appica Kbd skinned with our tokens. */
export function Kbd({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <AppicaKbd
      style={{
        fontSize: 10.5,
        fontFamily: "var(--font-mono)",
        color: "var(--text-tertiary)",
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: 6,
        padding: "1px 6px",
        ...style,
      }}
    >
      {children}
    </AppicaKbd>
  );
}

/**
 * iOS-style circular icon button with spring press feedback.
 * The label renders as an Appica Tooltip (was a native title attr).
 */
export function IconButton({
  children,
  label,
  onClick,
  active = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <motion.button
            aria-label={label}
            onClick={onClick}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            style={{
              display: "grid",
              placeItems: "center",
              width: 30,
              height: 30,
              fontSize: 15,
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              color: active ? "var(--accent)" : "var(--text-secondary)",
              background: active ? "var(--accent-muted)" : "transparent",
              transition: "background var(--duration-fast) var(--spring-smooth)",
            }}
          >
            {children}
          </motion.button>
        }
      />
      <TooltipContent
        className="material-thin"
        style={{
          fontSize: 11.5,
          color: "var(--text-primary)",
          border: "1px solid var(--separator)",
          borderRadius: 8,
          padding: "4px 10px",
          boxShadow: "var(--shadow-md)",
        }}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Section label used in sidebar / panels (iOS grouped-list header). */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--text-tertiary)",
        padding: "14px 16px 6px",
      }}
    >
      {children}
    </div>
  );
}

/** Generic list row with selection + hover states. */
export function Row({
  children,
  selected = false,
  onClick,
  icon,
}: {
  children: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx("pi-row", selected && "pi-row--selected")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "calc(100% - 12px)",
        margin: "1px 6px",
        padding: "7px 10px",
        fontSize: 13,
        textAlign: "left",
        border: "none",
        borderRadius: 8,
        cursor: "pointer",
        color: selected ? "var(--text-primary)" : "var(--text-secondary)",
        background: selected ? "var(--accent-muted)" : "transparent",
        transition: "background var(--duration-fast) var(--spring-smooth)",
      }}
    >
      {icon && (
        <span style={{ opacity: 0.7, fontSize: 14, width: 16 }}>{icon}</span>
      )}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </span>
    </button>
  );
}

/**
 * Shimmer placeholder for data-gated regions. Uses appica's
 * `skeleton-shimmer` utility for the moving highlight, so it respects
 * `prefers-reduced-motion` and the disable-animations flag automatically.
 * Pass width/height/radius to shape it; defaults fit a GroupRow content line.
 */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = 7,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className="skeleton-shimmer"
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
        background: "var(--material-regular)",
        ...style,
      }}
    />
  );
}

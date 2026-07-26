"use client";

import { motion } from "motion/react";

/** Pill action button for the status screens (404 / runtime error). */
export function PillButton({
  children,
  onClick,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "quiet";
}) {
  const primary = variant === "primary";
  return (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.96 }}
      transition={{ type: "spring", stiffness: 500, damping: 24 }}
      style={{
        padding: "8px 18px",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "var(--font-ui)",
        borderRadius: 999,
        cursor: "pointer",
        border: primary ? "none" : "1px solid var(--separator)",
        color: primary ? "var(--text-on-accent)" : "var(--text-primary)",
        background: primary ? "var(--accent)" : "var(--bg-elevated)",
      }}
    >
      {children}
    </motion.button>
  );
}

/**
 * Shared frame for app state pages (404 / runtime error).
 * Signature: the state renders as a terminal transcript — Pi's own CLI
 * reporting what happened — instead of a decorative status numeral.
 * The transcript lines stay untranslated on purpose: they are code idiom,
 * like real terminal output inside the product.
 */
export function StatusScreen({
  code,
  tone = "neutral",
  command,
  result,
  detail,
  title,
  body,
  children,
}: {
  /** Short mono status token, e.g. "404" or "ERR". */
  code: string;
  /** neutral → warning orange; danger → red (matches iOS semantics). */
  tone?: "neutral" | "danger";
  /** The mono prompt line, e.g. "open /models/". */
  command: string;
  /** The mono outcome, e.g. "route not found". */
  result: string;
  /** Optional third mono line (error message, digest). */
  detail?: string;
  title: string;
  body: string;
  /** Action buttons row. */
  children?: React.ReactNode;
}) {
  const toneColor = tone === "danger" ? "var(--danger)" : "var(--warning)";
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          maxWidth: 420,
          width: "100%",
        }}
      >
        {/* terminal transcript — the signature element */}
        <div
          style={{
            width: "100%",
            padding: "14px 18px",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            lineHeight: 1.9,
            background: "var(--bg-elevated)",
            border: "1px solid var(--separator)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-sm)",
            overflowWrap: "break-word",
          }}
        >
          <div style={{ color: "var(--text-secondary)" }}>
            <span style={{ color: "var(--accent)" }}>pi ❯ </span>
            {command}
          </div>
          <div style={{ color: toneColor }}>
            ✗ {code} · {result}
            <span className="pi-caret" aria-hidden />
          </div>
          {detail && (
            <div style={{ color: "var(--text-tertiary)", fontSize: 11.5 }}>
              {detail}
            </div>
          )}
        </div>

        <h1
          style={{
            margin: "22px 0 0",
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            color: "var(--text-primary)",
          }}
        >
          {title}
        </h1>
        <p
          style={{
            margin: "8px 0 0",
            fontSize: 13,
            lineHeight: 1.55,
            textAlign: "center",
            color: "var(--text-secondary)",
            maxWidth: 360,
          }}
        >
          {body}
        </p>

        {children && (
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            {children}
          </div>
        )}
      </motion.div>
    </div>
  );
}

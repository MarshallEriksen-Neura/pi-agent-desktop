"use client";

/**
 * The one status line for every package mutation on the page.
 *
 * Both halves reported outcomes before the merge, in two different shapes: the
 * plugins page used a bordered banner with a state icon, the store page used a
 * bare line of coloured text. This is the former, hoisted into the shell, so an
 * install reads the same whichever half you started it from.
 *
 * It deliberately does *not* offer a restart. Every mutation here sets
 * `dirtyRestart`, which raises the global RestartPiToast — that toast owns the
 * restart button, and repeating the instruction here would be advice with no
 * affordance attached to it.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CircleCheck, CircleX } from "lucide-react";

export function StatusBanner({
  status,
}: {
  status: { ok: boolean; text: string } | null;
}) {
  const reduce = useReducedMotion();
  const tint = status?.ok ? "var(--success)" : "var(--danger)";
  return (
    <AnimatePresence initial={false}>
      {status && (
        <motion.div
          role={status.ok ? "status" : "alert"}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 16,
            padding: "10px 14px",
            fontSize: 12.5,
            lineHeight: 1.5,
            borderRadius: "var(--radius-md)",
            border: `1px solid color-mix(in srgb, ${tint} 35%, transparent)`,
            background: `color-mix(in srgb, ${tint} 8%, transparent)`,
            color: "var(--text-primary)",
          }}
        >
          {status.ok ? (
            <CircleCheck size={15} aria-hidden style={{ flexShrink: 0, color: tint }} />
          ) : (
            <CircleX size={15} aria-hidden style={{ flexShrink: 0, color: tint }} />
          )}
          <span style={{ flex: 1, minWidth: 0 }}>{status.text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

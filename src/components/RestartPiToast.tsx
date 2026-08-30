"use client";

import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { RotateCcw } from "lucide-react";
import { usePiSettings } from "@/lib/pi/settings";
import { useMcp } from "@/lib/pi/mcp";
import { useT } from "@/lib/i18n";

/**
 * Global "restart pi to apply changes" banner — the single restart entry
 * point for any settings change that pi only reads at startup (settings.json,
 * packages, MCP config, models.json, skills). Driven by usePiSettings
 * .dirtyRestart (useMcp keeps its own flag for its page-local state; both are
 * cleared here after a successful restart). Mounted in AppShell, below
 * CliUpdateToast so the two never overlap.
 */
export function RestartPiToast() {
  const s = usePiSettings();
  const mcpDirty = useMcp((state) => state.dirtyRestart);
  const t = useT();
  const reduce = useReducedMotion();

  const restart = async () => {
    await usePiSettings.getState().restartPi();
    // the settings restart clears usePiSettings.dirtyRestart; mirror it for
    // the mcp store's own flag so one click dismisses both
    if (!usePiSettings.getState().lastError) {
      useMcp.setState({ dirtyRestart: false, lastError: null });
    }
  };

  return (
    <AnimatePresence>
      {(s.dirtyRestart || mcpDirty) && (
        <div
          style={{
            position: "fixed",
            top: 64,
            left: 0,
            right: 0,
            zIndex: 9997,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -16 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              gap: 12,
              maxWidth: 560,
              padding: "10px 14px",
              background: "var(--material-regular)",
              border: "1px solid var(--separator)",
              borderRadius: 14,
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.14)",
              fontSize: 13,
              color: "var(--text-primary)",
            }}
            data-testid="restart-pi-toast"
            role="status"
          >
            <motion.span
              animate={s.busy ? (reduce ? undefined : { rotate: -360 }) : undefined}
              transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              style={{ display: "flex", flexShrink: 0, color: "var(--warning)" }}
            >
              <RotateCcw size={18} />
            </motion.span>

            <div style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
              <span style={{ fontWeight: 600 }}>{t("restart.pendingTitle")}</span>{" "}
              <span style={{ color: "var(--text-secondary)" }}>
                {t("restart.pendingDetail")}
              </span>
            </div>

            <button
              type="button"
              onClick={() => void restart()}
              disabled={s.busy}
              style={{
                flexShrink: 0,
                border: "none",
                borderRadius: 8,
                padding: "5px 12px",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: s.busy ? "wait" : "pointer",
                background: "var(--accent)",
                color: "#fff",
              }}
            >
              {s.busy ? t("settings.restarting") : t("settings.restartPi")}
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

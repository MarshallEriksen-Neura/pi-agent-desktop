"use client";

import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { RotateCcw } from "lucide-react";
import { usePiSettings } from "@/lib/pi/settings";
import { useMcp } from "@/lib/pi/mcp";
import { usePi } from "@/lib/pi/store";
import { useSessions } from "@/lib/pi/sessions";
import { usePiManagement } from "@/lib/pi/management";
import { getActiveTaskId } from "@/lib/pi/task-context";
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
  const pi = usePi();
  const binding = useSessions((state) => state.executionBinding);
  const activeId = useSessions((state) => state.activeId) ?? getActiveTaskId();
  const managementDirty = usePiManagement((state) => Boolean(state.dirtyTasks[activeId]));
  const clearTaskDirty = usePiManagement((state) => state.clearTaskDirty);
  const mcpDirty = useMcp((state) => state.dirtyRestart);
  const t = useT();
  const reduce = useReducedMotion();
  const [remoteBusyTask, setRemoteBusyTask] = useState<string | null>(null);
  const busy = binding.kind === "ssh" ? remoteBusyTask === activeId : s.busy;
  const visible = binding.kind === "ssh" ? managementDirty : s.dirtyRestart || mcpDirty || managementDirty;

  const restart = async () => {
    if (binding.kind === "ssh") {
      setRemoteBusyTask(activeId);
      try {
        await pi.restart(binding.remoteCwd, undefined, binding);
        clearTaskDirty(activeId);
      } finally {
        setRemoteBusyTask((taskId) => taskId === activeId ? null : taskId);
      }
      return;
    }
    await usePiSettings.getState().restartPi();
    // the settings restart clears usePiSettings.dirtyRestart; mirror it for
    // the mcp store's own flag so one click dismisses both
    if (!usePiSettings.getState().lastError) {
      useMcp.setState({ dirtyRestart: false, lastError: null });
      clearTaskDirty(activeId);
    }
  };

  return (
    <AnimatePresence>
      {visible && (
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
              animate={busy ? (reduce ? undefined : { rotate: -360 }) : undefined}
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
              disabled={busy}
              style={{
                flexShrink: 0,
                border: "none",
                borderRadius: 8,
                padding: "5px 12px",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
                background: "var(--accent)",
                color: "#fff",
              }}
            >
              {busy ? t("settings.restarting") : t("settings.restartPi")}
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

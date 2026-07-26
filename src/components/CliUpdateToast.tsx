"use client";

import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useCliUpdate } from "@/lib/pi/cli-update";
import { usePi } from "@/lib/pi/store";
import { useWorkspace } from "@/lib/workspace";
import { useT } from "@/lib/i18n";

/**
 * Launch reminder for pi CLI updates — a top-center banner that appears when
 * the startup check (AppShell) finds a newer pi than the installed one.
 * Actions: update in place (`pi update` via the store), dismiss for this
 * session, or skip this version permanently. After a successful update the
 * banner offers a pi restart so the new binary actually serves the session.
 */
export function CliUpdateToast() {
  const u = useCliUpdate();
  const t = useT();
  const reduce = useReducedMotion();

  const restartPi = () => {
    u.later();
    void usePi
      .getState()
      .restart(useWorkspace.getState().root ?? undefined);
  };

  const btn: React.CSSProperties = {
    border: "none",
    borderRadius: 8,
    padding: "5px 12px",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    background: "transparent",
    color: "var(--text-secondary)",
  };

  return (
    <AnimatePresence>
      {u.promptVisible && (
        <div
          style={{
            position: "fixed",
            top: 16,
            left: 0,
            right: 0,
            zIndex: 9998,
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
          data-testid="cli-update-toast"
        >
          {u.phase === "updating" ? (
            <motion.span
              animate={reduce ? undefined : { rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              style={{ display: "flex", flexShrink: 0, color: "var(--accent)" }}
            >
              <RefreshCw size={18} />
            </motion.span>
          ) : (
            <ArrowUpCircle
              size={18}
              style={{ flexShrink: 0, color: "var(--accent)" }}
            />
          )}

          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
            {u.phase === "updating" ? (
              t("cliUpdate.updating")
            ) : u.phase === "updated" ? (
              t("cliUpdate.updated")
            ) : u.phase === "error" ? (
              <span style={{ color: "var(--danger, #E5484D)" }}>
                {t("cliUpdate.updateFailed", { reason: u.error ?? "?" })}
              </span>
            ) : (
              <>
                <span style={{ fontWeight: 600 }}>{t("cliUpdate.title")}</span>{" "}
                <span style={{ color: "var(--text-secondary)" }}>
                  {t("cliUpdate.message", {
                    latest: u.info?.latest ?? "?",
                    installed: u.info?.installed ?? "?",
                  })}
                </span>
              </>
            )}
          </div>

          {u.phase === "available" && (
            <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
              <button style={btn} onClick={() => u.skip()}>
                {t("cliUpdate.skip")}
              </button>
              <button style={btn} onClick={() => u.later()}>
                {t("cliUpdate.later")}
              </button>
              <button
                style={{ ...btn, background: "var(--accent)", color: "#fff" }}
                onClick={() => void u.apply()}
              >
                {t("cliUpdate.updateNow")}
              </button>
            </div>
          )}

          {u.phase === "updated" && (
            <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
              <button style={btn} onClick={() => u.later()}>
                {t("cliUpdate.later")}
              </button>
              <button
                style={{ ...btn, background: "var(--accent)", color: "#fff" }}
                onClick={restartPi}
              >
                {t("cliUpdate.restartPi")}
              </button>
            </div>
          )}

          {u.phase === "error" && (
            <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
              <button style={btn} onClick={() => u.later()}>
                {t("cliUpdate.later")}
              </button>
              <button
                style={{ ...btn, background: "var(--accent)", color: "#fff" }}
                onClick={() => void u.apply()}
              >
                {t("cliUpdate.retry")}
              </button>
            </div>
          )}
        </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

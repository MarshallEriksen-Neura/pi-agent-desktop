"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useCliUpdate, cliUpdateTargetStamp } from "@/lib/pi/cli-update";
import { usePi } from "@/lib/pi/store";
import { useSessions } from "@/lib/pi/sessions";
import { useT } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

/** Target-aware pi CLI update reminder in the original top-center banner. */
export function CliUpdateToast() {
  const u = useCliUpdate();
  const binding = useSessions((state) => state.executionBinding);
  const t = useT();
  const reduce = useReducedMotion();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const visible = u.phase === "available" || u.phase === "updating" || u.phase === "updated" || u.phase === "error";
  const remote = binding.kind === "ssh";
  const bindingStamp = cliUpdateTargetStamp(binding);
  const sameTarget = u.targetStamp === bindingStamp;
  const targetHost = u.targetHost ?? (binding.kind === "ssh" ? binding.hostAlias : "");

  useEffect(() => setConfirmOpen(false), [bindingStamp]);

  const startApply = () => {
    void u.apply(binding).catch(() => undefined);
  };

  const requestApply = () => {
    if (remote) setConfirmOpen(true);
    else startApply();
  };

  const confirmApply = () => {
    setConfirmOpen(false);
    startApply();
  };

  const restart = async () => {
    if (!sameTarget) return;
    try {
      await usePi.getState().restart();
      u.dismiss(binding);
    } catch {
      // Keep the banner available so the restart can be retried.
    }
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
    <>
      <AnimatePresence>
        {visible && sameTarget && (
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
              role="status"
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
                  u.targetDetached ? t("cliUpdate.detachedUpdated") : t("cliUpdate.updated")
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
                {remote && u.targetHost && (
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    {t("cliUpdate.remoteTarget", { host: u.targetHost })}
                  </div>
                )}
              </div>

              {u.phase === "available" && (
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  <button type="button" style={btn} onClick={() => u.skip(binding)}>
                    {t("cliUpdate.skip")}
                  </button>
                  <button type="button" style={btn} onClick={() => u.dismiss(binding)}>
                    {t("cliUpdate.later")}
                  </button>
                  <button
                    type="button"
                    style={{ ...btn, background: "var(--accent)", color: "#fff" }}
                    onClick={requestApply}
                  >
                    {t("cliUpdate.updateNow")}
                  </button>
                </div>
              )}

              {u.phase === "updated" && (
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  <button type="button" style={btn} onClick={() => u.dismiss(binding)}>
                    {t("cliUpdate.later")}
                  </button>
                  {u.phase === "updated" && !u.targetDetached && (
                    <button
                      type="button"
                      style={{ ...btn, background: "var(--accent)", color: "#fff" }}
                      onClick={() => void restart()}
                    >
                      {t("cliUpdate.restartPi")}
                    </button>
                  )}
                </div>
              )}

              {u.phase === "error" && (
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  <button type="button" style={btn} onClick={() => u.dismiss(binding)}>
                    {t("cliUpdate.later")}
                  </button>
                  <button
                    type="button"
                    style={{ ...btn, background: "var(--accent)", color: "#fff" }}
                    onClick={() => void u.check(binding)}
                  >
                    {t("cliUpdate.retry")}
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirmOpen && remote && sameTarget}
        title={t("cliUpdate.confirmRemoteTitle")}
        message={t("cliUpdate.confirmRemoteMessage", { host: targetHost })}
        detail={t("cliUpdate.versionLine", { current: u.info?.installed ?? "?", latest: u.info?.latest ?? "?" })}
        confirmLabel={t("cliUpdate.updateNow")}
        danger={false}
        confirmDisabled={u.phase === "updating" || !sameTarget}
        onConfirm={confirmApply}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Download, X, RotateCcw, Terminal } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { useCliUpdate, cliUpdateTargetStamp } from "@/lib/pi/cli-update";
import { usePi } from "@/lib/pi/store";
import { useSessions } from "@/lib/pi/sessions";
import { useT } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

/** Non-blocking bottom-right toast for pi CLI updates. */
export function CliUpdateToast() {
  const u = useCliUpdate();
  const binding = useSessions((state) => state.executionBinding);
  const t = useT();
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
      // The Pi store keeps the restart error visible; leave this toast available to retry.
    }
  };

  return (
    <>
      <AnimatePresence>
        {visible && sameTarget && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            style={{
              position: "fixed", right: 20, bottom: 20, zIndex: 9000,
              width: 340, padding: 16, borderRadius: 14,
              background: "var(--card)", border: "1px solid var(--border)",
              boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
            }}
          >
            <button onClick={() => u.dismiss(binding)} aria-label={t("common.close")} style={{
              position: "absolute", top: 10, right: 10, border: 0, background: "transparent",
              color: "var(--muted-foreground)", cursor: "pointer", padding: 4,
            }}><X size={15} /></button>

            <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "color-mix(in srgb, var(--accent) 14%, transparent)", color: "var(--accent)" }}>
                {u.phase === "updated" ? <RotateCcw size={17} /> : <Terminal size={17} />}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 3 }}>
                  {u.phase === "error"
                    ? t("cliUpdate.failed")
                    : u.phase === "updated"
                      ? t("cliUpdate.updated")
                      : t("cliUpdate.available")}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.45 }}>
                  {u.phase === "error"
                    ? u.error ?? t("cliUpdate.failed")
                    : u.phase === "updated"
                      ? u.targetDetached
                        ? t("cliUpdate.detachedUpdated")
                        : t("cliUpdate.restartHint")
                      : t("cliUpdate.versionLine", {
                          current: u.info?.installed ?? "?",
                          latest: u.info?.latest ?? "?",
                        })}
                </div>
                {remote && u.targetHost && (
                  <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 4 }}>
                    {t("cliUpdate.remoteTarget", { host: u.targetHost })}
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 13, justifyContent: "flex-end" }}>
              {u.phase === "available" && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => u.skip(binding)} style={{ fontSize: 12 }}>
                    {t("cliUpdate.skip")}
                  </Button>
                  <Button variant="primary" size="sm" onClick={requestApply} style={{ fontSize: 12, gap: 5 }}>
                    <Download size={13} /> {t("cliUpdate.updateNow")}
                  </Button>
                </>
              )}
              {u.phase === "updating" && (
                <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                  {t("cliUpdate.updating")}
                </span>
              )}
              {u.phase === "updated" && !u.targetDetached && (
                <Button variant="primary" size="sm" onClick={() => void restart()} style={{ fontSize: 12, gap: 5 }}>
                  <RotateCcw size={13} /> {t("cliUpdate.restartPi")}
                </Button>
              )}
              {u.phase === "error" && (
                <Button variant="ghost" size="sm" onClick={() => void u.check(binding)} style={{ fontSize: 12 }}>
                  {t("cliUpdate.retry")}
                </Button>
              )}
            </div>
          </motion.div>
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

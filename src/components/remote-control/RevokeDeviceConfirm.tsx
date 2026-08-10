"use client";

import { memo, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Trash2, Loader2 } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { useT } from "@/lib/i18n";
import type { PairingDeviceMetadata } from "@pi/remote-control-contracts";

/**
 * Confirm-before-revoke dialog (design §D-4). Revoke is destructive but
 * recoverable — the device can re-pair — so this uses a standard two-button
 * confirm rather than typed confirmation. The busy state is owned by the
 * caller via {@link onConfirm} returning a promise; the dialog stays open
 * until the promise settles so the spinner is visible.
 */
export const RevokeDeviceConfirm = memo(function RevokeDeviceConfirm({
  device,
  onConfirm,
  onCancel,
}: {
  device: PairingDeviceMetadata | null;
  onConfirm: (deviceId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const open = device !== null;
  const [busy, setBusy] = useState(false);

  // Reset busy if the dialog is dismissed mid-flight by the parent.
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  // Esc-to-cancel (disabled while in flight).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  const confirm = async () => {
    if (!device || busy) return;
    setBusy(true);
    try {
      await onConfirm(device.deviceId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && device && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => !busy && onCancel()}
          style={OVERLAY}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.remoteControl.revoke.title")}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            style={CARD}
          >
            {/* danger icon */}
            <div style={ICON_CIRCLE}>
              <Trash2 size={22} color="var(--danger)" />
            </div>

            <h2 style={TITLE}>{t("settings.remoteControl.revoke.title")}</h2>
            <p style={MESSAGE}>
              {t("settings.remoteControl.revoke.message", { name: device.displayName })}
            </p>

            {/* device summary */}
            <div style={DEVICE_SUMMARY}>
              <span style={DEVICE_NAME}>{device.displayName}</span>
              <span style={DEVICE_META}>
                {t(`settings.remoteControl.platform.${device.platform}`)}
                {device.appVersion ? ` · v${device.appVersion}` : ""}
              </span>
            </div>

            <div style={ACTIONS}>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" onClick={confirm} disabled={busy} style={DANGER_BTN}>
                {busy ? <Loader2 size={14} className="pi-spin" /> : t("settings.remoteControl.revoke.confirm")}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,0.45)",
  backdropFilter: "blur(2px)",
};

const CARD: React.CSSProperties = {
  width: 360,
  maxWidth: "calc(100vw - 32px)",
  background: "var(--bg-base)",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--separator)",
  boxShadow: "var(--shadow-lg)",
  padding: "22px 22px 18px",
  textAlign: "center",
};

const ICON_CIRCLE: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 48,
  height: 48,
  borderRadius: "50%",
  background: "color-mix(in srgb, var(--danger) 14%, transparent)",
  margin: "0 auto 12px",
};

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 650,
  color: "var(--text-primary)",
};

const MESSAGE: React.CSSProperties = {
  margin: "8px 0 14px",
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "var(--text-secondary)",
};

const DEVICE_SUMMARY: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "10px 12px",
  borderRadius: 10,
  background: "var(--bg-sunken)",
  border: "1px solid var(--separator)",
  marginBottom: 16,
};

const DEVICE_NAME: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--text-primary)",
};

const DEVICE_META: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-tertiary)",
};

const ACTIONS: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "center",
};

const DANGER_BTN: React.CSSProperties = {
  background: "var(--danger)",
  borderRadius: 8,
};

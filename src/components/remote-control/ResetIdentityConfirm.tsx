"use client";

import { memo, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ShieldAlert, Loader2 } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { useT } from "@/lib/i18n";

/**
 * Identity-reset confirmation (design §D-6). This is the single most
 * destructive remote-control action: it invalidates every paired device,
 * rotates the desktop identity and certificate, and forces re-pairing. To
 * prevent muscle-memory clicks, the confirm button stays disabled until the
 * user types the localized confirm phrase verbatim (design §11 — typed
 * confirmation for irreversible actions).
 *
 * The dialog is controlled by the parent: `open` + `onClose` + `onConfirm`
 * (which returns a promise so the spinner is visible until the backend
 * settles). Local input state resets whenever the dialog closes.
 */
export const ResetIdentityConfirm = memo(function ResetIdentityConfirm({
  open,
  onConfirm,
  onClose,
}: {
  open: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  // The phrase the user must type verbatim. Localized so zh users type "重置".
  const phrase = t("settings.remoteControl.reset.confirmPhrase");
  const matches = typed.trim() === phrase;

  // Reset local state whenever the dialog is dismissed.
  useEffect(() => {
    if (!open) {
      setTyped("");
      setBusy(false);
    }
  }, [open]);

  // Esc-to-close (disabled while in flight).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const confirm = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => !busy && onClose()}
          style={OVERLAY}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.remoteControl.reset.title")}
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
              <ShieldAlert size={24} color="var(--danger)" />
            </div>

            <h2 style={TITLE}>{t("settings.remoteControl.reset.title")}</h2>
            <p style={WARNING}>{t("settings.remoteControl.reset.warning")}</p>

            {/* typed-confirmation input */}
            <label style={LABEL}>
              <span style={LABEL_TEXT}>{t("settings.remoteControl.reset.typeHint", { phrase })}</span>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matches) void confirm();
                }}
                autoFocus
                disabled={busy}
                placeholder={phrase}
                aria-label={t("settings.remoteControl.reset.typeHint", { phrase })}
                style={{
                  ...INPUT,
                  borderColor: typed && matches ? "var(--success)" : "var(--separator)",
                }}
              />
            </label>

            <div style={ACTIONS}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={confirm}
                disabled={!matches || busy}
                style={{ ...DANGER_BTN, opacity: matches && !busy ? 1 : 0.5 }}
              >
                {busy ? <Loader2 size={14} className="pi-spin" /> : t("settings.remoteControl.reset.confirm")}
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
  background: "rgba(0,0,0,0.5)",
  backdropFilter: "blur(3px)",
};

const CARD: React.CSSProperties = {
  width: 400,
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
  width: 52,
  height: 52,
  borderRadius: "50%",
  background: "color-mix(in srgb, var(--danger) 16%, transparent)",
  margin: "0 auto 12px",
};

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 650,
  color: "var(--text-primary)",
};

const WARNING: React.CSSProperties = {
  margin: "10px 0 16px",
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "var(--text-secondary)",
  textAlign: "left",
};

const LABEL: React.CSSProperties = {
  display: "block",
  textAlign: "left",
  marginBottom: 16,
};

const LABEL_TEXT: React.CSSProperties = {
  display: "block",
  fontSize: 12.5,
  color: "var(--text-tertiary)",
  marginBottom: 6,
};

const INPUT: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  fontSize: 14,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--text-primary)",
  background: "var(--bg-sunken)",
  border: "1px solid var(--separator)",
  borderRadius: 8,
  outline: "none",
  boxSizing: "border-box",
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

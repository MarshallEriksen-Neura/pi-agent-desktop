"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { useT } from "@/lib/i18n";

/**
 * Generic two-button confirmation dialog.
 *
 * Replaces the native `dialog.confirm` for in-app destructive actions: the OS
 * dialog can't be themed, blocks the whole window, and depends on a Tauri
 * capability being granted (a missing `dialog:allow-confirm` is exactly how
 * this surfaced as a bug). The visual language matches the hand-rolled
 * confirms it generalizes — {@link CloseConfirmDialog} and
 * `RevokeDeviceConfirm` — so those can migrate onto it later.
 *
 * `onConfirm` may return a promise; the dialog stays open with a spinner until
 * it settles, so slow work is visible and double-submits are impossible.
 */
export const ConfirmDialog = memo(function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel,
  danger = true,
  icon,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** Body copy. Omit when the title alone is unambiguous. */
  message?: string;
  /** Secondary line, e.g. the exact identifier being deleted. */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. Defaults to true. */
  danger?: boolean;
  icon?: React.ReactNode;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  /**
   * Latest callbacks, read at fire time. The keydown listener must not close
   * over the render that installed it: callers routinely pass inline arrows
   * that capture state (which row is being deleted), and a stale capture would
   * confirm the wrong target.
   */
  const latest = useRef({ onConfirm, onCancel });
  latest.current = { onConfirm, onCancel };

  // Clear in-flight state if the parent closes the dialog from underneath us.
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await latest.current.onConfirm();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Esc cancels; Enter confirms. Both inert while work is in flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") latest.current.onCancel();
      if (e.key === "Enter") void run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, run]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => !busy && onCancel()}
          style={OVERLAY}
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            style={CARD}
          >
            <div style={iconCircle(danger)}>
              {icon ?? (
                <AlertTriangle
                  size={22}
                  color={danger ? "var(--danger)" : "var(--accent)"}
                />
              )}
            </div>

            <h2 style={TITLE}>{title}</h2>
            {message && <p style={MESSAGE}>{message}</p>}
            {detail && <div style={DETAIL}>{detail}</div>}

            <div style={ACTIONS}>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {cancelLabel ?? t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={run}
                disabled={busy}
                style={danger ? DANGER_BTN : undefined}
              >
                {busy ? (
                  <Loader2 size={14} className="pi-spin" />
                ) : (
                  confirmLabel ?? t("common.confirm")
                )}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

/* ------------------------------------------------------------------ */
/* Styles — mirrors CloseConfirmDialog / RevokeDeviceConfirm           */
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

const iconCircle = (danger: boolean): React.CSSProperties => ({
  display: "grid",
  placeItems: "center",
  width: 48,
  height: 48,
  borderRadius: "50%",
  background: `color-mix(in srgb, ${
    danger ? "var(--danger)" : "var(--accent)"
  } 14%, transparent)`,
  margin: "0 auto 12px",
});

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 650,
  color: "var(--text-primary)",
};

const MESSAGE: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "var(--text-secondary)",
};

const DETAIL: React.CSSProperties = {
  margin: "12px 0 0",
  padding: "10px 12px",
  borderRadius: 10,
  background: "var(--bg-sunken)",
  border: "1px solid var(--separator)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-primary)",
  wordBreak: "break-all",
};

const ACTIONS: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "center",
  marginTop: 18,
};

const DANGER_BTN: React.CSSProperties = {
  background: "var(--danger)",
  borderRadius: 8,
};

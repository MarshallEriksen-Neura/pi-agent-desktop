"use client";

import { memo, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { X, RefreshCw, Check, TriangleAlert, Loader2 } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { useT } from "@/lib/i18n";
import { usePairingQr } from "@/lib/remote-control/hooks";
import { useRemoteControl } from "@/lib/remote-control/store";
import { serializeQrPayload } from "@/lib/remote-control/qr-serialize";

/**
 * Pairing-QR modal (design §M2). Renders the one-time pairing ticket as a
 * scannable QR and polls `status` for a successful pairing (see
 * {@link usePairingQr}). Five visual states are derived from `qrState`:
 * generating / ready / expired / paired / failed.
 *
 * The modal is controlled: the parent owns `open` and `onClose`. On open it
 * triggers `generateQr` if no live ticket exists; on close it stops the
 * success-poll. The `paired` state auto-dismisses after 1.6s so the user sees
 * the success affordance without an extra click.
 */
export const PairingQrModal = memo(function PairingQrModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { payload, state, countdown, regenerate, polling } = usePairingQr();
  const generateQr = useRemoteControl((s) => s.generateQr);

  // Trigger generation when the modal opens without a live ticket.
  useEffect(() => {
    if (open && !payload && state === "idle") {
      void generateQr();
    }
  }, [open, payload, state, generateQr]);

  // Esc-to-close + auto-dismiss on paired success.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state !== "generating") onClose();
    };
    window.addEventListener("keydown", onKey);
    let dismiss: ReturnType<typeof setTimeout> | undefined;
    if (state === "paired") {
      dismiss = setTimeout(onClose, 1600);
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      if (dismiss) clearTimeout(dismiss);
    };
  }, [open, state, onClose]);

  const qrString = payload ? serializeQrPayload(payload) : "";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => state !== "generating" && onClose()}
          style={OVERLAY}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.remoteControl.qrModal.title")}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            style={CARD}
          >
            {/* header */}
            <div style={HEADER}>
              <h2 style={TITLE}>{t("settings.remoteControl.qrModal.title")}</h2>
              <button
                aria-label={t("common.close")}
                onClick={onClose}
                disabled={state === "generating"}
                style={CLOSE_BTN}
              >
                <X size={16} />
              </button>
            </div>
            <p style={SUBTITLE}>{t("settings.remoteControl.qrModal.subtitle")}</p>

            {/* state-driven body */}
            <QrBody
              state={state}
              qrString={qrString}
              countdown={countdown}
              polling={polling}
              onRegenerate={() => void regenerate()}
            />

            {/* security hint footer */}
            <p style={HINT}>{t("settings.remoteControl.qrModal.securityHint")}</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

/* ------------------------------------------------------------------ */
/* State-driven body                                                  */
/* ------------------------------------------------------------------ */

const QrBody = memo(function QrBody({
  state,
  qrString,
  countdown,
  polling,
  onRegenerate,
}: {
  state: ReturnType<typeof usePairingQr>["state"];
  qrString: string;
  countdown: number;
  polling: boolean;
  onRegenerate: () => void;
}) {
  const t = useT();

  // generating — spinner, no QR yet
  if (state === "generating" || state === "idle") {
    return (
      <Center>
        <Loader2 size={28} className="pi-spin" style={{ color: "var(--accent)" }} />
        <StateLabel>{t("settings.remoteControl.qrModal.generating")}</StateLabel>
      </Center>
    );
  }

  // paired — success check, auto-dismisses
  if (state === "paired") {
    return (
      <Center>
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 360, damping: 20 }}
          style={SUCCESS_CIRCLE}
        >
          <Check size={36} color="#fff" strokeWidth={3} />
        </motion.div>
        <StateLabel style={{ color: "var(--success)", fontWeight: 650 }}>
          {t("settings.remoteControl.qrModal.paired")}
        </StateLabel>
        <SubLabel>{t("settings.remoteControl.qrModal.pairedDetail")}</SubLabel>
      </Center>
    );
  }

  // failed — error + retry
  if (state === "failed") {
    return (
      <Center>
        <div style={FAIL_CIRCLE}>
          <TriangleAlert size={28} color="var(--danger)" />
        </div>
        <StateLabel>{t("settings.remoteControl.qrModal.failed")}</StateLabel>
        <Button variant="outline" size="sm" onClick={onRegenerate} style={ACTION_BTN}>
          <RefreshCw size={13} style={{ marginRight: 6 }} />
          {t("settings.remoteControl.qrModal.retry")}
        </Button>
      </Center>
    );
  }

  // expired — dimmed QR + regenerate
  if (state === "expired") {
    return (
      <Center>
        <QrFrame dimmed>
          <QrMatrix qrString={qrString} />
        </QrFrame>
        <StateLabel style={{ color: "var(--danger)" }}>
          {t("settings.remoteControl.qrModal.expired")}
        </StateLabel>
        <SubLabel>{t("settings.remoteControl.qrModal.expiredDetail")}</SubLabel>
        <Button variant="primary" size="sm" onClick={onRegenerate} style={ACTION_BTN}>
          <RefreshCw size={13} style={{ marginRight: 6 }} />
          {t("settings.remoteControl.qrModal.regenerate")}
        </Button>
      </Center>
    );
  }

  // ready — live QR + countdown + waiting hint
  return (
    <Center>
      <QrFrame>
        <QrMatrix qrString={qrString} />
        {/* countdown ring overlay */}
        <span style={COUNTDOWN_PILL}>{t("settings.remoteControl.qrModal.countdown", { s: countdown })}</span>
      </QrFrame>
      <StateLabel>{t("settings.remoteControl.qrModal.scanInstruction")}</StateLabel>
      <SubLabel>
        {polling
          ? t("settings.remoteControl.qrModal.waiting")
          : t("settings.remoteControl.qrModal.subtitle")}
      </SubLabel>
    </Center>
  );
});

/* ------------------------------------------------------------------ */
/* QR matrix — isolated so it can be memoized on the string            */
/* ------------------------------------------------------------------ */

const QrMatrix = memo(function QrMatrix({ qrString }: { qrString: string }) {
  return (
    <QRCodeSVG
      value={qrString || " "}
      size={196}
      level="M"
      marginSize={0}
      bgColor="transparent"
      fgColor="var(--text-primary)"
      // The QR is the Secure Tether visual mark — render it large and crisp.
      style={{ display: "block" }}
    />
  );
});

/* ------------------------------------------------------------------ */
/* Layout primitives                                                   */
/* ------------------------------------------------------------------ */

const QrFrame = memo(function QrFrame({
  dimmed = false,
  children,
}: {
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ position: "relative", opacity: dimmed ? 0.35 : 1 }}>
      <div
        style={{
          width: 224,
          height: 224,
          display: "grid",
          placeItems: "center",
          background: "var(--bg-sunken)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--separator)",
          padding: 14,
        }}
      >
        {children}
      </div>
    </div>
  );
});

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        padding: "18px 0 14px",
        minHeight: 260,
        justifyContent: "center",
      }}
    >
      {children}
    </div>
  );
}

function StateLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)", ...style }}>
      {children}
    </span>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 12.5,
        color: "var(--text-tertiary)",
        textAlign: "center",
        maxWidth: 280,
        lineHeight: 1.45,
      }}
    >
      {children}
    </span>
  );
}

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
  width: 380,
  maxWidth: "calc(100vw - 32px)",
  background: "var(--bg-base)",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--separator)",
  boxShadow: "var(--shadow-lg)",
  padding: "20px 22px 18px",
};

const HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 650,
  color: "var(--text-primary)",
};

const SUBTITLE: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12.5,
  color: "var(--text-secondary)",
  lineHeight: 1.45,
};

const CLOSE_BTN: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 28,
  height: 28,
  border: "none",
  borderRadius: 7,
  background: "transparent",
  color: "var(--text-tertiary)",
  cursor: "pointer",
  flexShrink: 0,
};

const HINT: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 11.5,
  color: "var(--text-tertiary)",
  lineHeight: 1.5,
  textAlign: "center",
  borderTop: "1px solid var(--separator)",
  paddingTop: 10,
};

const ACTION_BTN: React.CSSProperties = {
  borderRadius: 8,
  marginTop: 4,
};

const SUCCESS_CIRCLE: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 64,
  height: 64,
  borderRadius: "50%",
  background: "var(--success)",
};

const FAIL_CIRCLE: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 64,
  height: 64,
  borderRadius: "50%",
  background: "color-mix(in srgb, var(--danger) 16%, transparent)",
};

const COUNTDOWN_PILL: React.CSSProperties = {
  position: "absolute",
  top: -8,
  right: -8,
  fontSize: 11,
  fontWeight: 600,
  padding: "3px 8px",
  borderRadius: 999,
  background: "var(--accent)",
  color: "#fff",
  boxShadow: "var(--shadow-sm)",
};

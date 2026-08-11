import { memo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  QrCode,
  Check,
  Clock,
  AlertTriangle,
  WifiOff,
  ShieldAlert,
  RefreshCw,
  ChevronLeft,
  Camera,
  Settings,
} from "lucide-react";
import type { PairingQrPayload } from "@pi/remote-control-contracts";
import { t } from "@/i18n";
import { usePairing, type PairingState } from "@/hooks/usePairing";
import { useQrScanner, type ScannerPhase } from "@/hooks/useQrScanner";
import { shouldEnablePairingScanner } from "@/security/pairing-flow";
import { parseAndValidateQr } from "@/security/qr-validate";
import { PrimaryButton, SecondaryButton } from "@/components/primitives";

/**
 * PairingPage (P-2) — the 8-state pairing flow with a real camera QR scanner.
 *
 * States:
 *  idle → scanning → validating → connecting → success
 *                                ↓
 *             expired | unsupported | unreachable | pinMismatch | rateLimited | failed
 *
 * QR capture:
 *  - **Native (Android)**: `useQrScanner` drives the ML Kit camera scanner.
 *    Camera permission is requested on mount; the scanner stops on first
 *    valid result and releases the camera on unmount / background.
 *  - **Browser (dev preview only)**: a manual JSON entry field is shown so
 *    the flow can be exercised end-to-end. This is gated behind
 *    `import.meta.env.DEV` — production builds never expose it.
 */

// ----------------------------------------------------------------
// Dev-mode flag — production builds must hide manual QR entry.
// ----------------------------------------------------------------
const isDev = Boolean(import.meta.env?.DEV);

// ----------------------------------------------------------------
// State → visual config
// ----------------------------------------------------------------

const STATE_CONFIG: Record<
  PairingState,
  { icon: React.ReactNode; color: string; titleKey: string; detailKey: string }
> = {
  idle: {
    icon: <QrCode size={28} />,
    color: "var(--color-accent)",
    titleKey: "pairing.idle",
    detailKey: "pairing.scanning",
  },
  scanning: {
    icon: <QrCode size={28} />,
    color: "var(--color-accent)",
    titleKey: "pairing.scanning",
    detailKey: "pairing.scanning",
  },
  validating: {
    icon: <RefreshCw size={28} />,
    color: "var(--color-accent)",
    titleKey: "pairing.validating",
    detailKey: "pairing.validating",
  },
  connecting: {
    icon: <ShieldAlert size={28} />,
    color: "var(--color-accent)",
    titleKey: "pairing.connecting",
    detailKey: "pairing.connecting",
  },
  success: {
    icon: <Check size={28} />,
    color: "var(--color-success)",
    titleKey: "pairing.success",
    detailKey: "pairing.successDetail",
  },
  expired: {
    icon: <Clock size={28} />,
    color: "var(--color-warning)",
    titleKey: "pairing.expired",
    detailKey: "pairing.expiredDetail",
  },
  unsupported: {
    icon: <AlertTriangle size={28} />,
    color: "var(--color-warning)",
    titleKey: "pairing.unsupported",
    detailKey: "pairing.unsupportedDetail",
  },
  unreachable: {
    icon: <WifiOff size={28} />,
    color: "var(--color-danger)",
    titleKey: "pairing.unreachable",
    detailKey: "pairing.unreachableDetail",
  },
  pinMismatch: {
    icon: <ShieldAlert size={28} />,
    color: "var(--color-danger)",
    titleKey: "pairing.pinMismatch",
    detailKey: "pairing.pinMismatchDetail",
  },
  rateLimited: {
    icon: <Clock size={28} />,
    color: "var(--color-warning)",
    titleKey: "pairing.rateLimited",
    detailKey: "pairing.rateLimitedDetail",
  },
  failed: {
    icon: <AlertTriangle size={28} />,
    color: "var(--color-danger)",
    titleKey: "pairing.failed",
    detailKey: "pairing.failedDetail",
  },
};

const TRANSITIONAL: PairingState[] = ["scanning", "validating", "connecting"];

/** Map scanner permission phases to visual config (reuses pairing colors). */
const SCANNER_PHASE_CONFIG: Record<
  ScannerPhase,
  { icon: React.ReactNode; color: string; titleKey: string; detailKey: string } | null
> = {
  idle: null,
  requesting_permission: {
    icon: <Camera size={28} />,
    color: "var(--color-accent)",
    titleKey: "scanner.requestingPermission",
    detailKey: "scanner.requestingPermission",
  },
  scanning: {
    icon: <QrCode size={28} />,
    color: "var(--color-accent)",
    titleKey: "pairing.scanning",
    detailKey: "pairing.scanning",
  },
  denied: {
    icon: <Camera size={28} />,
    color: "var(--color-warning)",
    titleKey: "scanner.denied",
    detailKey: "scanner.deniedDetail",
  },
  permanently_denied: {
    icon: <Camera size={28} />,
    color: "var(--color-danger)",
    titleKey: "scanner.permanentlyDenied",
    detailKey: "scanner.permanentlyDeniedDetail",
  },
  unsupported: {
    icon: <AlertTriangle size={28} />,
    color: "var(--color-warning)",
    titleKey: "scanner.unsupported",
    detailKey: "scanner.unsupportedDetail",
  },
};

export const PairingPage = memo(function PairingPage() {
  const navigate = useNavigate();
  const { state, errorDetail, pair, reset, setState } = usePairing();
  const [manualJson, setManualJson] = useState("");

  // Never auto-restart the camera over an error screen. A failed pairing must
  // remain readable until the user explicitly taps "Scan again", which resets
  // the flow to `idle` and re-enables the scanner.
  const scannerEnabled = shouldEnablePairingScanner(state);

  const handleQrResult = useCallback(
    (raw: string) => {
      // Parse + validate the QR envelope. A non-Pi QR or expired ticket
      // routes to the right pairing error state directly — no network call.
      const result = parseAndValidateQr(raw);
      if (result.code === "ok" && result.payload) {
        void pair(result.payload);
      } else if (result.code === "expired") {
        setState("expired");
      } else {
        // unsupported_protocol, missing fields, unsupported version, etc.
        setState("unsupported");
      }
    },
    [pair, setState],
  );

  const { phase: scannerPhase, openSettings, requestPermission } = useQrScanner({
    onResult: handleQrResult,
    enabled: scannerEnabled,
  });

  const handleManualPair = useCallback(
    (json: string) => {
      try {
        const payload = JSON.parse(json) as PairingQrPayload;
        void pair(payload);
      } catch {
        // Invalid JSON — the UI stays in idle, the error is implicit
      }
    },
    [pair],
  );

  // When the scanner is active (requesting permission or scanning), show the
  // scanner-phase UI instead of the pairing-state UI. This surfaces camera
  // permission denial before the user can even scan.
  const scannerConfig = SCANNER_PHASE_CONFIG[scannerPhase];
  const showScannerUI =
    scannerEnabled &&
    scannerConfig !== null &&
    scannerPhase !== "idle";
  const config = showScannerUI ? scannerConfig! : STATE_CONFIG[state];
  const isTransitional = showScannerUI
    ? scannerPhase === "requesting_permission" || scannerPhase === "scanning"
    : TRANSITIONAL.includes(state);
  const isError = !isTransitional && !showScannerUI && state !== "idle" && state !== "success";
  const isSuccess = state === "success";

  // Auto-redirect on success (after the success animation plays)
  // The usePairing hook already triggers connect() after 800ms;
  // we navigate to home once the store reaches "online".
  if (isSuccess) {
    setTimeout(() => navigate("/home", { replace: true }), 1500);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        paddingTop: "var(--safe-top)",
      }}
    >
      {/* Back button */}
      <button
        onClick={() => navigate("/")}
        style={{
          display: "grid",
          placeItems: "center",
          width: 44,
          height: 44,
          margin: "8px 0 0 16px",
          border: "none",
          borderRadius: "50%",
          background: "transparent",
          color: "var(--color-text-secondary)",
          cursor: "pointer",
          alignSelf: "flex-start",
        }}
      >
        <ChevronLeft size={24} />
      </button>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 32px",
          gap: 16,
        }}
      >
        {/* Animated state icon */}
        <AnimatePresence mode="wait">
          <motion.div
            key={showScannerUI ? scannerPhase : state}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 22 }}
            style={{
              display: "grid",
              placeItems: "center",
              width: 88,
              height: 88,
              borderRadius: "50%",
              background: `color-mix(in srgb, ${config.color} 14%, transparent)`,
              color: config.color,
            }}
          >
            <motion.div
              animate={isTransitional ? { rotate: 360 } : {}}
              transition={isTransitional ? { duration: 1.2, repeat: Infinity, ease: "linear" } : {}}
              style={{ display: "grid", placeItems: "center" }}
            >
              {config.icon}
            </motion.div>
          </motion.div>
        </AnimatePresence>

        {/* State title + detail */}
        <div style={{ textAlign: "center", maxWidth: 280 }}>
          <h2 style={{ fontSize: 20, fontWeight: 650, color: config.color, margin: "0 0 6px" }}>
            {t(config.titleKey)}
          </h2>
          <p style={{ fontSize: 14, color: "var(--color-text-tertiary)", lineHeight: 1.5, margin: 0 }}>
            {t(config.detailKey)}
          </p>
        </div>

        {/* Camera scanner viewport — shown when scanning is active */}
        {scannerEnabled && scannerPhase === "scanning" && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            style={{ width: "100%", maxWidth: 320, marginTop: 16 }}
          >
            <div
              style={{
                aspectRatio: "1",
                borderRadius: "var(--radius-lg)",
                border: "2px solid var(--color-accent)",
                display: "grid",
                placeItems: "center",
                color: "var(--color-accent)",
                background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {/* Scan frame indicator */}
              <div
                style={{
                  width: "70%",
                  height: "70%",
                  border: "2px dashed color-mix(in srgb, var(--color-accent) 40%, transparent)",
                  borderRadius: 12,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <motion.div
                  animate={{ scale: [1, 1.06, 1] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                >
                  <QrCode size={48} style={{ opacity: 0.5 }} />
                </motion.div>
              </div>
              {/* Corner accents */}
              {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((corner) => (
                <div
                  key={corner}
                  style={{
                    position: "absolute",
                    width: 24,
                    height: 24,
                    borderColor: "var(--color-accent)",
                    borderTopWidth: corner.startsWith("top") ? 3 : 0,
                    borderBottomWidth: corner.startsWith("bottom") ? 3 : 0,
                    borderLeftWidth: corner.endsWith("left") ? 3 : 0,
                    borderRightWidth: corner.endsWith("right") ? 3 : 0,
                    borderStyle: "solid",
                    top: corner.startsWith("top") ? 8 : "auto",
                    bottom: corner.startsWith("bottom") ? 8 : "auto",
                    left: corner.endsWith("left") ? 8 : "auto",
                    right: corner.endsWith("right") ? 8 : "auto",
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {/* Camera permission denied — show retry / open settings */}
        {showScannerUI && (scannerPhase === "denied" || scannerPhase === "permanently_denied") && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, width: "100%", maxWidth: 320 }}
          >
            {scannerPhase === "denied" ? (
              <SecondaryButton onClick={() => void requestPermission()}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <RefreshCw size={16} />
                  {t("scanner.retry")}
                </span>
              </SecondaryButton>
            ) : (
              <PrimaryButton onClick={() => void openSettings()}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Settings size={16} />
                  {t("scanner.openSettings")}
                </span>
              </PrimaryButton>
            )}
          </motion.div>
        )}

        {/* Manual entry — DEV MODE ONLY (hidden in production builds) */}
        {isDev && scannerEnabled && state === "idle" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            style={{ width: "100%", maxWidth: 320, marginTop: 8 }}
          >
            <details>
              <summary
                style={{
                  fontSize: 13,
                  color: "var(--color-text-tertiary)",
                  cursor: "pointer",
                  textAlign: "center",
                  listStyle: "none",
                }}
              >
                {t("pairing.manualEntry")}
              </summary>
              <p
                style={{
                  fontSize: 11,
                  color: "var(--color-text-tertiary)",
                  textAlign: "center",
                  margin: "4px 0 8px",
                  opacity: 0.7,
                }}
              >
                {t("pairing.manualEntryDevOnly")}
              </p>
              <textarea
                value={manualJson}
                onChange={(e) => setManualJson(e.target.value)}
                placeholder={t("pairing.manualEntryHint")}
                style={{
                  width: "100%",
                  minHeight: 80,
                  marginTop: 8,
                  padding: 10,
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-separator)",
                  borderRadius: 10,
                  color: "var(--color-text-primary)",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
              <PrimaryButton
                onClick={() => handleManualPair(manualJson)}
                disabled={!manualJson.trim()}
              >
                {t("pairing.idle")}
              </PrimaryButton>
            </details>
          </motion.div>
        )}

        {/* Error retry — pairing failed states */}
        {isError && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              marginTop: 8,
              width: "100%",
              maxWidth: 320,
            }}
          >
            {errorDetail && (
              <div
                role="alert"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)",
                  background: "color-mix(in srgb, var(--color-danger) 10%, var(--color-bg-elevated))",
                  color: "var(--color-text-secondary)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  overflowWrap: "anywhere",
                  userSelect: "text",
                }}
              >
                <strong style={{ color: "var(--color-danger)" }}>
                  {t("pairing.errorDetailLabel")}
                </strong>
                <div style={{ marginTop: 3, fontFamily: "var(--font-mono)" }}>
                  {errorDetail}
                </div>
              </div>
            )}
            <PrimaryButton onClick={reset}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <RefreshCw size={16} />
                {t("pairing.retry")}
              </span>
            </PrimaryButton>
          </motion.div>
        )}
      </div>
    </div>
  );
});

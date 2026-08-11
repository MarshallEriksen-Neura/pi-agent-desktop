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
} from "lucide-react";
import type { PairingQrPayload } from "@pi/remote-control-contracts";
import { t } from "@/i18n";
import { usePairing, type PairingState } from "@/hooks/usePairing";
import { BlockButton } from "@/components/visual";
import { ScanFrame } from "@/components/task-visual";

/**
 * PairingPage (P-2) — the 8-state pairing flow.
 *
 * States:
 *  idle → scanning → validating → connecting → success
 *                                ↓
 *             expired | unsupported | unreachable | pinMismatch | rateLimited | failed
 *
 * Visual:
 *  - idle: ScanFrame 取景框(四角 + 扫描线)
 *  - transitional/error/success: 88px 状态图标圆(spring 入场 + 旋转/静止)
 *  - dev preview: 手动 JSON 输入(折叠)
 *
 * QR capture: 生产环境为原生相机扫码(Capacitor Camera/BarcodeScanner);
 * 浏览器预览用手动 JSON 输入以走通完整流程。
 */

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

export const PairingPage = memo(function PairingPage() {
  const navigate = useNavigate();
  const { state, pair, reset } = usePairing();
  const [manualJson, setManualJson] = useState("");

  const handlePair = useCallback(
    (json: string) => {
      try {
        const payload = JSON.parse(json) as PairingQrPayload;
        void pair(payload);
      } catch {
        // Invalid JSON — UI stays in idle, error is implicit
      }
    },
    [pair],
  );

  const config = STATE_CONFIG[state];
  const isTransitional = TRANSITIONAL.includes(state);
  const isError = !isTransitional && state !== "idle" && state !== "success";
  const isSuccess = state === "success";

  // Auto-redirect on success (after the success animation plays)
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
      <div className="mtopbar">
        <button
          className="ico"
          onClick={() => navigate("/")}
          aria-label={t("common.back")}
          style={{ fontSize: 22, lineHeight: 1 }}
        >
          ‹
        </button>
      </div>

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
        {/* idle: ScanFrame 取景框;其他态:状态图标圆 */}
        {state === "idle" ? (
          <motion.div
            key="scan"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 280, damping: 24 }}
          >
            <ScanFrame />
          </motion.div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={state}
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
                transition={
                  isTransitional
                    ? { duration: 1.2, repeat: Infinity, ease: "linear" }
                    : {}
                }
                style={{ display: "grid", placeItems: "center" }}
              >
                {config.icon}
              </motion.div>
            </motion.div>
          </AnimatePresence>
        )}

        {/* State title + detail */}
        <div style={{ textAlign: "center", maxWidth: 280 }}>
          <h2
            style={{
              fontSize: 20,
              fontWeight: 650,
              color: config.color,
              margin: "0 0 6px",
            }}
          >
            {t(config.titleKey)}
          </h2>
          <p
            style={{
              fontSize: 14,
              color: "var(--color-text-tertiary)",
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {t(config.detailKey)}
          </p>
        </div>

        {/* Manual entry (dev preview) */}
        {state === "idle" && (
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
              <BlockButton
                onClick={() => handlePair(manualJson)}
                disabled={!manualJson.trim()}
              >
                {t("pairing.idle")}
              </BlockButton>
            </details>
          </motion.div>
        )}

        {/* Error retry */}
        {isError && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ width: "100%", maxWidth: 260 }}
          >
            <BlockButton variant="outline" onClick={reset}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  justifyContent: "center",
                }}
              >
                <RefreshCw size={16} />
                {t("pairing.retry")}
              </span>
            </BlockButton>
          </motion.div>
        )}
      </div>
    </div>
  );
});

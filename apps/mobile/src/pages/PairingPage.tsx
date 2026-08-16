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
import { useQrScanner, type ScannerPhase } from "@/hooks/useQrScanner";
import { useConnectionStore } from "@/stores/connection.store";
import { BlockButton } from "@/components/visual";
import { ScanFrame } from "@/components/task-visual";
import {
  PairingSteps,
  PairingSuccess,
  PinMismatchView,
  UnreachableView,
} from "@/components/pairing-states";
import { parseAndValidateQr } from "@/security/qr-validate";
import { shouldEnablePairingScanner } from "@/security/pairing-flow";

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

/**
 * 走到这几个态时,页面交给 pairing-states 里的完整信息屏渲染,而不是
 * 「图标圆 + 一行文案 + 重试按钮」的通用壳。判断依据是:用户在这一步需要
 * 做决策(信任/拒绝)或需要核对数据(设备地址/指纹),而不只是被告知结果。
 */
const RICH_STATES: PairingState[] = ["success", "pinMismatch", "unreachable"];

export const PairingPage = memo(function PairingPage() {
  const navigate = useNavigate();
  const {
    state,
    pair,
    reset,
    setState,
    errorDetail,
    pinConflict,
    trustNewCertificate,
  } = usePairing();
  const stored = useConnectionStore((s) => s.stored);
  const [manualJson, setManualJson] = useState("");

  const scanner = useQrScanner({
    enabled: shouldEnablePairingScanner(state),
    onResult: (rawValue) => {
      const result = parseAndValidateQr(rawValue);
      if (result.code !== "ok" || !result.payload) {
        setState(result.code === "expired" ? "expired" : "unsupported");
        return;
      }
      void pair(result.payload);
    },
  });

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
  const isRich = RICH_STATES.includes(state);
  const isError = !isTransitional && state !== "idle" && state !== "success" && !isRich;
  const isSuccess = state === "success";
  const scannerMessage = scannerStatusMessage(scanner.phase);

  // 成功态不再自动跳转。设计稿给了「开始使用」按钮,理由是成功屏上有设备
  // 地址和证书状态需要核对 —— 1.5 秒后自己溜走的屏,用户来不及看完。
  // 跳转改由 PairingSuccess 的按钮触发。

  // 富态各自渲染完整信息屏,不套通用壳。
  if (isRich) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          paddingTop: "var(--safe-top)",
        }}
      >
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
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 20px 24px",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {isSuccess && (
            <PairingSuccess
              stored={stored}
              onContinue={() => navigate("/home", { replace: true })}
            />
          )}
          {state === "pinMismatch" && (
            <PinMismatchView
              conflict={pinConflict}
              onCancel={() => navigate("/", { replace: true })}
              onTrust={() => void trustNewCertificate()}
            />
          )}
          {state === "unreachable" && (
            <UnreachableView detail={errorDetail} onRetry={reset} />
          )}
        </div>
      </div>
    );
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

        {/* 配对中的分步清单 —— 卡住时能看出卡在哪一步。
            scanning 还没开始握手,所以只在 validating/connecting 显示。 */}
        {(state === "validating" || state === "connecting") && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{ width: "100%", maxWidth: 260 }}
          >
            <PairingSteps activeStep={state === "validating" ? 1 : 2} />
          </motion.div>
        )}

        {state === "idle" && scannerMessage && (
          <div style={{ textAlign: "center", maxWidth: 300 }}>
            <p
              style={{
                fontSize: 13,
                color:
                  scanner.phase === "error" ||
                  scanner.phase === "denied" ||
                  scanner.phase === "permanently_denied"
                    ? "var(--color-danger)"
                    : "var(--color-text-tertiary)",
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              {scannerMessage}
            </p>
            {scanner.error && (
              <p
                style={{
                  fontSize: 11,
                  color: "var(--color-text-tertiary)",
                  lineHeight: 1.4,
                  margin: "5px 0 0",
                  wordBreak: "break-word",
                }}
              >
                {scanner.error}
              </p>
            )}
          </div>
        )}

        {state === "idle" && scanner.phase === "permanently_denied" && (
          <BlockButton variant="outline" onClick={() => void scanner.openSettings()}>
            {t("scanner.openSettings")}
          </BlockButton>
        )}

        {state === "idle" &&
          (scanner.phase === "denied" ||
            scanner.phase === "error" ||
            scanner.phase === "unsupported") && (
            <BlockButton variant="outline" onClick={() => void scanner.requestPermission()}>
              {t("scanner.retry")}
            </BlockButton>
          )}

        {/* Manual entry (dev preview) */}
        {state === "idle" && !scanner.isNative && (
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
                  // 16px 是 iOS 的门槛:更小的字号会让 Safari 在聚焦时自动放大
                  // 页面(index.html 已不再用 user-scalable=no 压制这个行为)。
                  fontSize: 16,
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
            {errorDetail && (
              <p
                style={{
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: "var(--color-text-tertiary)",
                  textAlign: "center",
                  wordBreak: "break-word",
                  margin: "0 0 10px",
                }}
              >
                {errorDetail}
              </p>
            )}
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

function scannerStatusMessage(phase: ScannerPhase): string | null {
  switch (phase) {
    case "requesting_permission":
      return t("scanner.requestingPermission");
    case "denied":
      return t("scanner.deniedDetail");
    case "permanently_denied":
      return t("scanner.permanentlyDeniedDetail");
    case "error":
      return t("scanner.errorDetail");
    case "unsupported":
      return t("scanner.unsupportedDetail");
    default:
      return null;
  }
}

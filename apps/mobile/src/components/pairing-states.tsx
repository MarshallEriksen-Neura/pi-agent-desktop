import { memo } from "react";
import { motion } from "motion/react";
import { Check, Loader2, ShieldAlert, WifiOff } from "lucide-react";
import { t } from "@/i18n";
import type { StoredConnection } from "@/security/token-vault";
import type { PinConflict } from "@/hooks/usePairing";
import { BlockButton, MobileCard } from "@/components/visual";
import { LongPressButton } from "@/components/confirm";
import { FingerprintDiff } from "@/components/fingerprint";

/**
 * 配对结果的三个终局态,从设计稿「配对结果」复刻。
 *
 * 这些态从 PairingPage 拆出来独立成文件:每一个都是完整的信息屏(不是一行
 * 文案 + 一个按钮),塞在一个组件里会让 PairingPage 的状态机被视觉代码淹没。
 */

/** 配对进行中的分步清单。哪一步在跑要能看出来,否则卡住时用户不知道卡在哪。 */
export const PairingSteps = memo(function PairingSteps({
  /** 0=发现设备 1=建立通道 2=校验指纹 */
  activeStep,
}: {
  activeStep: 0 | 1 | 2;
}) {
  const steps = [
    t("pairing.stepDiscover"),
    t("pairing.stepChannel"),
    t("pairing.stepVerify"),
  ];
  return (
    <div className="steps">
      {steps.map((label, i) => {
        const cls = i < activeStep ? "done" : i === activeStep ? "active" : "";
        return (
          <div className={`stp${cls ? ` ${cls}` : ""}`} key={label}>
            <span className="sicon" aria-hidden="true">
              {i < activeStep ? (
                <Check size={14} />
              ) : i === activeStep ? (
                <Loader2 size={14} className="pi-spin" />
              ) : (
                "·"
              )}
            </span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
});

/**
 * 配对成功 — 把连上的是什么设备讲清楚。
 *
 * 成功态不做满屏庆祝:用户接下来要判断「连对了吗」,所以设备名、地址、协议、
 * 指纹状态比动画重要。地址用等宽体,因为它是需要逐字核对的数据。
 */
export const PairingSuccess = memo(function PairingSuccess({
  stored,
  onContinue,
}: {
  stored: StoredConnection | null;
  onContinue: () => void;
}) {
  const endpoint = stored?.endpoints[0];
  const rows: { label: string; value: string }[] = [];
  if (endpoint) {
    rows.push({
      label: t("pairing.deviceAddress"),
      value: `${endpoint.host}:${endpoint.port}`,
    });
    rows.push({ label: t("pairing.deviceProtocol"), value: "WSS / TLS 1.3" });
  }
  if (stored) {
    rows.push({
      label: t("settings.certPin"),
      value: `${stored.certificatePin.algorithm} ${t("settings.certPinActive")}`,
    });
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ width: "100%", display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 64,
            height: 64,
            margin: "0 auto 12px",
            borderRadius: "50%",
            background: "color-mix(in srgb, var(--color-success) 14%, transparent)",
            color: "var(--color-success)",
          }}
        >
          <Check size={30} />
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 650, margin: "0 0 4px" }}>
          {stored?.desktopName ?? t("pairing.success")}
        </h2>
        <p style={{ fontSize: 14, color: "var(--color-text-tertiary)", margin: 0 }}>
          {t("pairing.successDetail")}
        </p>
      </div>

      {rows.length > 0 && (
        <MobileCard style={{ padding: "4px 14px" }}>
          {rows.map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 0",
                borderTop: "1px solid var(--color-separator)",
                fontSize: 13,
              }}
            >
              <span style={{ color: "var(--color-text-secondary)" }}>{row.label}</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text-primary)",
                  textAlign: "right",
                  wordBreak: "break-all",
                }}
              >
                {row.value}
              </span>
            </div>
          ))}
        </MobileCard>
      )}

      <p
        style={{
          fontSize: 12,
          color: "var(--color-text-tertiary)",
          textAlign: "center",
          margin: 0,
        }}
      >
        {t("pairing.autoReconnectHint")}
      </p>

      <BlockButton variant="primary" onClick={onContinue}>
        {t("pairing.startUsing")}
      </BlockButton>
    </motion.div>
  );
});

/**
 * 证书指纹不匹配 — 全屏最高视觉权重,但默认操作是拒绝。
 *
 * 这一屏的设计原则:安全相关的默认动作必须是安全的那一个。「取消配对」是
 * 主按钮样式,「信任新证书」是次要样式且只能长按 2 秒触发。两者之间留出间距,
 * 避免误触把危险操作点成常规操作。
 */
export const PinMismatchView = memo(function PinMismatchView({
  conflict,
  onCancel,
  onTrust,
}: {
  conflict: PinConflict | null;
  onCancel: () => void;
  onTrust: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ width: "100%", display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 40,
            height: 40,
            flexShrink: 0,
            borderRadius: "50%",
            background: "color-mix(in srgb, var(--color-danger) 12%, transparent)",
            color: "var(--color-danger)",
          }}
        >
          <ShieldAlert size={22} />
        </span>
        <h2 style={{ fontSize: 19, fontWeight: 650, margin: 0 }}>
          {t("pairing.pinMismatch")}
        </h2>
      </div>

      <p
        style={{
          fontSize: 14,
          lineHeight: 1.55,
          color: "var(--color-text-secondary)",
          margin: 0,
        }}
      >
        {t("pairing.pinMismatchReason")}
      </p>

      {/* 有两侧指纹才能比对;首次配对就被拒时只给文案警告。 */}
      {conflict && (
        <FingerprintDiff
          expected={`SHA-256: ${conflict.expected}`}
          actual={`SHA-256: ${conflict.actual}`}
          expectedLabel={t("pairing.fpExpected")}
          actualLabel={t("pairing.fpActual")}
        />
      )}

      {/* 安全默认排在前面 */}
      <BlockButton variant="danger" onClick={onCancel}>
        {t("pairing.cancelPairing")}
      </BlockButton>

      {/* 12px 以上间距 —— 危险操作不能紧贴常规操作 */}
      {conflict && (
        <div style={{ marginTop: 4 }}>
          <LongPressButton
            danger
            durationMs={2000}
            onConfirm={onTrust}
            hint={t("confirm.longPressTrust")}
            icon={<ShieldAlert size={16} aria-hidden="true" />}
          >
            {t("confirm.longPressTrust")}
          </LongPressButton>
        </div>
      )}
    </motion.div>
  );
});

/** 连不上 — 说明该查什么,并保留诊断详情入口。 */
export const UnreachableView = memo(function UnreachableView({
  detail,
  onRetry,
}: {
  detail: string | null;
  onRetry: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ width: "100%", display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 56,
            height: 56,
            margin: "0 auto 12px",
            borderRadius: "50%",
            background: "var(--color-bg-elevated)",
            color: "var(--color-text-tertiary)",
          }}
        >
          <WifiOff size={26} />
        </div>
        <h2 style={{ fontSize: 19, fontWeight: 650, margin: "0 0 6px" }}>
          {t("pairing.unreachable")}
        </h2>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--color-text-tertiary)",
            margin: 0,
          }}
        >
          {t("pairing.unreachableDetail")}
        </p>
      </div>

      {detail && (
        <details>
          <summary
            style={{
              fontSize: 13,
              color: "var(--color-text-secondary)",
              cursor: "pointer",
              minHeight: "var(--tap-min)",
              display: "flex",
              alignItems: "center",
            }}
          >
            {t("connection.errorTrace")}
          </summary>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--color-text-tertiary)",
              wordBreak: "break-word",
              margin: "6px 0 0",
            }}
          >
            {detail}
          </p>
        </details>
      )}

      <BlockButton variant="primary" onClick={onRetry}>
        {t("pairing.retry")}
      </BlockButton>
    </motion.div>
  );
});

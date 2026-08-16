import { memo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, Monitor, Info, Trash2, Power, KeyRound, Activity, Cpu } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import {
  SectionLabel,
  MobileCard,
  MobileRow,
  ConfirmModal,
} from "@/components/visual";
import { SecureTetherBadge } from "@/components/SecureTether";
import { useSecureStorage } from "@/hooks/useSecureStorage";
import { useConversationStore } from "@/stores/conversation-store";
import { useModelCatalog } from "@/stores/models-store";

/**
 * SettingsPage — 连接管理 + 安全 + 关于。
 *
 * "Forget this desktop" 清除本地连接(token/pin/storage),不在桌面端撤销
 * —— 用户必须从桌面的已配对设备列表撤销(设计约束:桌面是撤销唯一管理者)。
 *
 * 相对设计稿的两处偏离:
 *  - 不做「推送通知」开关。手机端目前没有推送基础设施(Android 要接 FCM),
 *    放一个开关上去就是个动了也不生效的假控件。
 *  - 证书行显示真实算法(spki-sha256)和真实指纹,而不是设计稿里写的
 *    "Verified RSA-2048" —— 那个值是设计稿编的,和实际 pin 算法不符。
 */
export const SettingsPage = memo(function SettingsPage() {
  const navigate = useNavigate();
  const { stored, phase, lastError, forget } = useConnection();
  const { clear } = useSecureStorage();
  const [showForgetConfirm, setShowForgetConfirm] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  const handleForget = async () => {
    setForgetting(true);
    await forget();
    await clear();
    setForgetting(false);
    setShowForgetConfirm(false);
  };

  // Detect native (cert pin active) vs browser (inactive)
  const isNative =
    typeof window !== "undefined" && "Capacitor" in window;
  const hasWake = Boolean(stored?.wakeOnLan?.targets.length);
  const endpoint = stored?.endpoints[0];
  const v2Status = useConversationStore((s) => s.v2Available);
  const modelStatus = useModelCatalog((s) => s.available);

  const v2Label =
    v2Status === null ? t("settings.diagnosticProbe") : v2Status ? t("settings.diagnosticOk") : t("settings.diagnosticOff");
  const modelLabel =
    modelStatus === null ? t("settings.diagnosticProbe") : modelStatus ? t("settings.diagnosticOk") : t("settings.diagnosticOff");

  return (
    <div className="page-scroll">
      <h1 className="page-title">{t("tab.settings")}</h1>

      {/* Connection section */}
      <SectionLabel>{t("settings.connection")}</SectionLabel>
      <MobileCard style={{ marginBottom: 24 }}>
        <MobileRow
          icon={<Monitor size={16} />}
          title={stored?.desktopName ?? t("connection.offline")}
          // 地址是用户核对「连的是哪台机器」的唯一依据,用等宽体便于逐字读。
          detail={endpoint ? `${endpoint.host}:${endpoint.port}` : t("settings.connectionDetail")}
          trailing={<SecureTetherBadge phase={phase} showLabel={false} />}
        />
        <MobileRow
          icon={<Power size={16} />}
          title={t("settings.wakeOnLan")}
          detail={
            hasWake
              ? t("settings.wakeOnLanDetail")
              : t("settings.wakeOnLanUnavailableDetail")
          }
          trailing={
            <span
              className="meta-badge"
              style={{
                color: hasWake
                  ? "var(--color-success)"
                  : "var(--color-text-tertiary)",
              }}
            >
              {hasWake
                ? t("settings.wakeOnLanAvailable")
                : t("settings.wakeOnLanUnavailable")}
            </span>
          }
        />
        {/* 重新配对 —— 换机器或桌面端重装后需要。原来只能先「忘记」再走引导流程,
            多了一步没必要的破坏性操作。 */}
        <MobileRow
          icon={<KeyRound size={16} />}
          title={t("settings.repair")}
          detail={t("settings.repairDetail")}
          onClick={() => navigate("/pair")}
        />
      </MobileCard>

      {/* Security section */}
      <SectionLabel>{t("settings.security")}</SectionLabel>
      <MobileCard style={{ marginBottom: 24 }}>
        <MobileRow
          icon={<ShieldCheck size={16} />}
          title={t("settings.certPin")}
          detail={
            stored ? stored.certificatePin.algorithm : t("settings.securityDetail")
          }
          trailing={
            <span
              className="meta-badge"
              style={{
                color: isNative
                  ? "var(--color-success)"
                  : "var(--color-text-tertiary)",
              }}
            >
              {isNative
                ? t("settings.certPinActive")
                : t("settings.certPinInactive")}
            </span>
          }
        />
        {/* 指纹全文 —— 这是安全页最该给的东西:用户要能和桌面端逐段核对。
            折叠是因为它很长,但必须可见,不能只显示「已验证」。 */}
        {stored && (
          <details className="fp-row">
            <summary>
              <span className="fpl">{t("settings.fingerprint")}</span>
              <span className="fps">{shortPin(stored.certificatePin.value)}</span>
            </summary>
            <div className="fpbody">
              <code>{stored.certificatePin.value}</code>
              <p>{t("settings.fingerprintHint")}</p>
            </div>
          </details>
        )}
        <MobileRow
          icon={<Activity size={16} />}
          title={t("settings.diagnostics")}
          detail={
            lastError
              ? `${t("settings.lastError")}: ${lastError}`
              : t("settings.diagnosticsDetail")
          }
          trailing={
            <span
              className="meta-badge"
              style={{
                color: lastError
                  ? "var(--color-status-degraded)"
                  : "var(--color-success)",
              }}
            >
              {lastError ? t("common.error") : t("settings.noError")}
            </span>
          }
        />
      </MobileCard>

      {/* About section */}
      <SectionLabel>{t("settings.about")}</SectionLabel>
      <MobileCard style={{ marginBottom: 24 }}>
        <MobileRow
          icon={<Info size={16} />}
          title={t("app.name")}
          detail={
            stored?.pairedAt
              ? `${t("settings.pairedAt")} ${formatDate(stored.pairedAt)}`
              : t("settings.aboutDetail")
          }
          trailing={
            <span className="meta-badge" style={{ color: "var(--color-text-tertiary)" }}>
              {/* 构建期注入,不手写 —— 手写的常量一定会和真实版本分叉 */}
              v{__APP_VERSION__}
            </span>
          }
        />
        <MobileRow
          icon={<Cpu size={16} />}
          title={t("settings.hostDiagnostics")}
          detail={`${t("settings.diagnosticV2")}: ${v2Label}\n${t("settings.diagnosticModels")}: ${modelLabel}`}
        />
      </MobileCard>

      {/* Danger zone — forget this desktop */}
      <MobileCard>
        <MobileRow
          icon={<Trash2 size={16} />}
          title={t("settings.forgetDevice")}
          detail={t("settings.forgetDeviceDetail")}
          danger
          onClick={() => setShowForgetConfirm(true)}
        />
      </MobileCard>

      {/* Forget confirmation modal */}
      <ConfirmModal
        open={showForgetConfirm}
        title={t("connection.forgetConfirm")}
        detail={t("connection.forgetConfirmDetail")}
        confirmLabel={forgetting ? t("common.loading") : t("connection.forget")}
        cancelLabel={t("common.cancel")}
        busy={forgetting}
        onConfirm={handleForget}
        onCancel={() => setShowForgetConfirm(false)}
      />
    </div>
  );
});

/** 指纹摘要 —— 首尾各 4 段,中间省略。完整值在展开区里。 */
function shortPin(value: string): string {
  const segs = value.includes(":") ? value.split(":") : (value.match(/.{1,2}/g) ?? []);
  if (segs.length <= 8) return segs.join(":");
  return `${segs.slice(0, 3).join(":")}…${segs.slice(-3).join(":")}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

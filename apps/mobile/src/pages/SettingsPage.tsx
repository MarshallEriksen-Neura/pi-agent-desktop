import { memo, useState } from "react";
import { ShieldCheck, Monitor, Info, Trash2, Power } from "lucide-react";
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

/**
 * SettingsPage — 连接管理 + 安全 + 关于。
 *
 * "Forget this desktop" 清除本地连接(token/pin/storage),不在桌面端撤销
 * —— 用户必须从桌面的已配对设备列表撤销(设计约束:桌面是撤销唯一管理者)。
 */
export const SettingsPage = memo(function SettingsPage() {
  const { stored, phase, forget } = useConnection();
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

  return (
    <div className="page-scroll">
      <h1 className="page-title">{t("tab.settings")}</h1>

      {/* Connection section */}
      <SectionLabel>{t("settings.connection")}</SectionLabel>
      <MobileCard style={{ marginBottom: 24 }}>
        <MobileRow
          icon={<Monitor size={16} />}
          title={stored?.desktopName ?? t("connection.offline")}
          detail={t("settings.connectionDetail")}
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
      </MobileCard>

      {/* Security section */}
      <SectionLabel>{t("settings.security")}</SectionLabel>
      <MobileCard style={{ marginBottom: 24 }}>
        <MobileRow
          icon={<ShieldCheck size={16} />}
          title={t("settings.certPin")}
          detail={t("settings.securityDetail")}
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
      </MobileCard>

      {/* About section */}
      <SectionLabel>{t("settings.about")}</SectionLabel>
      <MobileCard style={{ marginBottom: 24 }}>
        <MobileRow
          icon={<Info size={16} />}
          title={t("app.name")}
          detail={t("settings.aboutDetail")}
          trailing={
            <span className="meta-badge" style={{ color: "var(--color-text-tertiary)" }}>
              v0.1.0
            </span>
          }
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

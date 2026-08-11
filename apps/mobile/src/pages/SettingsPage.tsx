import { memo, useState } from "react";
import { ShieldCheck, Monitor, Info, Trash2, Power } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { Card, Row, PrimaryButton, SecondaryButton } from "@/components/primitives";
import { SecureTetherBadge } from "@/components/SecureTether";
import { useSecureStorage } from "@/hooks/useSecureStorage";

/**
 * SettingsPage — connection management + security + about.
 *
 * The "Forget this desktop" action clears the local connection (token, pin,
 * storage) but does NOT revoke on the desktop side — the user must do that
 * from the desktop's Paired Devices list (design constraint: desktop is the
 * sole manager for revocation).
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

  // Detect if running in native (cert pin active) or browser (inactive)
  const isNative =
    typeof window !== "undefined" && "Capacitor" in window;

  return (
    <div style={{ padding: "16px" }}>
      {/* Page title */}
      <h1
        style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          margin: "8px 0 20px",
        }}
      >
        {t("tab.settings")}
      </h1>

      {/* Connection section */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--color-text-tertiary)",
          padding: "0 4px 8px",
        }}
      >
        {t("settings.connection")}
      </div>
      <Card style={{ marginBottom: 24 }}>
        <Row
          icon={<Monitor size={16} />}
          title={stored?.desktopName ?? t("connection.offline")}
          detail={t("settings.connectionDetail")}
          trailing={<SecureTetherBadge phase={phase} />}
        />
        <Row
          icon={<Power size={16} />}
          title={t("settings.wakeOnLan")}
          detail={stored?.wakeOnLan?.targets.length
            ? t("settings.wakeOnLanDetail")
            : t("settings.wakeOnLanUnavailableDetail")}
          trailing={
            <span
              style={{
                fontSize: 13,
                color: stored?.wakeOnLan?.targets.length
                  ? "var(--color-success)"
                  : "var(--color-text-tertiary)",
                fontWeight: 500,
              }}
            >
              {stored?.wakeOnLan?.targets.length
                ? t("settings.wakeOnLanAvailable")
                : t("settings.wakeOnLanUnavailable")}
            </span>
          }
        />
      </Card>

      {/* Security section */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--color-text-tertiary)",
          padding: "0 4px 8px",
        }}
      >
        {t("settings.security")}
      </div>
      <Card style={{ marginBottom: 24 }}>
        <Row
          icon={<ShieldCheck size={16} />}
          title={t("settings.certPin")}
          detail={t("settings.securityDetail")}
          trailing={
            <span
              style={{
                fontSize: 13,
                color: isNative ? "var(--color-success)" : "var(--color-text-tertiary)",
                fontWeight: 500,
              }}
            >
              {isNative ? t("settings.certPinActive") : t("settings.certPinInactive")}
            </span>
          }
        />
      </Card>

      {/* About section */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--color-text-tertiary)",
          padding: "0 4px 8px",
        }}
      >
        {t("settings.about")}
      </div>
      <Card style={{ marginBottom: 24 }}>
        <Row
          icon={<Info size={16} />}
          title={t("app.name")}
          detail={t("settings.aboutDetail")}
          trailing={
            <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>v0.1.0</span>
          }
        />
      </Card>

      {/* Danger zone — forget this desktop */}
      <Card>
        <Row
          icon={<Trash2 size={16} />}
          title={t("settings.forgetDevice")}
          detail={t("settings.forgetDeviceDetail")}
          danger
          onClick={() => setShowForgetConfirm(true)}
        />
      </Card>

      {/* Forget confirmation modal */}
      <AnimatePresence>
        {showForgetConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !forgetting && setShowForgetConfirm(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.5)",
              backdropFilter: "blur(3px)",
              padding: 24,
            }}
          >
            <motion.div
              initial={{ scale: 0.94, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 6 }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 340,
                background: "var(--color-bg-base)",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--color-separator)",
                padding: "22px 22px 18px",
                textAlign: "center",
              }}
            >
              <h2 style={{ fontSize: 17, fontWeight: 650, margin: "0 0 8px" }}>
                {t("connection.forgetConfirm")}
              </h2>
              <p style={{ fontSize: 14, color: "var(--color-text-secondary)", lineHeight: 1.5, margin: "0 0 18px" }}>
                {t("connection.forgetConfirmDetail")}
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <SecondaryButton onClick={() => setShowForgetConfirm(false)} disabled={forgetting}>
                  {t("common.cancel")}
                </SecondaryButton>
                <PrimaryButton danger onClick={handleForget} disabled={forgetting}>
                  {forgetting ? t("common.loading") : t("connection.forget")}
                </PrimaryButton>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

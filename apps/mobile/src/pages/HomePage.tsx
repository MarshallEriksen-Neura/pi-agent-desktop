import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { FolderTree, ListChecks, Monitor, Power } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { SecureTetherHero } from "@/components/SecureTether";
import { StateView, FullScreenSpinner } from "@/components/primitives";
import {
  SectionLabel,
  MobileCard,
  MobileRow,
  BlockButton,
} from "@/components/visual";

/**
 * HomePage (P-3) — connection landing page.
 *
 * Visual layers(对齐 demo):
 *  1. SecureTetherHero — SVG 标志视觉(桌面—链路—锁—手机)
 *  2. mhero — 桌面名 + 状态点 + 状态文案
 *  3. 快捷操作 mcard — 项目 / 任务
 *
 * State matrix:
 *  - online:          full page(上方三层)
 *  - reconnecting:    hero + spinner
 *  - offline:         StateView + reconnect / wake
 *  - identity_failed: StateView + re-pair
 *  - waking/loading:  FullScreenSpinner
 */
export const HomePage = memo(function HomePage() {
  const navigate = useNavigate();
  const {
    stored,
    phase,
    lastError,
    isOnline,
    isReconnecting,
    isWaking,
    isIdentityFailed,
    connect,
    wake,
  } = useConnection();

  if (isWaking) {
    return <FullScreenSpinner label={t("wake.waking")} />;
  }

  // Reconnecting — hero (amber pulse) + spinner
  if (isReconnecting) {
    return (
      <div>
        <SecureTetherHero phase={phase} />
        <FullScreenSpinner label={t("connection.reconnecting")} />
      </div>
    );
  }

  // Identity failed — needs re-pair
  if (isIdentityFailed) {
    return (
      <StateView
        icon={<Monitor size={28} style={{ color: "var(--color-danger)" }} />}
        title={t("error.identityRotated")}
        detail={t("error.identityRotatedDetail")}
        action={
          <BlockButton variant="outline" onClick={() => navigate("/pair")}>
            {t("onboarding.start")}
          </BlockButton>
        }
      />
    );
  }

  // Offline — offer reconnect (and wake if WoL targets exist)
  if (phase === "offline") {
    const canWake = Boolean(stored?.wakeOnLan?.targets.length);
    return (
      <StateView
        icon={
          canWake ? (
            <Power size={28} style={{ color: "var(--color-accent)" }} />
          ) : (
            <Monitor size={28} style={{ color: "var(--color-text-tertiary)" }} />
          )
        }
        title={t("error.unreachable")}
        detail={
          lastError === "wake_timeout"
            ? t("wake.timeoutDetail")
            : t("error.unreachableDetail")
        }
        action={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              width: "100%",
              maxWidth: 260,
            }}
          >
            {canWake && (
              <BlockButton variant="primary" onClick={wake}>
                {t("wake.action")}
              </BlockButton>
            )}
            <BlockButton
              variant={canWake ? "outline" : "primary"}
              onClick={connect}
            >
              {t("connection.reconnect")}
            </BlockButton>
          </div>
        }
      />
    );
  }

  // Loading (pairing/connecting)
  if (!stored || !isOnline) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  // Online — full home page
  return (
    <div>
      {/* 1. Secure Tether hero — SVG 标志视觉 */}
      <SecureTetherHero phase={phase} />

      {/* 2. mhero — desktop name + status dot + status text */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mhero"
        data-st="online"
      >
        <div className="desk-name">{stored.desktopName}</div>
        <div className="status-line">
          <span className="sdot" />
          <span>{t("connection.online")}</span>
        </div>
      </motion.div>

      {/* 3. Quick actions */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        style={{ padding: "0 16px" }}
      >
        <SectionLabel>{t("home.quickActions")}</SectionLabel>
        <MobileCard>
          <MobileRow
            icon={<FolderTree size={16} />}
            title={t("home.projects")}
            onClick={() => navigate("/projects")}
          />
          <MobileRow
            icon={<ListChecks size={16} />}
            title={t("home.tasks")}
            onClick={() => navigate("/tasks")}
          />
        </MobileCard>
      </motion.div>
    </div>
  );
});

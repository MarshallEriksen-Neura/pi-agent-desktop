import { memo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { FolderTree, ListChecks, Monitor, ChevronRight } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { SecureTetherHero } from "@/components/SecureTether";
import { Card, Row, StateView, FullScreenSpinner, PrimaryButton, SecondaryButton } from "@/components/primitives";

/**
 * HomePage (P-3) — the connection landing page. Shows the Secure Tether hero
 * mark, desktop info, and quick-action links to Projects / Tasks.
 *
 * State matrix:
 *  - online: hero + desktop card + quick actions
 *  - reconnecting: hero (amber) + "reconnecting" message
 *  - offline: error state view with reconnect action
 *  - identity_failed: identity-failed state view with re-pair guidance
 */
export const HomePage = memo(function HomePage() {
  const navigate = useNavigate();
  const { stored, phase, isOnline, isReconnecting, isIdentityFailed, connect } = useConnection();

  // Reconnecting state
  if (isReconnecting) {
    return (
      <div style={{ padding: "16px" }}>
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
          <SecondaryButton onClick={() => navigate("/pair")}>
            {t("onboarding.start")}
          </SecondaryButton>
        }
      />
    );
  }

  // Offline — offer reconnect
  if (phase === "offline") {
    return (
      <StateView
        icon={<Monitor size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.unreachable")}
        detail={t("error.unreachableDetail")}
        action={<PrimaryButton onClick={connect}>{t("connection.reconnect")}</PrimaryButton>}
      />
    );
  }

  // Loading (pairing/connecting)
  if (!stored || !isOnline) {
    return <FullScreenSpinner label={t("common.loading")} />;
  }

  // Online — full home page
  return (
    <div style={{ padding: "16px" }}>
      {/* Secure Tether hero */}
      <SecureTetherHero phase={phase} />

      {/* Desktop info card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <Card style={{ marginBottom: 16 }}>
          <Row
            icon={<Monitor size={16} />}
            title={stored.desktopName}
            detail={t("home.desktop")}
          />
        </Card>
      </motion.div>

      {/* Quick actions */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text-tertiary)",
            padding: "0 4px 8px",
          }}
        >
          {t("home.quickActions")}
        </div>
        <Card>
          <Row
            icon={<FolderTree size={16} />}
            title={t("home.projects")}
            trailing={<ChevronRight size={18} style={{ color: "var(--color-text-tertiary)" }} />}
            onClick={() => navigate("/projects")}
          />
          <Row
            icon={<ListChecks size={16} />}
            title={t("home.tasks")}
            trailing={<ChevronRight size={18} style={{ color: "var(--color-text-tertiary)" }} />}
            onClick={() => navigate("/tasks")}
          />
        </Card>
      </motion.div>
    </div>
  );
});

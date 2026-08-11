import { memo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ShieldCheck, QrCode, ArrowRight } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { BlockButton } from "@/components/visual";
import { useConnectionStore } from "@/stores/connection.store";

/**
 * OnboardingPage (P-1) — 首次启动落地页。展示产品价值主张与 Secure Tether
 * 标志视觉。若已有存储连接,自动跳转 Home。
 */
export const OnboardingPage = memo(function OnboardingPage() {
  const navigate = useNavigate();
  const { stored } = useConnection();
  const loadStored = useConnectionStore((s) => s.loadStored);

  useEffect(() => {
    void (async () => {
      const has = await loadStored();
      if (has) {
        navigate("/home", { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding:
          "calc(var(--safe-top) + 48px) 32px calc(var(--safe-bottom) + 32px)",
        textAlign: "center",
      }}
    >
      {/* Hero — Secure Tether mark */}
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 22 }}
        style={{
          display: "grid",
          placeItems: "center",
          width: 96,
          height: 96,
          borderRadius: "50%",
          background:
            "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          color: "var(--color-accent)",
          margin: "0 auto 24px",
        }}
      >
        <ShieldCheck size={44} />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        style={{
          fontSize: 32,
          fontWeight: 700,
          margin: "0 0 8px",
          letterSpacing: "-0.02em",
        }}
      >
        {t("onboarding.title")}
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        style={{
          fontSize: 15,
          color: "var(--color-text-secondary)",
          margin: "0 0 8px",
          fontWeight: 500,
        }}
      >
        {t("onboarding.subtitle")}
      </motion.p>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        style={{
          fontSize: 14,
          color: "var(--color-text-tertiary)",
          lineHeight: 1.6,
          margin: "0 0 40px",
        }}
      >
        {t("onboarding.description")}
      </motion.p>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
          maxWidth: 320,
          width: "100%",
          margin: "0 auto",
        }}
      >
        <BlockButton variant="primary" onClick={() => navigate("/pair")}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
            }}
          >
            <QrCode size={18} />
            {t("onboarding.start")}
            <ArrowRight size={18} />
          </span>
        </BlockButton>
        {stored && (
          <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
            {t("onboarding.hasConnection")}
          </span>
        )}
      </motion.div>
    </div>
  );
});

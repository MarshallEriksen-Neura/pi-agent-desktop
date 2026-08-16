import { memo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Activity, Lock, QrCode, Radio } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { BlockButton } from "@/components/visual";
import { useConnectionStore } from "@/stores/connection.store";

/**
 * OnboardingPage (P-1) — 首次启动落地页。
 *
 * 复刻设计稿「引导页」。相对旧版的关键改动:
 *  - 三条能力说明取代一段笼统描述。用户在授权相机、扫码之前要先明白这个 app
 *    能做什么、代码会不会离开自己的电脑。
 *  - hero 从静态盾牌图标换成水墨式呼吸光晕:这是全屏唯一动画,表达「链路存活」
 *    而不是「正在加载」。
 *  - 底部补一行前置条件,避免用户扫码扫不到时不知道要先在桌面端开面板。
 *
 * 已有存储连接时自动跳转 Home。
 */

/** 三条能力说明 —— 顺序即优先级:先看、再决策、最后才是安全承诺。 */
const FEATURES = [
  {
    icon: Activity,
    titleKey: "onboarding.featLiveTitle",
    detailKey: "onboarding.featLiveDetail",
  },
  {
    icon: Radio,
    titleKey: "onboarding.featDecideTitle",
    detailKey: "onboarding.featDecideDetail",
  },
  {
    icon: Lock,
    titleKey: "onboarding.featSecureTitle",
    detailKey: "onboarding.featSecureDetail",
  },
] as const;

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
        overflow: "auto",
        padding:
          "calc(var(--safe-top) + 40px) 20px calc(var(--safe-bottom) + 24px)",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {/* Hero — 有机形状 + 高斯模糊,缓慢呼吸。全屏唯一动画。 */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 240, damping: 24 }}
        style={{
          position: "relative",
          display: "grid",
          placeItems: "center",
          width: 132,
          height: 132,
          margin: "0 auto 28px",
        }}
      >
        <div
          aria-hidden="true"
          className="ink-breathe"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "58% 42% 47% 53% / 43% 51% 49% 57%",
            background:
              "radial-gradient(circle at 34% 32%, var(--color-accent), transparent 68%)",
            filter: "blur(26px)",
            opacity: 0.5,
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "relative",
            display: "grid",
            placeItems: "center",
            width: 76,
            height: 76,
            borderRadius: "50%",
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
            border: "0.5px solid rgba(255, 255, 255, 0.14)",
            color: "var(--color-accent)",
            backdropFilter: "blur(12px)",
          }}
        >
          <Radio size={34} />
        </div>
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        style={{
          fontSize: 28,
          fontWeight: 700,
          margin: "0 0 10px",
          letterSpacing: "-0.02em",
          textAlign: "center",
        }}
      >
        {t("onboarding.headline")}
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        style={{
          fontSize: 15,
          color: "var(--color-text-secondary)",
          lineHeight: 1.6,
          margin: "0 0 28px",
          textAlign: "center",
        }}
      >
        {t("onboarding.lede")}
      </motion.p>

      {/* 三条能力 —— 图标 + 标题 + 一行说明 */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        style={{ display: "flex", flexDirection: "column", gap: 18 }}
      >
        {FEATURES.map(({ icon: Icon, titleKey, detailKey }) => (
          <div key={titleKey} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <span
              aria-hidden="true"
              style={{
                display: "grid",
                placeItems: "center",
                width: 34,
                height: 34,
                flexShrink: 0,
                borderRadius: 10,
                background: "var(--material-regular)",
                color: "var(--color-accent)",
              }}
            >
              <Icon size={17} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>
                {t(titleKey)}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--color-text-tertiary)",
                  lineHeight: 1.5,
                }}
              >
                {t(detailKey)}
              </div>
            </div>
          </div>
        ))}
      </motion.div>

      <div style={{ flex: 1, minHeight: 28 }} />

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "center",
          maxWidth: 340,
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
            <QrCode size={18} aria-hidden="true" />
            {t("onboarding.scanToPair")}
          </span>
        </BlockButton>

        {stored ? (
          <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
            {t("onboarding.hasConnection")}
          </span>
        ) : (
          <p
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--color-text-tertiary)",
              textAlign: "center",
              margin: "2px 0 0",
            }}
          >
            {t("onboarding.prereq")}
          </p>
        )}
      </motion.div>
    </div>
  );
});

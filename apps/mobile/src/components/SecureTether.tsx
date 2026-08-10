import { memo } from "react";
import { motion } from "motion/react";
import { ShieldCheck, RefreshCw, WifiOff, ShieldAlert } from "lucide-react";
import type { ConnectionPhase } from "@/stores/connection.store";
import { t } from "@/i18n";

/**
 * SecureTether — the signature visual mark representing the secure connection
 * between phone and desktop (design §7). Four states:
 *
 *  - online: green shield with steady pulse — "已连接"
 *  - reconnecting: amber refresh spinning — "重连中…"
 *  - offline: gray wifi-off — "未连接"
 *  - identity_failed: red shield alert — "身份已变更"
 *
 * The large variant (hero) is used on the Home page; the compact variant
 * (badge) appears in the connection bar and settings.
 */

const PHASE_CONFIG: Record<
  ConnectionPhase | "idle",
  { color: string; bg: string; icon: React.ReactNode; label: string; pulse: boolean; spin: boolean }
> = {
  online: {
    color: "var(--color-success)",
    bg: "color-mix(in srgb, var(--color-success) 14%, transparent)",
    icon: <ShieldCheck size={24} />,
    label: "connection.online",
    pulse: true,
    spin: false,
  },
  reconnecting: {
    color: "var(--color-warning)",
    bg: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
    icon: <RefreshCw size={24} />,
    label: "connection.reconnecting",
    pulse: false,
    spin: true,
  },
  offline: {
    color: "var(--color-text-tertiary)",
    bg: "var(--color-bg-elevated)",
    icon: <WifiOff size={24} />,
    label: "connection.offline",
    pulse: false,
    spin: false,
  },
  identity_failed: {
    color: "var(--color-danger)",
    bg: "color-mix(in srgb, var(--color-danger) 14%, transparent)",
    icon: <ShieldAlert size={24} />,
    label: "connection.identityFailed",
    pulse: false,
    spin: false,
  },
  idle: {
    color: "var(--color-text-tertiary)",
    bg: "var(--color-bg-elevated)",
    icon: <WifiOff size={24} />,
    label: "connection.offline",
    pulse: false,
    spin: false,
  },
  pairing: {
    color: "var(--color-accent)",
    bg: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
    icon: <RefreshCw size={24} />,
    label: "connection.reconnecting",
    pulse: false,
    spin: true,
  },
};

/** Large hero variant — for the Home page. */
export const SecureTetherHero = memo(function SecureTetherHero({
  phase,
}: {
  phase: ConnectionPhase;
}) {
  const config = PHASE_CONFIG[phase] ?? PHASE_CONFIG.offline;
  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "32px 0",
      }}
    >
      <motion.div
        animate={
          config.pulse
            ? { scale: [1, 1.06, 1], opacity: [1, 0.7, 1] }
            : config.spin
              ? { rotate: 360 }
              : {}
        }
        transition={
          config.pulse
            ? { duration: 2, repeat: Infinity, ease: "easeInOut" }
            : config.spin
              ? { duration: 1.2, repeat: Infinity, ease: "linear" }
              : {}
        }
        style={{
          display: "grid",
          placeItems: "center",
          width: 80,
          height: 80,
          borderRadius: "50%",
          background: config.bg,
          color: config.color,
        }}
      >
        {config.icon}
      </motion.div>
      <span style={{ fontSize: 17, fontWeight: 600, color: config.color }}>
        {t(config.label)}
      </span>
    </motion.div>
  );
});

/** Compact badge variant — for the connection bar and settings. */
export const SecureTetherBadge = memo(function SecureTetherBadge({
  phase,
}: {
  phase: ConnectionPhase;
}) {
  const config = PHASE_CONFIG[phase] ?? PHASE_CONFIG.offline;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        fontWeight: 600,
        padding: "4px 10px",
        borderRadius: 999,
        background: config.bg,
        color: config.color,
      }}
    >
      <motion.span
        animate={config.pulse ? { opacity: [1, 0.4, 1] } : {}}
        transition={config.pulse ? { duration: 1.5, repeat: Infinity } : {}}
        style={{ display: "grid", placeItems: "center" }}
      >
        {config.icon}
      </motion.span>
      {t(config.label)}
    </span>
  );
});

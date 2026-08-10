import { memo } from "react";
import { motion } from "motion/react";
import { Loader2 } from "lucide-react";

/**
 * Mobile UI primitives — iOS-inspired, touch-first. These are the building
 * blocks for all pages. Kept minimal so pages compose them freely.
 */

/** Full-screen centered spinner with label. */
export const FullScreenSpinner = memo(function FullScreenSpinner({ label }: { label?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 12,
      }}
    >
      <Loader2 size={28} className="pi-spin" style={{ color: "var(--color-accent)" }} />
      {label && (
        <span style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>{label}</span>
      )}
    </div>
  );
});

/** State view for loading / empty / error / offline / success. */
export const StateView = memo(function StateView({
  icon,
  title,
  detail,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: "32px 24px",
        gap: 10,
        textAlign: "center",
      }}
    >
      {icon && (
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "var(--color-bg-elevated)",
            marginBottom: 4,
          }}
        >
          {icon}
        </div>
      )}
      <span style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text-primary)" }}>
        {title}
      </span>
      {detail && (
        <span
          style={{
            fontSize: 14,
            color: "var(--color-text-tertiary)",
            lineHeight: 1.5,
            maxWidth: 280,
          }}
        >
          {detail}
        </span>
      )}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
});

/** Primary button — iOS filled style, 48px tap target. */
export const PrimaryButton = memo(function PrimaryButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: "var(--tap-comfort)",
        padding: "0 24px",
        border: "none",
        borderRadius: "var(--radius-md)",
        background: danger ? "var(--color-danger)" : "var(--color-accent)",
        color: "#fff",
        fontSize: 16,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        fontFamily: "var(--font-ui)",
      }}
    >
      {children}
    </motion.button>
  );
});

/** Secondary button — outline style. */
export const SecondaryButton = memo(function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: "var(--tap-comfort)",
        padding: "0 24px",
        border: "1px solid var(--color-separator)",
        borderRadius: "var(--radius-md)",
        background: "transparent",
        color: "var(--color-text-primary)",
        fontSize: 16,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        fontFamily: "var(--font-ui)",
      }}
    >
      {children}
    </motion.button>
  );
});

/** Card container — grouped content surface. */
export const Card = memo(function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--color-bg-elevated)",
        borderRadius: "var(--radius-lg)",
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
});

/** List row — iOS settings style. */
export const Row = memo(function Row({
  icon,
  title,
  detail,
  trailing,
  onClick,
  danger,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  const Comp = onClick ? motion.button : motion.div;
  return (
    <Comp
      whileTap={onClick ? { scale: 0.99 } : undefined}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: "var(--tap-min)",
        padding: "12px 16px",
        border: "none",
        borderBottom: "1px solid var(--color-separator)",
        background: "transparent",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
        fontFamily: "var(--font-ui)",
      }}
    >
      {icon && (
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            borderRadius: 8,
            flexShrink: 0,
            color: "#fff",
            background: danger ? "var(--color-danger)" : "var(--color-accent)",
          }}
        >
          {icon}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            color: danger ? "var(--color-danger)" : "var(--color-text-primary)",
            fontWeight: 400,
          }}
        >
          {title}
        </div>
        {detail && (
          <div style={{ fontSize: 13, color: "var(--color-text-tertiary)", marginTop: 2 }}>
            {detail}
          </div>
        )}
      </div>
      {trailing}
    </Comp>
  );
});

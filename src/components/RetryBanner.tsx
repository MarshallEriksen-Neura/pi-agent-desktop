"use client";

import { motion, AnimatePresence } from "motion/react";
import { useEffect } from "react";
import { Square, X } from "lucide-react";
import { useChat } from "@/lib/pi/chat";
import { useT } from "@/lib/i18n";

/**
 * Inline retry status — rendered INSIDE the agent panel (above the composer),
 * not as a bottom-fixed toast. A loading retry exposes a Stop button so the
 * user can interrupt the in-flight request; success/error auto-dismiss.
 */
interface RetryBannerItemProps {
  id: string;
  type: "loading" | "success" | "error";
  message: string;
  onDismiss?: () => void;
  onStop?: () => void;
}

function RetryBannerItem({
  id,
  type,
  message,
  onDismiss,
  onStop,
}: RetryBannerItemProps) {
  const t = useT();
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Auto-dismiss success/error after 5s; loading stays until resolved.
  useEffect(() => {
    if (type === "loading" || !onDismiss) return;
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [type, onDismiss]);

  const accent =
    type === "loading"
      ? "var(--text-secondary)"
      : type === "success"
        ? "#28b463"
        : "#e74c3c";
  const bg =
    type === "loading"
      ? "var(--bg-base)"
      : type === "success"
        ? "rgba(40, 180, 99, 0.12)"
        : "rgba(231, 76, 60, 0.12)";
  const border =
    type === "loading"
      ? "var(--separator)"
      : type === "success"
        ? "rgba(40, 180, 99, 0.3)"
        : "rgba(231, 76, 60, 0.3)";

  return (
    <motion.div
      key={id}
      layout
      initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
      data-testid="retry-toast"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        marginBottom: 8,
        borderRadius: 10,
        background: bg,
        border: `1px solid ${border}`,
        fontSize: 12,
        color: "var(--text-primary)",
      }}
    >
      {/* status icon */}
      <div style={{ width: 16, height: 16, flexShrink: 0, color: accent }}>
        {type === "loading" ? (
          <motion.svg
            viewBox="0 0 20 20"
            fill="none"
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          >
            <circle
              cx="10"
              cy="10"
              r="8"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="12 38"
            />
          </motion.svg>
        ) : type === "success" ? (
          <svg viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" />
            <path
              d="M7 10l2 2 4-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" />
            <path
              d="M10 6v4m0 2v.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>{message}</div>

      {/* Stop the in-flight request during a retry */}
      {type === "loading" && onStop && (
        <button
          onClick={onStop}
          title={t("agent.stop")}
          aria-label={t("agent.stop")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
            border: "none",
            background: "var(--accent-muted)",
            color: "var(--accent)",
            cursor: "pointer",
            padding: "3px 8px",
            borderRadius: 6,
            fontSize: 11.5,
          }}
        >
          <Square size={11} />
          {t("agent.stop")}
        </button>
      )}

      {/* Dismiss success/error */}
      {type !== "loading" && onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            width: 18,
            height: 18,
            flexShrink: 0,
            border: "none",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          <X size={12} />
        </button>
      )}
    </motion.div>
  );
}

/**
 * Reads live retry state from the chat store and renders inline banners.
 * Placed above the composer inside the agent panel.
 */
export function RetryBanner() {
  const activeRetries = useChat((s) => s.activeRetries);
  const removeRetry = useChat((s) => s.removeRetry);
  const abort = useChat((s) => s.abort);
  const t = useT();

  const items = [...activeRetries.entries()].map(([id, state]) => {
    let message: string;
    if (state.status === "loading") {
      let head = t(
        state.scope === "summarization"
          ? "retry.summarizationInProgress"
          : "retry.inProgress",
        {
          attempt: state.attempt.toString(),
          max: state.maxAttempts.toString(),
        }
      );
      // pi restarts the attempt counter per request it retries, so a provider
      // that keeps refusing loops 1/3, 2/3, 1/3, … — say which round we are on
      // instead of looking stuck on the first attempt forever.
      if ((state.rounds ?? 1) > 1) {
        head += ` · ${t("retry.round", { rounds: String(state.rounds) })}`;
      }
      // `reason` on a loading retry is the upstream trigger
      // (auto_retry_start.errorMessage) — show it so a 429/529 is not reduced
      // to an anonymous spinner.
      message = state.reason ? `${head} — ${state.reason.slice(0, 90)}` : head;
    } else if (state.status === "success") {
      message = t("retry.success", { attempt: state.attempt.toString() });
    } else {
      message = t("retry.failed", {
        reason: (state.reason || "unknown").slice(0, 120),
      });
    }
    return { id, type: state.status, message };
  });

  return (
    <AnimatePresence mode="popLayout">
      {items.map((item) => (
        <RetryBannerItem
          key={item.id}
          id={item.id}
          type={item.type}
          message={item.message}
          onStop={item.type === "loading" ? abort : undefined}
          onDismiss={item.type !== "loading" ? () => removeRetry(item.id) : undefined}
        />
      ))}
    </AnimatePresence>
  );
}

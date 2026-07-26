"use client";

import { motion, AnimatePresence } from "motion/react";
import clsx from "clsx";
import { useEffect } from "react";

export interface RetryToastProps {
  type: "loading" | "success" | "error";
  message: string;
  onDismiss?: () => void;
  id: string;
}

/**
 * Simple native toast component for retry transparency.
 * No external libraries (sonner missing). Fixed bottom-right position with backdrop-blur.
 * Respects prefers-reduced-motion.
 */
export function RetryToast({ type, message, onDismiss, id }: RetryToastProps) {
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Auto-dismiss after 5s for success/error, manual for loading
  useEffect(() => {
    if (type === "loading" || !onDismiss) return;
    const timer = setTimeout(() => {
      onDismiss();
    }, 5000);
    return () => clearTimeout(timer);
  }, [type, onDismiss]);

  const bgColor =
    type === "loading"
      ? "var(--material-regular)"
      : type === "success"
        ? "rgba(40, 180, 99, 0.15)"
        : "rgba(231, 76, 60, 0.15)";

  const borderColor =
    type === "loading"
      ? "var(--separator)"
      : type === "success"
        ? "rgba(40, 180, 99, 0.3)"
        : "rgba(231, 76, 60, 0.3)";

  const iconColor =
    type === "loading"
      ? "var(--text-secondary)"
      : type === "success"
        ? "#28b463"
        : "#e74c3c";

  return (
    <motion.div
      key={id}
      initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 20 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.25 }}
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        minWidth: 320,
        maxWidth: 420,
        padding: "12px 16px",
        background: bgColor,
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
        color: "var(--text-primary)",
        zIndex: 9999,
      }}
      data-testid="retry-toast"
    >
      {/* Icon */}
      <div
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          color: iconColor,
        }}
      >
        {type === "loading" && (
          <motion.svg
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            animate={{ rotate: 360 }}
            transition={{
              duration: 1,
              repeat: Infinity,
              ease: "linear",
            }}
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
        )}
        {type === "success" && (
          <svg
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="10"
              cy="10"
              r="8"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M7 10l2 2 4-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {type === "error" && (
          <svg
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="10"
              cy="10"
              r="8"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M10 6v4m0 2v.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        )}
      </div>

      {/* Message */}
      <div style={{ flex: 1, lineHeight: 1.4 }}>{message}</div>

      {/* Dismiss button (only for non-loading) */}
      {type !== "loading" && onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            width: 20,
            height: 20,
            flexShrink: 0,
            border: "none",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-label="Dismiss"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M6 6l8 8m0-8l-8 8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </motion.div>
  );
}

/**
 * Toast container that renders multiple toasts stacked vertically.
 */
export interface ToastContainerProps {
  toasts: RetryToastProps[];
}

export function ToastContainer({ toasts }: ToastContainerProps) {
  return (
    <AnimatePresence mode="popLayout">
      {toasts.map((toast, idx) => (
        <motion.div
          key={toast.id}
          style={{
            position: "fixed",
            bottom: 24 + idx * 88,
            right: 24,
            zIndex: 9999,
          }}
          layout
        >
          <RetryToast {...toast} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

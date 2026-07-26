"use client";

import { useEffect, useState } from "react";
import { ToastContainer } from "@/components/RetryToast";
import type { RetryToastProps } from "@/components/RetryToast";
import { useChat } from "@/lib/pi/chat";
import { useT } from "@/lib/i18n";

/**
 * Retry toast manager - converts activeRetries Map into toast props array.
 * Renders ToastContainer with live retry state.
 */
export function RetryToastManager() {
  const activeRetries = useChat((s) => s.activeRetries);
  const removeRetry = useChat((s) => s.removeRetry);
  const t = useT();
  const [toasts, setToasts] = useState<RetryToastProps[]>([]);

  useEffect(() => {
    const toastArray: RetryToastProps[] = [];
    for (const [id, state] of activeRetries.entries()) {
      const message =
        state.status === "loading"
          ? t("retry.inProgress", {
              attempt: state.attempt.toString(),
              max: state.maxAttempts.toString(),
            })
          : state.status === "success"
            ? t("retry.success", { attempt: state.attempt.toString() })
            : t("retry.failed", { reason: state.reason || "unknown" });

      toastArray.push({
        id,
        type: state.status,
        message,
        onDismiss: state.status !== "loading" ? () => removeRetry(id) : undefined,
      });
    }
    setToasts(toastArray);
  }, [activeRetries, t, removeRetry]);

  return <ToastContainer toasts={toasts} />;
}

"use client";

import { useEffect, useState } from "react";
import { PillButton, StatusScreen } from "@/components/StatusScreen";
import { useT } from "@/lib/i18n";

/** Route error boundary — catches render crashes below the root layout. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // surface the crash in the webview console for diagnosis
    console.error(error);
  }, [error]);

  const detail =
    [
      error.message?.slice(0, 96),
      error.digest && `digest ${error.digest}`,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;

  const copyDetails = async () => {
    const text = [
      error.name,
      error.message,
      error.digest && `digest: ${error.digest}`,
      error.stack,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (webview permissions) — details stay in console
    }
  };

  return (
    <StatusScreen
      code="ERR"
      tone="danger"
      command="render view"
      result="view crashed"
      detail={detail}
      title={t("state.error.title")}
      body={t("state.error.body")}
    >
      <PillButton onClick={() => reset()}>{t("state.error.retry")}</PillButton>
      <PillButton variant="quiet" onClick={copyDetails}>
        {copied ? t("state.error.copied") : t("state.error.copy")}
      </PillButton>
    </StatusScreen>
  );
}

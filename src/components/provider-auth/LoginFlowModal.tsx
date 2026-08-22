"use client";

import { useEffect, useState } from "react";
import { Button } from "@appica/ui-react/button";
import { CircleCheck, ExternalLink, TriangleAlert } from "lucide-react";
import type { ActiveLogin } from "@/lib/provider-auth/store";
import { LOGIN_TIMEOUT } from "@/lib/provider-auth/store";
import { useT } from "@/lib/i18n";
import { CopyableValue } from "./primitives";

/**
 * Hosts one login flow.
 *
 * Every branch pi can drive is rendered here: a redirect URL, a device code
 * (GitHub Copilot's flow, which shows a user code instead of redirecting), a
 * free-text or secret prompt, a provider-authored choice list, progress lines,
 * success, and failure. The dialog stays open on success so the "restart pi for
 * the model list" note actually gets read.
 */
export function LoginFlowModal({
  active,
  providerName,
  onAnswer,
  onCancel,
  onDismiss,
  onOpenUrl,
}: {
  active: ActiveLogin;
  providerName: string;
  onAnswer: (value: string) => void;
  onCancel: () => void;
  onDismiss: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const terminal = active.phase === "done" || active.phase === "error";
  const prompt = active.prompt;

  // A new question must not inherit the previous answer.
  useEffect(() => {
    setDraft("");
  }, [prompt?.requestId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape abandons an in-flight login; once settled it just closes.
      if (terminal) onDismiss();
      else onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [terminal, onCancel, onDismiss]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={() => (terminal ? onDismiss() : onCancel())}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          maxHeight: "100%",
          overflowY: "auto",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15 }}>
          {t("providerAuth.dialogTitle", { provider: providerName })}
        </h3>

        {active.phase === "starting" && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
            {t("providerAuth.starting")}
          </p>
        )}

        {active.info && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p style={{ margin: 0, fontSize: 12 }}>{active.info.message}</p>
            {active.info.links?.map((link) => (
              <Button
                key={link.url}
                variant="ghost"
                size="sm"
                onClick={() => onOpenUrl(link.url)}
                style={{ alignSelf: "flex-start" }}
              >
                <ExternalLink size={13} />
                <span style={{ marginLeft: 6 }}>{link.label ?? link.url}</span>
              </Button>
            ))}
          </div>
        )}

        {active.authUrl && !terminal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 12 }}>{t("providerAuth.openedBrowser")}</p>
            <CopyableValue
              value={active.authUrl}
              copyLabel={t("providerAuth.copyUrl")}
              copiedLabel={t("providerAuth.copied")}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenUrl(active.authUrl ?? "")}
              style={{ alignSelf: "flex-start" }}
            >
              <ExternalLink size={13} />
              <span style={{ marginLeft: 6 }}>{t("providerAuth.openAgain")}</span>
            </Button>
          </div>
        )}

        {active.deviceCode && !terminal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 12 }}>
              {t("providerAuth.deviceCodeHint", {
                url: active.deviceCode.verificationUri,
              })}
            </p>
            <CopyableValue
              value={active.deviceCode.userCode}
              copyLabel={t("providerAuth.copyUrl")}
              copiedLabel={t("providerAuth.copied")}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpenUrl(active.deviceCode?.verificationUri ?? "")}
              style={{ alignSelf: "flex-start" }}
            >
              <ExternalLink size={13} />
              <span style={{ marginLeft: 6 }}>{t("providerAuth.openAgain")}</span>
            </Button>
          </div>
        )}

        {prompt?.type === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 12 }}>{prompt.message}</p>
            {prompt.options?.map((option) => (
              <Button
                key={option.id}
                variant="secondary"
                size="sm"
                disabled={active.answering}
                onClick={() => onAnswer(option.id)}
                style={{ justifyContent: "flex-start" }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}

        {prompt && prompt.type !== "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 12 }}>{prompt.message}</label>
            <input
              autoFocus
              type={prompt.type === "secret" ? "password" : "text"}
              value={draft}
              placeholder={prompt.placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter submits. Handled here rather than via a form, because
                // Button has no `type` prop so there is no native submit button.
                if (event.key !== "Enter" || active.answering) return;
                event.preventDefault();
                onAnswer(draft);
              }}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg)",
                color: "var(--text)",
                padding: "8px 10px",
                fontSize: 12,
              }}
            />
            {prompt.type === "manual_code" && (
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 11 }}>
                {t("providerAuth.manualHint")}
              </p>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={active.answering}
              onClick={() => onAnswer(draft)}
              style={{ alignSelf: "flex-start" }}
            >
              {t("providerAuth.submit")}
            </Button>
          </div>
        )}

        {active.progress && !terminal && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 11 }}>
            {active.progress}
          </p>
        )}

        {active.answering && !prompt && !terminal && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 11 }}>
            {t("providerAuth.finishing")}
          </p>
        )}

        {active.phase === "done" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "var(--accent)",
                fontSize: 12,
              }}
            >
              <CircleCheck size={14} />
              {t("providerAuth.success", { provider: providerName })}
            </span>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 11 }}>
              {t("providerAuth.successHint")}
            </p>
          </div>
        )}

        {active.phase === "error" && active.error && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "flex-start",
              gap: 6,
              color: "var(--danger, #e5484d)",
              fontSize: 12,
            }}
          >
            <TriangleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {active.error === LOGIN_TIMEOUT
              ? t("providerAuth.timedOut")
              : t("providerAuth.failed", { message: active.error })}
          </span>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={terminal ? onDismiss : onCancel}>
            {terminal ? t("common.close") : t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Button } from "@appica/ui-react/button";
import { KeyRound, LogIn } from "lucide-react";
import type { AuthProviderDto, ProviderAuthMethod } from "@/lib/backend/ports";
import { InsetGroup, GroupRow } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { StatusPill } from "./primitives";

/**
 * Providers whose row carries an extra caveat. Keyed by provider id; the value
 * is an i18n key. Only ids listed here render a note — `t()` falls back to the
 * key's last segment for unknown keys, so "render if it resolves" would print
 * junk like "xai".
 */
const PROVIDER_NOTE_KEYS: Record<string, string> = {
  anthropic: "providerAuth.note.anthropic",
};

/**
 * One provider row. A provider can offer both an OAuth flow and an API key
 * (Anthropic, OpenAI, xAI and OpenRouter all do), so the row may show two
 * sign-in affordances plus a sign-out.
 */
function ProviderRow({
  provider,
  busy,
  disabled,
  first,
  onLogin,
  onLogout,
}: {
  provider: AuthProviderDto;
  busy: boolean;
  disabled: boolean;
  first: boolean;
  onLogin: (method: ProviderAuthMethod) => void;
  onLogout: () => void;
}) {
  const t = useT();
  const stored = provider.storedCredentialType;
  const noteKey = PROVIDER_NOTE_KEYS[provider.id];
  const method = provider.oauth?.name ?? provider.apiKey?.name ?? provider.id;

  return (
    <GroupRow
      first={first}
      title={provider.name}
      detail={noteKey ? `${method} — ${t(noteKey)}` : method}
      trailing={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <StatusPill tone={stored ? "signed-in" : "idle"}>
            {stored === "oauth"
              ? t("providerAuth.signedIn")
              : stored === "api_key"
                ? t("providerAuth.keySaved")
                : t("providerAuth.notSignedIn")}
          </StatusPill>

          {provider.oauth && (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || busy}
              onClick={() => onLogin("oauth")}
            >
              <LogIn size={13} />
              <span style={{ marginLeft: 6 }}>
                {provider.oauth.loginLabel ?? t("providerAuth.signIn")}
              </span>
            </Button>
          )}

          {provider.apiKey && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => onLogin("api_key")}
            >
              <KeyRound size={13} />
              <span style={{ marginLeft: 6 }}>{t("providerAuth.useApiKey")}</span>
            </Button>
          )}

          {stored && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={onLogout}
            >
              {t("providerAuth.signOut")}
            </Button>
          )}
        </div>
      }
    />
  );
}

/**
 * Providers split into subscription-backed logins and plain API keys.
 *
 * The split matters: a subscription sign-in spends a plan the user already pays
 * for, while an API key is billed per token. One flat list would bury that.
 */
export function ProviderListGroup({
  providers,
  loggingOut,
  disabled,
  onLogin,
  onLogout,
}: {
  providers: AuthProviderDto[];
  loggingOut: string | null;
  disabled: boolean;
  onLogin: (providerId: string, method: ProviderAuthMethod) => void;
  onLogout: (providerId: string) => void;
}) {
  const t = useT();
  const subscriptions = providers.filter((provider) => provider.oauth);
  const apiKeyOnly = providers.filter((provider) => !provider.oauth);

  const row = (provider: AuthProviderDto, index: number) => (
    <ProviderRow
      key={provider.id}
      provider={provider}
      busy={loggingOut === provider.id}
      disabled={disabled}
      first={index === 0}
      onLogin={(method) => onLogin(provider.id, method)}
      onLogout={() => onLogout(provider.id)}
    />
  );

  return (
    <>
      {subscriptions.length > 0 && (
        <InsetGroup
          header={t("providerAuth.subscriptions")}
          footer={t("providerAuth.subscriptionsFooter")}
        >
          {subscriptions.map(row)}
        </InsetGroup>
      )}
      {apiKeyOnly.length > 0 && (
        <InsetGroup
          header={t("providerAuth.apiKeys")}
          footer={t("providerAuth.apiKeysFooter")}
        >
          {apiKeyOnly.map(row)}
        </InsetGroup>
      )}
    </>
  );
}

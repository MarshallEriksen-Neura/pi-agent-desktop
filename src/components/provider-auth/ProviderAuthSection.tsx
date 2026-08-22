"use client";

import { memo, useCallback, useEffect } from "react";
import type { ProviderAuthMethod } from "@/lib/backend/ports";
import { getPort } from "@/lib/backend/composition/container";
import { useProviderAuth } from "@/lib/provider-auth/store";
import { InsetGroup } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { ProviderListGroup } from "./ProviderListGroup";
import { LoginFlowModal } from "./LoginFlowModal";
import { WslNoticeGroup } from "./WslNoticeGroup";

/**
 * Composition root for the Accounts settings surface.
 *
 * Owns two things the presentational groups should not: the event subscription
 * (established before the first `refresh` so a fast flow cannot emit into a void)
 * and opening the authorization URL in the user's browser.
 */
export const ProviderAuthSection = memo(function ProviderAuthSection() {
  const t = useT();
  const providers = useProviderAuth((s) => s.providers);
  const loading = useProviderAuth((s) => s.loading);
  const lastError = useProviderAuth((s) => s.lastError);
  const wslUnsupported = useProviderAuth((s) => s.wslUnsupported);
  const loggingOut = useProviderAuth((s) => s.loggingOut);
  const active = useProviderAuth((s) => s.active);
  const refresh = useProviderAuth((s) => s.refresh);
  const subscribe = useProviderAuth((s) => s.subscribe);
  const beginLogin = useProviderAuth((s) => s.beginLogin);
  const submitAnswer = useProviderAuth((s) => s.submitAnswer);
  const cancelLogin = useProviderAuth((s) => s.cancelLogin);
  const dismissLogin = useProviderAuth((s) => s.dismissLogin);
  const logout = useProviderAuth((s) => s.logout);

  useEffect(() => {
    const unsubscribe = subscribe();
    void refresh();
    return unsubscribe;
  }, [subscribe, refresh]);

  const openUrl = useCallback((url: string) => {
    if (!url) return;
    void getPort("externalNavigation").open(url);
  }, []);

  // Open the authorization page as soon as pi hands one over. The URL stays in
  // the dialog so a failed hand-off can be retried or copied to another machine.
  const authUrl = active?.authUrl ?? null;
  useEffect(() => {
    if (authUrl) openUrl(authUrl);
  }, [authUrl, openUrl]);

  const onLogin = useCallback(
    (providerId: string, method: ProviderAuthMethod) => {
      void beginLogin(providerId, method);
    },
    [beginLogin]
  );

  const activeProvider = providers.find((provider) => provider.id === active?.providerId);

  return (
    <>
      {wslUnsupported && <WslNoticeGroup />}

      {lastError && (
        <InsetGroup>
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--danger, #e5484d)" }}>
            {t("providerAuth.loadFailed", { message: lastError })}
          </div>
        </InsetGroup>
      )}

      {!loading && providers.length === 0 && !lastError && (
        <InsetGroup>
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)" }}>
            {t("providerAuth.empty")}
          </div>
        </InsetGroup>
      )}

      {loading ? (
        <InsetGroup>
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)" }}>
            {t("common.loading")}
          </div>
        </InsetGroup>
      ) : (
        <ProviderListGroup
          providers={providers}
          loggingOut={loggingOut}
          disabled={wslUnsupported || active !== null}
          onLogin={onLogin}
          onLogout={(providerId) => void logout(providerId)}
        />
      )}

      {active && (
        <LoginFlowModal
          active={active}
          providerName={activeProvider?.name ?? active.providerId}
          onAnswer={(value) => void submitAnswer(value)}
          onCancel={() => void cancelLogin()}
          onDismiss={dismissLogin}
          onOpenUrl={openUrl}
        />
      )}
    </>
  );
});

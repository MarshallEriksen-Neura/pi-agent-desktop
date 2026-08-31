"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@appica/ui-react/button";
import {
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { getPort } from "@/lib/backend/composition/container";
import type { RemotePiProfile } from "@/lib/backend/ports/execution-target";
import type {
  PreparedProviderSync,
  ProviderCredentialAction,
  ProviderCredentialSource,
  ProviderSyncBlockedReason,
  ProviderSyncCandidate,
  ProviderSyncResult,
  ProviderSyncWarningCode,
} from "@/lib/backend/ports/remote-provider-sync";
import { t } from "@/lib/i18n";
import { GroupRow, InsetGroup } from "./settings-ui";

const PROVIDER_SYNC_ERROR_CODES = new Set([
  "providerSelectionEmpty",
  "providerSelectionTooLarge",
  "providerIdInvalid",
  "providerIdDuplicate",
  "providerNotFound",
  "commandCredentialUnsupported",
  "commandHeaderUnsupported",
  "invalidProviderDefinition",
  "localModelsInvalid",
  "localAuthInvalid",
  "remoteModelsInvalid",
  "remoteAuthInvalid",
  "remoteProfileNotFound",
  "remoteProfileChanged",
  "launcherSyncUnsupported",
  "syncProtocolUnsupported",
  "syncPayloadInvalid",
  "syncPayloadTooLarge",
  "syncBusy",
  "syncPlanMissing",
  "syncPlanExpired",
  "syncPlanStale",
  "configLockTimeout",
  "remoteConfigSymlinkRejected",
  "remoteConfigTooLarge",
  "remoteRecoveryRequired",
  "remoteRollbackFailed",
  "remoteWriteFailed",
  "ssh_spawn_failed",
  "ssh_timeout",
  "ssh_failed",
  "ssh_auth_failed",
  "ssh_host_key",
  "ssh_host_unknown",
  "ssh_unreachable",
]);

function providerSyncErrorText(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
  return PROVIDER_SYNC_ERROR_CODES.has(raw)
    ? t(`settings.remoteAgent.providerSync.error.${raw}`)
    : t("settings.remoteAgent.providerSync.error.generic");
}

function credentialSourceLabel(source: ProviderCredentialSource): string {
  return t(`settings.remoteAgent.providerSync.credentialSource.${source}`);
}

function credentialActionLabel(action: ProviderCredentialAction): string {
  return t(`settings.remoteAgent.providerSync.credentialAction.${action}`);
}

function warningLabel(warning: ProviderSyncWarningCode): string {
  return t(`settings.remoteAgent.providerSync.warning.${warning}`);
}

function blockedReasonLabel(reason: ProviderSyncBlockedReason): string {
  return t(`settings.remoteAgent.providerSync.blocked.${reason}`);
}

export function ProviderSyncSettings({ profiles }: { profiles: RemotePiProfile[] }) {
  const syncPort = getPort("remoteProviderSync");
  const [profileId, setProfileId] = useState("");
  const [candidates, setCandidates] = useState<ProviderSyncCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreparedProviderSync | null>(null);
  const [result, setResult] = useState<ProviderSyncResult | null>(null);
  const [apiKeyConfirmed, setApiKeyConfirmed] = useState(false);
  const [syncBusy, setSyncBusy] = useState<"load" | "prepare" | "apply" | null>(null);
  const [syncNotice, setSyncNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCandidates = useCallback(async () => {
    setSyncBusy("load");
    setSyncNotice(null);
    try {
      const next = await syncPort.listCandidates();
      setCandidates(next);
      setSelectedIds((current) => {
        const selectable = new Set(next.filter((item) => item.syncable).map((item) => item.providerId));
        return current.filter((id) => selectable.has(id));
      });
    } catch (error) {
      setCandidates([]);
      setSelectedIds([]);
      setSyncNotice({ ok: false, text: providerSyncErrorText(error) });
    } finally {
      setSyncBusy(null);
    }
  }, [syncPort]);

  useEffect(() => {
    if (profiles.length === 0) {
      setProfileId("");
      setCandidates([]);
      setSelectedIds([]);
      setPreview(null);
      setResult(null);
      return;
    }
    setProfileId((current) => profiles.some((profile) => profile.id === current)
      ? current
      : profiles[0].id);
    void loadCandidates();
  }, [loadCandidates, profiles]);

  const invalidatePreparedPlan = () => {
    setPreview(null);
    setResult(null);
    setApiKeyConfirmed(false);
    setSyncNotice(null);
  };

  const toggleProvider = (providerId: string, checked: boolean) => {
    invalidatePreparedPlan();
    setSelectedIds((current) => checked
      ? [...current, providerId]
      : current.filter((id) => id !== providerId));
  };

  const prepareSync = async () => {
    if (!profileId || selectedIds.length === 0) return;
    setSyncBusy("prepare");
    setSyncNotice(null);
    setResult(null);
    try {
      const next = await syncPort.prepare(profileId, selectedIds);
      setPreview(next);
      setApiKeyConfirmed(false);
    } catch (error) {
      setPreview(null);
      setSyncNotice({ ok: false, text: providerSyncErrorText(error) });
    } finally {
      setSyncBusy(null);
    }
  };

  const applySync = async () => {
    if (!preview) return;
    const providerIds = preview.providers.map((provider) => provider.providerId);
    const requiresApiKeyConfirmation = preview.providers.some(
      (provider) => provider.credentialAction === "willInstallApiKey",
    );
    if (requiresApiKeyConfirmation && !apiKeyConfirmed) return;
    setSyncBusy("apply");
    setSyncNotice(null);
    try {
      const next = await syncPort.apply(preview.profileId, providerIds);
      setResult(next);
      setPreview(null);
      setSelectedIds([]);
      setApiKeyConfirmed(false);
      setSyncNotice({ ok: true, text: t("settings.remoteAgent.providerSync.applied") });
      await loadCandidates();
    } catch (error) {
      setPreview(null);
      setApiKeyConfirmed(false);
      setSyncNotice({ ok: false, text: providerSyncErrorText(error) });
    } finally {
      setSyncBusy(null);
    }
  };

  const requiresApiKeyConfirmation = preview?.providers.some(
    (provider) => provider.credentialAction === "willInstallApiKey",
  ) ?? false;
  const selectedCount = selectedIds.length;

  return (
    <InsetGroup
      header={t("settings.remoteAgent.providerSync.title")}
      footer={t("settings.remoteAgent.providerSync.footer")}
    >
      {profiles.length === 0 ? (
        <GroupRow
          first
          icon={<ShieldCheck size={16} />}
          iconBg="var(--bg-secondary)"
          title={t("settings.remoteAgent.providerSync.noProfile")}
          detail={t("settings.remoteAgent.providerSync.noProfileDetail")}
        />
      ) : (
        <div style={{ display: "grid", gap: 14, padding: 16 }}>
          <FieldShell
            label={t("settings.remoteAgent.providerSync.destination")}
            hint={t("settings.remoteAgent.providerSync.destinationHint")}
          >
            <select
              value={profileId}
              disabled={syncBusy !== null || preview !== null}
              onChange={(event) => {
                setProfileId(event.target.value);
                invalidatePreparedPlan();
              }}
              style={{
                width: "100%",
                height: 36,
                padding: "0 10px",
                color: "var(--text-primary)",
                background: "var(--bg-primary)",
                border: "1px solid var(--separator)",
                borderRadius: 8,
                font: "inherit",
                fontSize: 13,
              }}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.sshHost}
                </option>
              ))}
            </select>
          </FieldShell>

          <fieldset
            disabled={syncBusy !== null || preview !== null}
            style={{ display: "grid", gap: 0, minWidth: 0, padding: 0, border: 0, margin: 0 }}
          >
            <legend style={{ padding: 0, marginBottom: 6, color: "var(--text-secondary)", fontSize: 12, fontWeight: 600 }}>
              {t("settings.remoteAgent.providerSync.providers")}
            </legend>
            {syncBusy === "load" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0", color: "var(--text-tertiary)", fontSize: 12 }}>
                <LoaderCircle size={14} className="animate-spin" />
                {t("settings.remoteAgent.providerSync.loading")}
              </div>
            ) : candidates.length === 0 ? (
              <div style={{ padding: "12px 0", color: "var(--text-tertiary)", fontSize: 12 }}>
                {t("settings.remoteAgent.providerSync.empty")}
              </div>
            ) : candidates.map((candidate, index) => {
              const checked = selectedIds.includes(candidate.providerId);
              return (
                <label
                  key={candidate.providerId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "18px minmax(0, 1fr)",
                    gap: 9,
                    padding: "10px 0",
                    borderTop: index === 0 ? "none" : "1px solid var(--separator)",
                    cursor: candidate.syncable ? "pointer" : "not-allowed",
                    opacity: candidate.syncable ? 1 : 0.62,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!candidate.syncable}
                    onChange={(event) => toggleProvider(candidate.providerId, event.target.checked)}
                    style={{ width: 15, height: 15, margin: "2px 0 0", accentColor: "var(--accent)" }}
                  />
                  <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
                      <strong style={{ color: "var(--text-primary)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {candidate.providerId}
                      </strong>
                      <span style={{ color: "var(--text-tertiary)", fontSize: 11.5, flexShrink: 0 }}>
                        {t("settings.remoteAgent.providerSync.modelCount", { count: candidate.modelCount })}
                      </span>
                    </span>
                    <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                      {credentialSourceLabel(candidate.credentialSource)}
                    </span>
                    {!candidate.syncable && candidate.blockedReason ? (
                      <span style={{ color: "var(--danger)", fontSize: 11.5 }}>
                        {blockedReasonLabel(candidate.blockedReason)}
                      </span>
                    ) : null}
                    {candidate.warnings.map((warning) => (
                      <span key={warning} style={{ color: "var(--warning)", fontSize: 11.5 }}>
                        {warningLabel(warning)}
                      </span>
                    ))}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {preview ? (
            <div style={{ display: "grid", gap: 10, paddingTop: 2 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <ShieldCheck size={16} style={{ color: "var(--accent)", marginTop: 1, flexShrink: 0 }} />
                <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
                    {t("settings.remoteAgent.providerSync.previewTitle")}
                  </strong>
                  <span style={{ color: "var(--text-tertiary)", fontSize: 11.5 }}>
                    {t("settings.remoteAgent.providerSync.previewDestination", {
                      name: preview.destinationDisplayName,
                      host: preview.destinationHostAlias,
                    })}
                  </span>
                </span>
              </div>
              <div style={{ display: "grid", gap: 0, borderTop: "1px solid var(--separator)" }}>
                {preview.providers.map((provider) => (
                  <div key={provider.providerId} style={{ display: "grid", gap: 4, padding: "9px 0", borderBottom: "1px solid var(--separator)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>{provider.providerId}</strong>
                      <span style={{ color: "var(--text-tertiary)", fontSize: 11.5, textAlign: "right" }}>
                        {t(`settings.remoteAgent.providerSync.configAction.${provider.configAction}`)} · {credentialActionLabel(provider.credentialAction)}
                      </span>
                    </div>
                    {provider.warnings.map((warning) => (
                      <span key={warning} style={{ color: "var(--warning)", fontSize: 11.5 }}>
                        {warningLabel(warning)}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              {requiresApiKeyConfirmation ? (
                <label style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr)", gap: 8, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={apiKeyConfirmed}
                    onChange={(event) => setApiKeyConfirmed(event.target.checked)}
                    style={{ width: 15, height: 15, margin: "2px 0 0", accentColor: "var(--accent)" }}
                  />
                  <span>{t("settings.remoteAgent.providerSync.confirmApiKeys")}</span>
                </label>
              ) : null}
            </div>
          ) : null}

          {result ? (
            <Callout icon={<CheckCircle2 size={15} />} tone="var(--success)">
              {t("settings.remoteAgent.providerSync.result", { count: result.providers.length })}
            </Callout>
          ) : null}
          {syncNotice ? (
            <Callout
              icon={syncNotice.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              tone={syncNotice.ok ? "var(--success)" : "var(--danger)"}
            >
              {syncNotice.text}
            </Callout>
          ) : null}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Button
              variant="ghost"
              size="sm"
              disabled={syncBusy !== null || preview !== null}
              onClick={() => void loadCandidates()}
            >
              <RefreshCw size={14} className={syncBusy === "load" ? "animate-spin" : undefined} />
              {t("settings.remoteAgent.providerSync.refresh")}
            </Button>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              {preview ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={syncBusy !== null}
                  onClick={() => { setPreview(null); setApiKeyConfirmed(false); }}
                >
                  {t("common.cancel")}
                </Button>
              ) : null}
              {preview ? (
                <Button
                  size="sm"
                  disabled={syncBusy !== null || (requiresApiKeyConfirmation && !apiKeyConfirmed)}
                  onClick={() => void applySync()}
                >
                  {syncBusy === "apply" ? <LoaderCircle size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {t("settings.remoteAgent.providerSync.apply")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!profileId || selectedCount === 0 || syncBusy !== null}
                  onClick={() => void prepareSync()}
                >
                  {syncBusy === "prepare" ? <LoaderCircle size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {t("settings.remoteAgent.providerSync.review", { count: selectedCount })}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </InsetGroup>
  );
}

function FieldShell({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <span style={{ color: "var(--text-secondary)", fontSize: 12, fontWeight: 600 }}>{label}</span>
      {children}
      {hint && (
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{hint}</span>
      )}
    </div>
  );
}

function Callout({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        color: tone,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

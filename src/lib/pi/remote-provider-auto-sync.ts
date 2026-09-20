"use client";

import { getBackendKind, getPort } from "../backend/composition/container";
import type { ProviderSyncResult, RemoteProviderSyncPort } from "../backend/ports/remote-provider-sync";
import { t } from "../i18n";
import { useExtUi } from "./ext-ui";

export const AUTO_PROVIDER_SYNC_STORAGE_KEY = "pi-desktop.remote-provider-auto-sync.v1";

export interface AutoProviderSyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type AutoSyncLinks = Record<string, string[]>;

export interface AutoProviderSyncOutcome {
  profileId: string;
  providerIds: string[];
  ok: boolean;
  result?: ProviderSyncResult;
  error?: unknown;
}

function browserStorage(): AutoProviderSyncStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function readLinks(storage: AutoProviderSyncStorage | null = browserStorage()): AutoSyncLinks {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(AUTO_PROVIDER_SYNC_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([profileId, ids]) => profileId.length > 0 && Array.isArray(ids))
        .map(([profileId, ids]) => [
          profileId,
          [...new Set(ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0))],
        ])
        .filter(([, ids]) => ids.length > 0),
    );
  } catch {
    return {};
  }
}
export function getAutomaticProviderSyncProviderIds(
  profileId: string,
  storage: AutoProviderSyncStorage | null = browserStorage(),
): string[] {
  return readLinks(storage)[profileId] ?? [];
}

/** Remember provider/profile pairs only after the user completes a manual sync. */
export function setAutomaticProviderSync(
  profileId: string,
  providerIds: string[],
  enabled: boolean,
  storage: AutoProviderSyncStorage | null = browserStorage(),
): void {
  if (!storage || !profileId || providerIds.length === 0) return;
  const links = readLinks(storage);
  const ids = new Set(links[profileId] ?? []);
  for (const providerId of providerIds) {
    if (enabled) ids.add(providerId);
    else ids.delete(providerId);
  }
  if (ids.size > 0) links[profileId] = [...ids].sort();
  else delete links[profileId];
  try {
    if (Object.keys(links).length > 0) {
      storage.setItem(AUTO_PROVIDER_SYNC_STORAGE_KEY, JSON.stringify(links));
    } else {
      storage.removeItem(AUTO_PROVIDER_SYNC_STORAGE_KEY);
    }
  } catch {
    // Storage is only the non-secret link registry; a manual sync still works.
  }
}

export function removeAutomaticProviderSyncProviders(
  providerIds: string[],
  storage: AutoProviderSyncStorage | null = browserStorage(),
): void {
  if (!storage || providerIds.length === 0) return;
  for (const profileId of Object.keys(readLinks(storage))) {
    setAutomaticProviderSync(profileId, providerIds, false, storage);
  }
}

export async function runAutomaticProviderSync(
  changedProviderIds: string[],
  port: RemoteProviderSyncPort,
  storage: AutoProviderSyncStorage | null = browserStorage(),
): Promise<AutoProviderSyncOutcome[]> {
  const changed = new Set(changedProviderIds);
  const outcomes: AutoProviderSyncOutcome[] = [];
  for (const [profileId, linkedIds] of Object.entries(readLinks(storage))) {
    const providerIds = linkedIds.filter((id) => changed.has(id));
    if (providerIds.length === 0) continue;
    try {
      const result = await port.applyAutomatic(profileId, providerIds);
      outcomes.push({ profileId, providerIds, ok: true, result });
    } catch (error) {
      const code = error instanceof Error ? error.message.replace(/^Error:\s*/, "") : String(error);
      if (code === "remoteProfileNotFound") {
        setAutomaticProviderSync(profileId, linkedIds, false, storage);
      }
      outcomes.push({ profileId, providerIds, ok: false, error });
    }
  }
  return outcomes;
}

let automaticSyncQueue = Promise.resolve();
let automaticSyncTimer: ReturnType<typeof setTimeout> | null = null;
const pendingProviderIds = new Set<string>();

/** Queue SSH work after models.json is safely persisted, coalescing rapid edits. */
export function queueAutomaticProviderSync(changedProviderIds: string[]): void {
  if (changedProviderIds.length === 0 || getBackendKind() !== "desktop-tauri") return;
  changedProviderIds.forEach((id) => pendingProviderIds.add(id));
  if (automaticSyncTimer) clearTimeout(automaticSyncTimer);
  automaticSyncTimer = setTimeout(() => {
    const providerIds = [...pendingProviderIds];
    pendingProviderIds.clear();
    automaticSyncTimer = null;
    automaticSyncQueue = automaticSyncQueue.then(async () => {
      const outcomes = await runAutomaticProviderSync(
        providerIds,
        getPort("remoteProviderSync"),
      );
      for (const outcome of outcomes) {
        if (outcome.ok) {
          useExtUi.getState().pushToast(
            outcome.result?.providers.some(
              (provider) => provider.credentialAction === "remoteCredentialPreserved",
            )
              ? t("settings.remoteAgent.providerSync.autoAppliedCredentialPreserved")
              : t("settings.remoteAgent.providerSync.autoApplied"),
            "info",
            5000,
          );
          continue;
        }
        const raw = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        useExtUi.getState().pushToast(
          raw.replace(/^Error:\s*/, "") === "syncApprovalRequired"
            ? t("settings.remoteAgent.providerSync.autoApprovalRequired")
            : t("settings.remoteAgent.providerSync.autoFailed"),
          "warning",
          7000,
        );
      }
    });
  }, 300);
}

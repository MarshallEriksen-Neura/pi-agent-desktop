"use client";

import { getBackendKind, getPort } from "../backend/composition/container";
import type { ProviderSyncResult, RemoteProviderScope, RemoteProviderSyncPort } from "../backend/ports/remote-provider-sync";
import { t } from "../i18n";
import { useExtUi } from "./ext-ui";

export const AUTO_PROVIDER_SYNC_STORAGE_KEY = "pi-desktop.remote-provider-auto-sync.v1";

export interface AutoProviderSyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type AutoSyncScopes = Partial<Record<RemoteProviderScope, string[]>>;
type AutoSyncLinks = Record<string, AutoSyncScopes>;

export interface AutoProviderSyncOutcome {
  profileId: string;
  scope: RemoteProviderScope;
  providerIds: string[];
  ok: boolean;
  result?: ProviderSyncResult;
  error?: unknown;
}

function browserStorage(): AutoProviderSyncStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}


function cleanIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id: unknown): id is string => typeof id === "string" && id.length > 0))]
    : [];
}

function readLinks(storage: AutoProviderSyncStorage | null = browserStorage()): AutoSyncLinks {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(AUTO_PROVIDER_SYNC_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const links: AutoSyncLinks = {};
    for (const [profileId, value] of Object.entries(parsed)) {
      if (!profileId) continue;
      // v1 stored a bare provider-id array; keep those links as global.
      if (Array.isArray(value)) {
        const ids = cleanIds(value);
        if (ids.length > 0) links[profileId] = { global: ids };
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const scopes: AutoSyncScopes = {};
      for (const scope of ["global", "project"] as const) {
        const ids = cleanIds((value as Record<string, unknown>)[scope]);
        if (ids.length > 0) scopes[scope] = ids;
      }
      if (Object.keys(scopes).length > 0) links[profileId] = scopes;
    }
    return links;
  } catch {
    return {};
  }
}

export function getAutomaticProviderSyncProviderIds(
  profileId: string,
  storage: AutoProviderSyncStorage | null = browserStorage(),
  scope: RemoteProviderScope = "global",
): string[] {
  return readLinks(storage)[profileId]?.[scope] ?? [];
}

/** Remember provider/profile/scope links only after the user completes a manual sync. */
export function setAutomaticProviderSync(
  profileId: string,
  providerIds: string[],
  enabled: boolean,
  storage: AutoProviderSyncStorage | null = browserStorage(),
  scope: RemoteProviderScope = "global",
): void {
  if (!storage || !profileId || providerIds.length === 0) return;
  const links = readLinks(storage);
  const ids = new Set(links[profileId]?.[scope] ?? []);
  for (const providerId of providerIds) {
    if (enabled) ids.add(providerId);
    else ids.delete(providerId);
  }
  const nextIds = [...ids].sort();
  if (nextIds.length > 0) {
    links[profileId] = { ...(links[profileId] ?? {}), [scope]: nextIds };
  } else if (links[profileId]) {
    const { [scope]: _removed, ...remaining } = links[profileId] as AutoSyncScopes;
    if (Object.keys(remaining).length > 0) links[profileId] = remaining;
    else delete links[profileId];
  }
  try {
    if (Object.keys(links).length > 0) storage.setItem(AUTO_PROVIDER_SYNC_STORAGE_KEY, JSON.stringify(links));
    else storage.removeItem(AUTO_PROVIDER_SYNC_STORAGE_KEY);
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
    for (const scope of ["global", "project"] as const) {
      setAutomaticProviderSync(profileId, providerIds, false, storage, scope);
    }
  }
}

export async function runAutomaticProviderSync(
  changedProviderIds: string[],
  port: RemoteProviderSyncPort,
  storage: AutoProviderSyncStorage | null = browserStorage(),
): Promise<AutoProviderSyncOutcome[]> {
  const changed = new Set(changedProviderIds);
  const outcomes: AutoProviderSyncOutcome[] = [];
  for (const [profileId, scopes] of Object.entries(readLinks(storage))) {
    for (const scope of ["global", "project"] as const) {
      const providerIds = (scopes[scope] ?? []).filter((id) => changed.has(id));
      if (providerIds.length === 0) continue;
      try {
        const result = await port.applyAutomatic(profileId, providerIds, scope);
        outcomes.push({ profileId, scope, providerIds, ok: true, result });
      } catch (error) {
        const code = error instanceof Error ? error.message.replace(/^Error:\s*/, "") : String(error);
        if (code === "remoteProfileNotFound") {
          setAutomaticProviderSync(profileId, scopes[scope] ?? [], false, storage, scope);
        }
        outcomes.push({ profileId, scope, providerIds, ok: false, error });
      }
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
      const outcomes = await runAutomaticProviderSync(providerIds, getPort("remoteProviderSync"));
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
        useExtUi.getState().pushToast(
          t("settings.remoteAgent.providerSync.autoFailed"),
          "warning",
          7000,
        );
      }
    });
  }, 300);
}

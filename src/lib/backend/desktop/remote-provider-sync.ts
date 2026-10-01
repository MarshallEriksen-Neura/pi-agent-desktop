import { desktopInvoke } from "./invoke";
import type {
  PreparedProviderSync,
  ProviderSyncCandidate,
  ProviderSyncResult,
  RemoteProviderSyncPort,
} from "../ports/remote-provider-sync";

/** Desktop adapter: Rust owns all provider definitions, credentials, and plans. */
export const desktopRemoteProviderSyncPort: RemoteProviderSyncPort = {
  listCandidates: () => desktopInvoke<ProviderSyncCandidate[]>("remote_provider_sync_candidates"),
  prepare: (profileId, providerIds, scope = "global") =>
    desktopInvoke<PreparedProviderSync>("remote_provider_sync_prepare", { profileId, providerIds, scope }),
  apply: (profileId, providerIds, scope = "global") =>
    desktopInvoke<ProviderSyncResult>("remote_provider_sync_apply", { profileId, providerIds, scope }),
  applyAutomatic: (profileId, providerIds, scope = "global") =>
    desktopInvoke<ProviderSyncResult>("remote_provider_sync_apply_automatic", {
      profileId,
      providerIds,
      scope,
    }),
};

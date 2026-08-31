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
  prepare: (profileId, providerIds) =>
    desktopInvoke<PreparedProviderSync>("remote_provider_sync_prepare", { profileId, providerIds }),
  apply: (profileId, providerIds) =>
    desktopInvoke<ProviderSyncResult>("remote_provider_sync_apply", { profileId, providerIds }),
};

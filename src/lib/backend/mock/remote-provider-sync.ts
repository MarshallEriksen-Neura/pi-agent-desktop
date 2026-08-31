import type {
  PreparedProviderSync,
  ProviderSyncCandidate,
  ProviderSyncResult,
  RemoteProviderSyncPort,
} from "../ports/remote-provider-sync";

/** Browser preview cannot inspect local Pi files or reach an SSH host. */
export const mockRemoteProviderSyncPort: RemoteProviderSyncPort = {
  listCandidates: async (): Promise<ProviderSyncCandidate[]> => [],
  prepare: async (_profileId: string, _providerIds: string[]): Promise<PreparedProviderSync> => {
    throw new Error("Remote provider synchronization is available in the desktop app only.");
  },
  apply: async (_profileId: string, _providerIds: string[]): Promise<ProviderSyncResult> => {
    throw new Error("Remote provider synchronization is available in the desktop app only.");
  },
};

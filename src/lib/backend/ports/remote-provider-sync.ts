/**
 * Redacted frontend contract for synchronizing selected local custom Pi
 * providers to a stored SSH profile.
 *
 * React may submit only profile/provider identifiers. Provider definitions,
 * credentials, paths, SSH options, launcher arguments, and overwrite flags are
 * backend-owned and must never cross this port toward Rust.
 */

export type ProviderCredentialSource =
  | "authApiKey"
  | "modelsApiKey"
  | "environmentReference"
  | "providerEnvironment"
  | "oauth"
  | "unknownAuth"
  | "none";

export type ProviderCredentialAction =
  | "willInstallApiKey"
  | "willInstallEnvironmentReference"
  | "providerEnvironmentNotTransferred"
  | "remoteCredentialPreserved"
  | "oauthNotTransferable"
  | "unknownCredentialNotTransferable"
  | "noCredential";

export type ProviderSyncWarningCode =
  | "environmentReferenceRequiresRemoteValue"
  | "loopbackEndpointRefersToRemoteHost"
  | "endpointMayContainCredentials"
  | "literalHeaderValuesTransferred"
  | "environmentHeaderRequiresRemoteValue"
  | "providerEnvironmentNotTransferred"
  | "remoteProviderWillBeReplaced"
  | "remoteCredentialPreserved"
  | "remoteReloadRequired";

export type ProviderSyncBlockedReason =
  | "commandCredentialUnsupported"
  | "commandHeaderUnsupported"
  | "invalidProviderDefinition";

/** A local provider summary. This DTO must remain credential-free. */
export interface ProviderSyncCandidate {
  providerId: string;
  modelCount: number;
  syncable: boolean;
  blockedReason?: ProviderSyncBlockedReason;
  credentialSource: ProviderCredentialSource;
  warnings: ProviderSyncWarningCode[];
}

export interface PreparedProviderSyncProvider {
  providerId: string;
  modelCount: number;
  configAction: "create" | "replace";
  credentialAction: ProviderCredentialAction;
  warnings: ProviderSyncWarningCode[];
}

/**
 * A short-lived redacted preview of a backend-held plan. The plan is keyed by
 * profileId plus the canonical sorted providerIds and is single-use.
 */
export interface PreparedProviderSync {
  profileId: string;
  profileRevision: number;
  destinationDisplayName: string;
  destinationHostAlias: string;
  providers: PreparedProviderSyncProvider[];
  expiresAt: number;
}

export interface AppliedProviderSyncProvider {
  providerId: string;
  configUpdated: boolean;
  credentialAction: ProviderCredentialAction;
  warnings: ProviderSyncWarningCode[];
}

export interface ProviderSyncResult {
  profileId: string;
  providers: AppliedProviderSyncProvider[];
  reloadRequired: true;
}

export interface RemoteProviderSyncPort {
  /** Lists custom providers from authoritative local models.json/auth.json. */
  listCandidates(): Promise<ProviderSyncCandidate[]>;

  /**
   * Builds an exact, secret-bearing plan in backend memory after inspecting the
   * authoritative remote state. Returns only its redacted preview.
   */
  prepare(profileId: string, providerIds: string[]): Promise<PreparedProviderSync>;

  /**
   * Consumes the matching prepared plan. A missing, expired, used, or stale
   * plan is rejected and requires a new prepare/confirmation cycle.
   */
  apply(profileId: string, providerIds: string[]): Promise<ProviderSyncResult>;
}

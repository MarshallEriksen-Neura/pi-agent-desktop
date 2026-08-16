/**
 * Redacted remote model catalog contract.
 *
 * Mobile never sees provider credentials or base URLs. `RemoteModelRef` is
 * the stable `provider/modelId` identity used by conversation create/append
 * and by the runtime `set_model` binding. The host owns all credential
 * material; mobile can only list, discover candidates for an existing
 * provider, add model definitions under that provider, and toggle the remote
 * allowlist.
 */

export type RemoteModelRef = string;

export type RemoteModelInputKind = "text" | "image";

export interface RemoteModelDto {
  /** Stable `provider/modelId` reference used by create/append/set_model. */
  readonly ref: RemoteModelRef;
  readonly provider: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly reasoning: boolean;
  readonly inputKinds: readonly RemoteModelInputKind[];
  readonly contextWindow?: number;
  /** Host-side availability (provider reachable, model defined). */
  readonly available: boolean;
  /** Whether the model may be selected for remote conversations. */
  readonly remoteAllowed: boolean;
  /** Host default model, if this entry is it. */
  readonly isDefault: boolean;
}

export interface RemoteModelCatalogResponse {
  readonly models: readonly RemoteModelDto[];
  readonly defaultModelRef?: RemoteModelRef;
}

export interface RemoteModelDiscoverRequest {
  /** Provider id already configured on the host; credentials stay on host. */
  readonly provider: string;
}

export interface RemoteModelCandidate {
  readonly modelId: string;
  readonly displayName?: string;
  readonly reasoning: boolean;
  readonly inputKinds: readonly RemoteModelInputKind[];
  readonly contextWindow?: number;
}

export interface RemoteModelDiscoverResponse {
  readonly provider: string;
  readonly candidates: readonly RemoteModelCandidate[];
}

export interface RemoteModelAddRequest {
  readonly provider: string;
  readonly models: readonly RemoteModelCandidate[];
}

export interface RemoteModelAddResponse {
  readonly models: readonly RemoteModelDto[];
  readonly added: readonly RemoteModelRef[];
}

export interface RemoteModelEnableRequest {
  readonly enabled: boolean;
}

export interface RemoteModelEnableResponse {
  readonly ref: RemoteModelRef;
  readonly remoteAllowed: boolean;
  readonly duplicate: boolean;
}

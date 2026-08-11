export const REMOTE_CONTROL_PROTOCOL = "pi.remote-control" as const;
export const REMOTE_CONTROL_VERSION = 1 as const;

export type RemoteControlProtocol = typeof REMOTE_CONTROL_PROTOCOL;
export type RemoteControlVersion = typeof REMOTE_CONTROL_VERSION;
export type IsoTimestamp = string;
export type DeviceId = string;
export type PairingId = string;
export type PairingSecret = string;
export type DeviceToken = string;

export type RemoteEndpointScheme = "https" | "wss";

export interface RemoteEndpoint {
  readonly scheme: RemoteEndpointScheme;
  readonly host: string;
  readonly port: number;
}

export interface CertificatePin {
  readonly algorithm: "spki-sha256";
  readonly value: string;
}

export interface PairingDesktopIdentity {
  readonly desktopId: string;
  readonly displayName: string;
}

export interface WakeOnLanTarget {
  /** Six-byte network adapter MAC address using colon separators. */
  readonly macAddress: string;
  /** RFC1918 directed-broadcast address for the paired desktop adapter. */
  readonly broadcastAddress: string;
}

export interface WakeOnLanConfig {
  readonly targets: readonly WakeOnLanTarget[];
}

export interface PairingQrPayload {
  readonly protocol: RemoteControlProtocol;
  readonly version: RemoteControlVersion;
  readonly desktop: PairingDesktopIdentity;
  readonly endpoints: readonly RemoteEndpoint[];
  readonly pairingId: PairingId;
  readonly secret: PairingSecret;
  readonly certificatePin: CertificatePin;
  readonly expiresAt: IsoTimestamp;
  /** Optional because older desktops and adapters without WoL remain pairable. */
  readonly wakeOnLan?: WakeOnLanConfig;
}

export interface PairingDeviceMetadata {
  readonly deviceId: DeviceId;
  readonly displayName: string;
  readonly platform: "ios" | "android" | "desktop" | "unknown";
  readonly appVersion?: string;
}

export interface PairingRequest {
  readonly version: RemoteControlVersion;
  readonly pairingId: PairingId;
  readonly secret: PairingSecret;
  readonly device: PairingDeviceMetadata;
}

export interface PairingSuccess {
  readonly version: RemoteControlVersion;
  readonly deviceId: DeviceId;
  readonly token: DeviceToken;
  readonly serverTime: IsoTimestamp;
}

/**
 * Safe pairing failure codes exposed on the wire. The gateway collapses the
 * ticket-state triple (expired / invalid / already redeemed) into a single
 * `invalid_ticket` so the pairing endpoint is not a ticket-state oracle
 * (plan Stage 4). `rate_limited` and `identity_unavailable` remain distinct
 * because they are not ticket-state-derived.
 */
export type PairingFailureCode =
  | "invalid_ticket"
  | "rate_limited"
  | "identity_unavailable";

export interface PairingFailure {
  readonly version: RemoteControlVersion;
  readonly error: PairingFailureCode;
  readonly retryAfterMs?: number;
}

export type PairingResponse = PairingSuccess | PairingFailure;

export function isPairingSuccess(response: PairingResponse): response is PairingSuccess {
  return "token" in response;
}

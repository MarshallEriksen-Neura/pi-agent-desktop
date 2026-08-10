import type {
  PairingDeviceMetadata,
  PairingQrPayload,
  RemoteProjectSummary,
} from "@pi/remote-control-contracts";

/**
 * Local gateway status snapshot. Mirrors the Rust `RemoteControlStatus` struct
 * (serde `rename_all = "camelCase"`) returned by every remote-control Tauri
 * command in `src-tauri/src/remote_control/mod.rs`. This is a desktop-only
 * aggregate — it is intentionally NOT part of the wire contracts, because
 * mobile clients never see local admin state; they reach the gateway over
 * HTTPS/WSS via the REST contract instead.
 */
export interface RemoteControlStatusDto {
  enabled: boolean;
  degraded: boolean;
  selectedAddresses: string[];
  port: number | null;
  identityEpoch: number | null;
  projects: RemoteProjectSummary[];
  pairedDevices: PairingDeviceMetadata[];
  lastError: string | null;
}

/** Bind configuration submitted when enabling the gateway. */
export interface RemoteControlEnableInput {
  selectedAddresses: string[];
  port: number;
}

/** Project allowlist entry submitted via `remote_control_allow_project`. */
export interface RemoteControlAllowProjectInput {
  path: string;
  /** Optional display name; when omitted the gateway derives one from the path. */
  name?: string;
}

/**
 * Local administration port for the opt-in LAN remote-control gateway.
 *
 * Desktop-only: every method maps 1:1 to a Tauri command registered in
 * `src-tauri/src/lib.rs` (lines 250–257). Mobile clients never touch this port.
 *
 * The port owns no protocol logic — it is a typed boundary around Tauri IPC so
 * the React layer never calls `invoke` directly and can be exercised under the
 * browser mock transport during `pnpm dev`.
 */
export interface RemoteControlPort {
  /** Current gateway status (enabled/addresses/port/devices/projects/error). */
  status(): Promise<RemoteControlStatusDto>;
  /** Start the gateway bound to the given private addresses + port. */
  enable(input: RemoteControlEnableInput): Promise<RemoteControlStatusDto>;
  /** Stop the gateway and drop the listener. */
  disable(): Promise<RemoteControlStatusDto>;
  /** Issue a short-lived pairing ticket encoded as a QR payload. */
  pairingPayload(): Promise<PairingQrPayload>;
  /** Authorize a local project for mobile access. */
  allowProject(input: RemoteControlAllowProjectInput): Promise<RemoteProjectSummary>;
  /** Revoke a project's authorization; queued tasks for it will fail. */
  removeProject(projectId: string): Promise<RemoteControlStatusDto>;
  /** Revoke a paired device and disconnect it immediately. */
  revokeDevice(deviceId: string): Promise<RemoteControlStatusDto>;
  /** Rotate the TLS identity, clear all devices, and require re-pairing. */
  resetIdentity(): Promise<RemoteControlStatusDto>;
}

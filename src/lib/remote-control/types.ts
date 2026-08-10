/**
 * UI-only derived types for the remote-control settings surface. These are NOT
 * wire types — they describe states the React layer derives from the backend
 * {@link RemoteControlStatusDto} plus local operation progress.
 */

/** Coarse gateway phase shown as the overview status badge. */
export type RemoteControlPhase =
  | "normal"
  | "starting"
  | "degraded"
  | "fault"
  | "disabled";

/** Lifecycle of the pairing QR modal (design §M2). */
export type PairingQrState =
  | "idle"
  | "generating"
  | "ready"
  | "expired"
  | "paired"
  | "failed";

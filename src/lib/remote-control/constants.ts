/**
 * Tunables for the remote-control settings surface. Kept in one place so the
 * polling cadence and port bounds are easy to audit against the backend.
 */

/** How often the QR modal polls `status` to detect a successful pairing
 *  (design §13-3 — no push event exists, so we poll `pairedDevices.length`). */
export const PAIRING_POLL_INTERVAL_MS = 1500;

/** QR countdown tick — drives the per-second remaining display. */
export const QR_COUNTDOWN_TICK_MS = 1000;

/** Default gateway port prefilled in the network config row. */
export const DEFAULT_PORT = 8443;

/** Valid bind-port range (avoid privileged ports). */
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/** RFC 1918 private address blocks — used to validate selected addresses. */
export const PRIVATE_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [10, 0, 0],
  [172, 16, 31],
  [192, 168, 0],
];

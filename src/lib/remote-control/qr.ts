/**
 * Pure helpers for the pairing QR countdown. Kept side-effect-free so they can
 * be unit-tested without timers.
 */

/** Parse the ISO-8601 `expiresAt` from a {@link PairingQrPayload} to epoch ms. */
export function qrExpiryMs(expiresAt: string): number {
  return new Date(expiresAt).getTime();
}

/** Remaining milliseconds before the QR expires (clamped at 0). */
export function qrRemainingMs(expiresAt: string, now = Date.now()): number {
  return Math.max(0, qrExpiryMs(expiresAt) - now);
}

/** Whole seconds remaining, for the countdown numeral. */
export function qrRemainingSeconds(expiresAt: string, now = Date.now()): number {
  return Math.ceil(qrRemainingMs(expiresAt, now) / 1000);
}

/** Fraction of the TTL elapsed (0 → 1), for the progress track. */
export function qrElapsedFraction(
  issuedAt: string,
  expiresAt: string,
  now = Date.now(),
): number {
  const start = new Date(issuedAt).getTime();
  const end = qrExpiryMs(expiresAt);
  const span = end - start;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - start) / span));
}

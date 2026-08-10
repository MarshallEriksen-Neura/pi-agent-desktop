/**
 * Pairing-QR serialization — the single source of truth for the string that
 * gets encoded into the on-screen QR matrix and consumed by the mobile app.
 *
 * Format: a compact JSON document of the {@link PairingQrPayload}, prefixed
 * with the protocol identifier so the mobile scanner can route by scheme
 * (`pi.remote-control:v1:<base64url-json>`). The prefix lets future versions
 * migrate the envelope without breaking the QR shape.
 *
 * Kept side-effect-free so it can be unit-tested in isolation.
 */
import type { PairingQrPayload } from "@pi/remote-control-contracts";
import { REMOTE_CONTROL_PROTOCOL, REMOTE_CONTROL_VERSION } from "@pi/remote-control-contracts";

/** Base64url encode without padding (URL-safe, smaller QR). */
function base64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encode a {@link PairingQrPayload} into the QR string scanned by the mobile
 * app. The payload is JSON-serialized (field order is stable because the
 * contracts use `readonly` interfaces) and base64url-wrapped with a versioned
 * prefix so the mobile parser can reject incompatible envelopes up front.
 */
export function serializeQrPayload(payload: PairingQrPayload): string {
  const json = JSON.stringify(payload);
  return `${REMOTE_CONTROL_PROTOCOL}:v${REMOTE_CONTROL_VERSION}:${base64url(json)}`;
}

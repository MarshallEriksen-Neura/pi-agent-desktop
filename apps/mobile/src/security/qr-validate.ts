import type { PairingQrPayload } from "@pi/remote-control-contracts";
import { isValidWakeOnLanConfig } from "./wake-on-lan";

/**
 * QR payload validation — extracted from the pairing hook so it is unit-testable
 * without React. Validates the envelope structure and expiry.
 *
 * The QR string format is `pi.remote-control:v1:<base64url-json>`. This module
 * validates the decoded payload; the envelope unwrapping happens at scan time.
 */

export type QrValidationCode =
  | "ok"
  | "unsupported_protocol"
  | "missing_pairingId"
  | "missing_secret"
  | "missing_certificatePin"
  | "missing_endpoints"
  | "no_https_endpoint"
  | "invalid_wake_on_lan"
  | "expired"
  | "unsupported_version";

export interface QrValidationResult {
  code: QrValidationCode;
  payload: PairingQrPayload | null;
}

/**
 * Validate a decoded PairingQrPayload. Returns `{ code: "ok", payload }` if
 * valid, or `{ code, payload: null }` if rejected. The caller MUST fail closed
 * (no network call) for any code !== "ok".
 */
export function validatePairingPayload(payload: unknown, now: number = Date.now()): QrValidationResult {
  if (!payload || typeof payload !== "object") {
    return { code: "unsupported_protocol", payload: null };
  }
  const p = payload as Partial<PairingQrPayload>;
  if (p.protocol !== "pi.remote-control") {
    return { code: "unsupported_protocol", payload: null };
  }
  if (!p.pairingId) {
    return { code: "missing_pairingId", payload: null };
  }
  if (!p.secret) {
    return { code: "missing_secret", payload: null };
  }
  if (!p.certificatePin?.value) {
    return { code: "missing_certificatePin", payload: null };
  }
  if (!p.endpoints || p.endpoints.length === 0) {
    return { code: "missing_endpoints", payload: null };
  }
  // Must have at least one HTTPS endpoint — never fall back to cleartext.
  if (!p.endpoints.some((e) => e.scheme === "https")) {
    return { code: "no_https_endpoint", payload: null };
  }
  // Version check
  if (p.version !== 1) {
    return { code: "unsupported_version", payload: null };
  }
  if (p.wakeOnLan !== undefined && !isValidWakeOnLanConfig(p.wakeOnLan)) {
    return { code: "invalid_wake_on_lan", payload: null };
  }
  // Expiry check — a past expiresAt means the ticket is stale.
  if (p.expiresAt && new Date(p.expiresAt).getTime() < now) {
    return { code: "expired", payload: null };
  }
  return { code: "ok", payload: p as PairingQrPayload };
}

/**
 * Parse the QR envelope string `pi.remote-control:v1:<base64url-json>` into a
 * PairingQrPayload, then validate it. Returns the same discriminated result.
 */
export function parseAndValidateQr(raw: string, now: number = Date.now()): QrValidationResult {
  const PREFIX = "pi.remote-control:v1:";
  if (!raw.startsWith(PREFIX)) {
    return { code: "unsupported_protocol", payload: null };
  }
  const b64 = raw.slice(PREFIX.length);
  let json: string;
  try {
    json = base64UrlDecode(b64);
  } catch {
    return { code: "unsupported_protocol", payload: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { code: "unsupported_protocol", payload: null };
  }
  return validatePairingPayload(parsed, now);
}

/** Base64URL decode (no padding, URL-safe charset). */
function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const b64 = padded + pad;
  if (typeof atob === "function") {
    return atob(b64);
  }
  // Node fallback
  return Buffer.from(b64, "base64").toString("utf-8");
}

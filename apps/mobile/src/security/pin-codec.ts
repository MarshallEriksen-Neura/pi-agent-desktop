/**
 * Pin codec — the single, explicit conversion boundary between the backend
 * SPKI fingerprint encoding and OkHttp's `CertificatePinner` pin format.
 *
 * **Why this exists**: the desktop gateway (`crates/pi-remote-control/src/
 * identity.rs`, `fingerprint()`) emits the SPKI SHA-256 digest as a
 * **64-character lowercase hex** string. Android OkHttp's
 * `CertificatePinner.add(host, pin)` expects pins in the form
 * `sha256/<base64>` where `<base64>` is the standard Base64 encoding of the
 * same 32 bytes. Treating the hex string as if it were already Base64
 * (the previous `sha256/$hex=` hack) produces a pin that never matches any
 * real certificate, so pinning silently never fires — an unsafe default.
 *
 * The boundary contract (enforced here and in the native Kotlin layer):
 *
 *  1. Accept only a 64-character hex string `[0-9a-fA-F]{64}`.
 *  2. Decode to 32 bytes. Any other length or non-hex char ⇒ `PinCodecError`
 *     and the caller MUST fail closed (no request is sent).
 *  3. Re-encode the 32 bytes as standard Base64 (with `=` padding).
 *  4. Hand OkHttp `sha256/<base64>`.
 *
 * Invalid pins never reach OkHttp; there is no fallback to system trust.
 */

/** Error raised when a pin is not a valid 64-char hex SPKI digest. */
export class PinCodecError extends Error {
  constructor(
    readonly code: "invalid_length" | "invalid_chars" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "PinCodecError";
  }
}

const HEX_RE = /^[0-9a-fA-F]{1,}$/;
const PIN_HEX_LENGTH = 64;
const PIN_BYTE_LENGTH = 32;

/**
 * Validate that `hex` is a well-formed 64-character hex string. Throws
 * `PinCodecError` with a discriminating `code` so callers can map to a stable
 * error kind. Empty input gets its own code so callers can distinguish
 * "missing" from "malformed".
 */
export function assertValidHexPin(hex: string): void {
  if (typeof hex !== "string" || hex.length === 0) {
    throw new PinCodecError("empty", "certificate pin is missing");
  }
  if (hex.length !== PIN_HEX_LENGTH) {
    throw new PinCodecError(
      "invalid_length",
      `certificate pin must be ${PIN_HEX_LENGTH} hex chars, got ${hex.length}`,
    );
  }
  if (!HEX_RE.test(hex)) {
    throw new PinCodecError(
      "invalid_chars",
      "certificate pin contains non-hex characters",
    );
  }
}

/** True iff `hex` is a valid 64-char hex SPKI digest. */
export function isValidHexPin(hex: string): boolean {
  try {
    assertValidHexPin(hex);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a 64-char hex pin to its 32 raw bytes.
 * Throws `PinCodecError` on malformed input.
 */
export function hexPinToBytes(hex: string): Uint8Array {
  assertValidHexPin(hex);
  const out = new Uint8Array(PIN_BYTE_LENGTH);
  for (let i = 0; i < PIN_BYTE_LENGTH; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Convert a 64-char hex pin to standard Base64 (with `=` padding).
 * This is the exact string OkHttp expects after the `sha256/` prefix.
 * Throws `PinCodecError` on malformed input.
 */
export function hexPinToBase64(hex: string): string {
  const bytes = hexPinToBytes(hex);
  return bytesToBase64(bytes);
}

/**
 * Format a hex pin as an OkHttp `CertificatePinner` pin string:
 * `sha256/<base64>`. Throws `PinCodecError` on malformed input.
 */
export function formatOkHttpPin(hex: string): string {
  return `sha256/${hexPinToBase64(hex)}`;
}

/**
 * Normalize a hex pin to lowercase. The backend emits lowercase; this guards
 * against QR payloads that round-trip through uppercase. Returns the
 * validated lowercase form, or throws `PinCodecError`.
 */
export function normalizeHexPin(hex: string): string {
  const lower = (hex ?? "").toLowerCase();
  assertValidHexPin(lower);
  return lower;
}

// ---------------------------------------------------------------------------
// Internal Base64 encoder (no dependency on Node Buffer / DOM btoa split)
// ---------------------------------------------------------------------------

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(triple >> 18) & 0x3f];
    out += B64_ALPHABET[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? B64_ALPHABET[(triple >> 6) & 0x3f] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[triple & 0x3f] : "=";
  }
  return out;
}

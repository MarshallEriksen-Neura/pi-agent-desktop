import { getTransport } from "@/net/transport";
import { normalizeHexPin, PinCodecError } from "./pin-codec";

/**
 * Certificate Pin manager — registers the SPKI SHA-256 from the pairing QR
 * with the native network stack **before** any request is made.
 *
 * Encoding contract:
 *  - The backend (`identity.rs`) emits the digest as a 64-char lowercase hex
 *    string. This module validates that here (defense in depth) and passes the
 *    hex to the native layer, which is the authoritative converter to the
 *    OkHttp `sha256/<base64>` pin format (see `pin-codec.ts`).
 *  - An invalid pin throws `PinCodecError` and never reaches the network. The
 *    caller MUST fail closed — there is no fallback to an unpinned request.
 *
 * On native (Android), this calls OkHttp's `CertificatePinner` via the SecureNet
 * plugin. On browser (dev), it's a no-op — the browser TLS stack handles trust
 * and the browser build is never shipped as the production network stack.
 */

export interface PinTarget {
  readonly host: string;
  readonly port: number;
  /** 64-char hex SPKI SHA-256 digest from the pairing QR. */
  readonly pinHex: string;
}

export { PinCodecError };

/**
 * Register the certificate pin for a desktop gateway.
 * MUST be called before the first HTTP request to the gateway, otherwise the
 * native plugin rejects with `pin_not_registered`.
 *
 * @throws {PinCodecError} if the pin is not a valid 64-char hex digest.
 */
export async function registerPin(target: PinTarget): Promise<void> {
  // Validate + normalize before touching the native layer. This is the
  // testable TS-side boundary; the Kotlin layer re-validates (defense in depth).
  const pinHex = normalizeHexPin(target.pinHex);
  const transport = getTransport();
  await transport.registerCertPin({
    host: target.host,
    port: target.port,
    pinValue: pinHex,
  });
}

/**
 * Clear a previously registered pin. Called when the user "forgets" the
 * desktop connection — ensures stale pins don't linger.
 */
export async function clearPin(host: string, port: number): Promise<void> {
  const transport = getTransport();
  await transport.clearCertPin({ host, port });
}

/** Re-export for callers that need to validate without registering. */
export { isValidHexPin } from "./pin-codec";

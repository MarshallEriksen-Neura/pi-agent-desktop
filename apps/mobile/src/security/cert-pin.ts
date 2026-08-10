import { getTransport } from "@/net/transport";

/**
 * Certificate Pin manager — registers the SPKI SHA256 from the pairing QR
 * with the native network stack before any request is made.
 *
 * On native (Android), this calls OkHttp's CertificatePinner via the SecureNet
 * plugin. On browser (dev), it's a no-op — the browser TLS stack handles trust.
 *
 * The pin MUST be registered before the first HTTP request to the gateway,
 * otherwise the native plugin rejects with `pin_not_registered`.
 */

export interface PinTarget {
  readonly host: string;
  readonly port: number;
  readonly pinValue: string; // base64 SPKI SHA256
}

/**
 * Register the certificate pin for a desktop gateway.
 * Called once after a successful pairing, before any API request.
 */
export async function registerPin(target: PinTarget): Promise<void> {
  const transport = getTransport();
  await transport.registerCertPin({
    host: target.host,
    port: target.port,
    pinValue: target.pinValue,
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

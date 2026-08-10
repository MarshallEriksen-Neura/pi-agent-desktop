import { registerPlugin } from "@capacitor/core";
import type { SecureNetPlugin } from "./definitions";

/**
 * Register the SecureNet plugin.
 *
 * - **Android**: proxies to the native Kotlin implementation (OkHttp +
 *   CertificatePinner). See `android/SecureNetPlugin.kt`.
 * - **iOS** (future): will proxy to a Swift implementation (URLSessionDelegate
 *   + URLSessionWebSocketTask).
 * - **Browser** (dev preview): falls back to `fetch` + `WebSocket` without
 *   TLS pinning. This is only for development — production must run inside
 *   Capacitor on a real device.
 *
 * @see {@link ../../net/transport.ts} for how the transport layer consumes this.
 */
export const SecureNet = registerPlugin<SecureNetPlugin>("SecureNet", {
  web: () => import("./web-impl").then((m) => m.createWebSecureNet()),
});

export type { SecureNetPlugin } from "./definitions";

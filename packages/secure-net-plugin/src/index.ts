import { registerPlugin } from "@capacitor/core";
import type { SecureNetPlugin } from "./definitions";

/**
 * Register the SecureNet plugin.
 *
 * - **Android**: proxies to the native Kotlin implementation (OkHttp +
 *   `CertificatePinner` + fail-closed host check). See
 *   `android/src/main/java/com/pi/remote/securenet/SecureNetPlugin.kt`.
 * - **iOS** (future): will proxy to a Swift implementation (URLSessionDelegate
 *   + URLSessionWebSocketTask).
 * - **Browser** (dev preview): falls back to `fetch` + `WebSocket` without TLS
 *   pinning. This is only for development — production must run inside the
 *   Capacitor native shell on a real device.
 *
 * The plugin is auto-discovered by `cap sync` from this package's `capacitor`
 * field in `package.json`; no manual editing of `capacitor.plugins.json` is
 * required.
 *
 * @see {@link ../../apps/mobile/src/net/transport.ts} for how the transport
 * layer consumes this.
 */
export const SecureNet = registerPlugin<SecureNetPlugin>("SecureNet", {
  web: () => import("./web").then((m) => m.createWebSecureNet()),
});

export type {
  SecureNetPlugin,
  SecureNetRequestOptions,
  SecureNetResponse,
  OpenStreamOptions,
  RegisterCertPinOptions,
  ClearCertPinOptions,
  WakeOnLanTargetOptions,
  WakeOnLanOptions,
  WakeOnLanResult,
  StreamMessageEvent,
  StreamCloseEvent,
  StreamErrorEvent,
  CertificatePinValue,
} from "./definitions";

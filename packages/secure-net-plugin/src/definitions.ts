import type { PluginListenerHandle } from "@capacitor/core";

/**
 * SecureNet — a Capacitor plugin that routes all HTTP and WebSocket traffic
 * through a native network stack with TLS Certificate Pinning (SPKI SHA256).
 *
 * On Android this is backed by OkHttp's `CertificatePinner` and
 * `OkHttpClient#newWebSocket`. On iOS (future) it will use URLSessionDelegate
 * + URLSessionWebSocketTask.
 *
 * The browser fallback (no Capacitor runtime) uses fetch + WebSocket without
 * pinning — see `web.ts`. It is a DEV-ONLY preview and is never the production
 * network stack (the production stack is the native APK).
 *
 * Encoding contract:
 *  - `registerCertPin.pinValue` is the 64-char lowercase hex SPKI SHA256
 *    digest emitted by the desktop gateway (`identity.rs`). The native layer
 *    validates the hex, decodes 32 bytes, re-encodes as standard Base64, and
 *    registers `sha256/<base64>` with OkHttp. See `pin-codec.ts` in the mobile
 *    app for the canonical TS-side boundary + test vectors.
 *  - **Fail closed**: a request to a host with no registered pin rejects with
 *    `pin_not_registered`. There is no fallback to system trust.
 */

/** A pinned certificate fingerprint: `spki-sha256:<hex>`. */
export interface CertificatePinValue {
  readonly algorithm: "spki-sha256";
  readonly value: string;
}

export interface RegisterCertPinOptions {
  readonly host: string;
  readonly port: number;
  /**
   * The 64-character lowercase hex SPKI SHA-256 digest emitted by the desktop
   * gateway (`identity.rs`). The native layer validates it is exactly 64 hex
   * chars, decodes to 32 bytes, re-encodes as standard Base64, and registers
   * `sha256/<base64>` with OkHttp's `CertificatePinner`.
   */
  readonly pinValue: string;
}

export interface ClearCertPinOptions {
  readonly host: string;
  readonly port: number;
}

export interface WakeOnLanTargetOptions {
  readonly macAddress: string;
  readonly broadcastAddress: string;
}

export interface WakeOnLanOptions {
  readonly targets: readonly WakeOnLanTargetOptions[];
}

export interface WakeOnLanResult {
  readonly packetsSent: number;
  readonly targetCount: number;
}

export interface SecureNetRequestOptions {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface SecureNetResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface OpenStreamOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface StreamMessageEvent {
  readonly streamId: string;
  readonly data: string;
}

export interface StreamCloseEvent {
  readonly streamId: string;
  readonly code: number;
  readonly reason: string;
}

export interface StreamErrorEvent {
  readonly streamId: string;
  /** Stable machine-readable error kind (for example `pin_mismatch`). */
  readonly message: string;
  /** Optional native diagnostic; never use this field for control flow. */
  readonly detail?: string;
}

export interface SecureNetPlugin {
  /** Send an HTTP request through the pinned network stack. */
  request(opts: SecureNetRequestOptions): Promise<SecureNetResponse>;

  /** Open a WebSocket connection. Returns a streamId for event subscription. */
  openStream(opts: OpenStreamOptions): Promise<{ streamId: string }>;

  /** Close a previously opened stream. */
  closeStream(opts: { streamId: string }): Promise<void>;

  /** Register a certificate pin for a host:port before making requests. */
  registerCertPin(opts: RegisterCertPinOptions): Promise<void>;

  /** Remove a previously registered pin. */
  clearCertPin(opts: ClearCertPinOptions): Promise<void>;

  /** Send bounded UDP/9 magic packets to private-LAN broadcast targets. */
  wakeOnLan(opts: WakeOnLanOptions): Promise<WakeOnLanResult>;

  /** Fired when a WebSocket message frame arrives. */
  addListener(
    eventName: "streamMessage",
    listenerFunc: (event: StreamMessageEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Fired when a WebSocket closes (clean or abnormal). */
  addListener(
    eventName: "streamClose",
    listenerFunc: (event: StreamCloseEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Fired when a WebSocket encounters an error (e.g. pin_mismatch). */
  addListener(
    eventName: "streamError",
    listenerFunc: (event: StreamErrorEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}

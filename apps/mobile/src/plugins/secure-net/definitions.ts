import type { PluginListenerHandle } from "@capacitor/core";

/**
 * SecureNet — a Capacitor plugin that routes all HTTP and WebSocket traffic
 * through a native network stack with TLS Certificate Pinning (SPKI SHA256).
 *
 * On Android this is backed by OkHttp's {@link CertificatePinner} and
 * {@link OkHttpClient#newWebSocket}. On iOS (future) it will use
 * URLSessionDelegate + URLSessionWebSocketTask.
 *
 * The browser fallback (no Capacitor runtime) uses fetch + WebSocket without
 * pinning — see {@link ../../net/browser-transport.ts}.
 */

/** A pinned certificate fingerprint: `spki-sha256:<base64>`. */
export interface CertificatePinValue {
  readonly algorithm: "spki-sha256";
  readonly value: string;
}

export interface RegisterCertPinOptions {
  readonly host: string;
  readonly port: number;
  /** The raw base64 SPKI SHA256 hash from {@link CertificatePinValue.value}. */
  readonly pinValue: string;
}

export interface ClearCertPinOptions {
  readonly host: string;
  readonly port: number;
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
  readonly message: string;
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

/**
 * SecureNetPort — the single network abstraction the entire mobile app talks
 * through. Every HTTP request and WebSocket stream goes through this interface.
 *
 * Implementations:
 *  - {@link ./browser-transport.ts} — dev preview (fetch + WebSocket, no pin)
 *  - Native SecureNet plugin — production (OkHttp CertificatePinner + WSS)
 *
 * Keeping this a narrow interface means swapping the browser fallback for the
 * native plugin (or vice versa) touches zero business code.
 */

export interface NetRequestOptions {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface NetResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface EventStreamHandle {
  /** Register a message callback. Returns an unsubscribe function. */
  onMessage(cb: (data: string) => void): () => void;
  /** Register a close callback. Returns an unsubscribe function. */
  onClose(cb: (code: number, reason: string) => void): () => void;
  /** Register an error callback. Returns an unsubscribe function. */
  onError(cb: (message: string) => void): () => void;
  /** Gracefully close the stream. */
  close(): Promise<void>;
  /** The stream's unique id (for debugging). */
  readonly streamId: string;
}

export interface SecureNetPort {
  request(opts: NetRequestOptions): Promise<NetResponse>;
  openStream(opts: {
    url: string;
    headers: Record<string, string>;
  }): Promise<EventStreamHandle>;
  registerCertPin(opts: {
    host: string;
    port: number;
    pinValue: string;
  }): Promise<void>;
  clearCertPin(opts: { host: string; port: number }): Promise<void>;
  wakeOnLan(opts: {
    targets: readonly { macAddress: string; broadcastAddress: string }[];
  }): Promise<{ packetsSent: number; targetCount: number }>;
}

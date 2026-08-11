import type { PluginListenerHandle } from "@capacitor/core";
import type {
  SecureNetPlugin,
  SecureNetRequestOptions,
  SecureNetResponse,
  OpenStreamOptions,
  RegisterCertPinOptions,
  ClearCertPinOptions,
} from "./definitions";

/**
 * Browser/dev-preview implementation of `SecureNetPlugin`.
 *
 * Uses the platform `fetch` and `WebSocket` APIs. **TLS Certificate Pinning
 * is NOT enforced** — the browser TLS stack validates the chain against the
 * system trust store. This is a DEV-ONLY preview; production must run inside
 * the Capacitor native shell where the native Kotlin/Swift implementation
 * enforces the SPKI pin and fails closed.
 *
 * The dev preview is gated by the mobile app: the transport layer is only
 * selected when the Capacitor runtime is absent, which never happens in an
 * installed APK.
 */

type EventName = "streamMessage" | "streamClose" | "streamError";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (event: any) => void;

interface WebStream {
  ws: WebSocket;
}

const listeners: Record<EventName, Set<Listener>> = {
  streamMessage: new Set(),
  streamClose: new Set(),
  streamError: new Set(),
};
const streams = new Map<string, WebStream>();
let nextStreamId = 1;

function emit(eventName: EventName, event: unknown): void {
  listeners[eventName].forEach((l) => l(event));
}

export function createWebSecureNet(): SecureNetPlugin {
  return {
    async request(opts: SecureNetRequestOptions): Promise<SecureNetResponse> {
      const controller = new AbortController();
      const timeout = opts.timeoutMs ?? 10000;
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(opts.url, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          signal: controller.signal,
        });
        const body = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, body };
      } finally {
        clearTimeout(timer);
      }
    },

    async openStream(opts: OpenStreamOptions): Promise<{ streamId: string }> {
      const streamId = `ws-${nextStreamId++}`;
      const ws = new WebSocket(opts.url);
      streams.set(streamId, { ws });

      ws.onmessage = (e) => {
        emit("streamMessage", { streamId, data: e.data as string });
      };
      ws.onclose = (e) => {
        emit("streamClose", { streamId, code: e.code, reason: e.reason });
        streams.delete(streamId);
      };
      ws.onerror = () => {
        emit("streamError", {
          streamId,
          message: "stream_error (browser dev mode — no cert pin enforcement)",
        });
      };

      return { streamId };
    },

    async closeStream(opts: { streamId: string }): Promise<void> {
      const stream = streams.get(opts.streamId);
      if (stream) {
        stream.ws.close(1000, "client closed");
        streams.delete(opts.streamId);
      }
    },

    // No-op in browser — TLS pinning is delegated to the browser TLS stack.
    // The native build enforces the pin; this path is dev-only.
    async registerCertPin(_opts: RegisterCertPinOptions): Promise<void> {},
    async clearCertPin(_opts: ClearCertPinOptions): Promise<void> {},
    async wakeOnLan(): Promise<never> {
      throw { code: "wake_on_lan_unsupported", message: "wake_on_lan_unsupported" };
    },

    async addListener(
      eventName: EventName,
      listenerFunc: Listener,
    ): Promise<PluginListenerHandle> {
      listeners[eventName].add(listenerFunc);
      return {
        remove: async () => {
          listeners[eventName].delete(listenerFunc);
        },
      } as PluginListenerHandle;
    },

    async removeAllListeners(): Promise<void> {
      (Object.keys(listeners) as EventName[]).forEach((k) => listeners[k].clear());
    },
  };
}

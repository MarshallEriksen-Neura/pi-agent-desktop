import type { SecureNetPort, EventStreamHandle } from "./port";
import { SecureNet, type SecureNetPlugin } from "@pi/secure-net-plugin";

/**
 * Runtime transport selection.
 *
 * A single {@link SecureNetPort} implementation wraps the {@link SecureNet}
 * plugin (provided by the local `@pi/secure-net-plugin` workspace package,
 * auto-discovered by `cap sync`). The plugin's `registerPlugin` call handles
 * the platform split:
 *
 *  - **Native (Android/iOS)**: proxies to the Kotlin/Swift implementation
 *    with TLS Certificate Pinning (fail closed — no pin = no request).
 *  - **Browser (dev)**: uses the `web.ts` fallback (fetch + WebSocket,
 *    no pinning — dev preview only, never the production stack).
 *
 * This module just adapts the plugin's event-listener API into the
 * {@link EventStreamHandle} callback API that the rest of the net layer
 * expects.
 */

let cached: SecureNetPort | null = null;

export function getTransport(): SecureNetPort {
  if (cached) return cached;
  cached = createPluginTransport(SecureNet);
  return cached;
}

function createPluginTransport(plugin: SecureNetPlugin): SecureNetPort {
  return {
    async request(opts) {
      try {
        const res = await plugin.request({
          url: opts.url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return { status: res.status, headers: res.headers, body: res.body };
      } catch (e: unknown) {
        // Capacitor rejects with { code, message } — surface the code for
        // the error classifier.
        const code = (e as { code?: string }).code ?? "unknown";
        const message = (e as { message?: string }).message ?? "request failed";
        throw { kind: code, message, status: code };
      }
    },

    async openStream(opts) {
      const { streamId } = await plugin.openStream({
        url: opts.url,
        headers: opts.headers,
      });

      const messageCbs = new Set<(data: string) => void>();
      const closeCbs = new Set<(code: number, reason: string) => void>();
      const errorCbs = new Set<(message: string) => void>();

      const msgListener = await plugin.addListener("streamMessage", (event) => {
        if (event.streamId === streamId) {
          messageCbs.forEach((cb) => cb(event.data));
        }
      });
      const closeListener = await plugin.addListener("streamClose", (event) => {
        if (event.streamId === streamId) {
          closeCbs.forEach((cb) => cb(event.code, event.reason));
          void msgListener.remove();
          void closeListener.remove();
        }
      });
      const errListener = await plugin.addListener("streamError", (event) => {
        if (event.streamId === streamId) {
          errorCbs.forEach((cb) => cb(event.message));
          void msgListener.remove();
          void errListener.remove();
        }
      });

      return {
        streamId,
        onMessage(cb) {
          messageCbs.add(cb);
          return () => messageCbs.delete(cb);
        },
        onClose(cb) {
          closeCbs.add(cb);
          return () => closeCbs.delete(cb);
        },
        onError(cb) {
          errorCbs.add(cb);
          return () => errorCbs.delete(cb);
        },
        async close() {
          await plugin.closeStream({ streamId });
          await msgListener.remove();
          await closeListener.remove();
          await errListener.remove();
        },
      };
    },

    async registerCertPin(opts) {
      await plugin.registerCertPin(opts);
    },

    async clearCertPin(opts) {
      await plugin.clearCertPin(opts);
    },

    async wakeOnLan(opts) {
      return plugin.wakeOnLan(opts);
    },
  };
}

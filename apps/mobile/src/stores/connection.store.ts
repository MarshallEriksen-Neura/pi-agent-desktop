import { create } from "zustand";
import type {
  PairingQrPayload,
  RemoteEndpoint,
} from "@pi/remote-control-contracts";
import { RemoteControlClient } from "@/net/client";
import { EventStreamClient, type EventStreamPhase } from "@/net/event-stream";
import { ConversationEventStreamClient } from "@/net/conversation-event-stream";
import { getTransport } from "@/net/transport";
import { NetError, type NetErrorKind } from "@/net/errors";
import { registerPin, clearPin, isValidHexPin, PinCodecError } from "@/security/cert-pin";
import { assertValidHexPin } from "@/security/pin-codec";
import {
  tokenVault,
  buildStoredConnection,
  type StoredConnection,
} from "@/security/token-vault";
import { eventDispatcher } from "./event-dispatcher";
import { conversationEventDispatcher } from "./conversation-event-dispatcher";

/**
 * Connection store — the single source of truth for the desktop connection
 * lifecycle. Owns:
 *
 *  - **Pairing** (P0-secured ordering):
 *      validate QR → validate pin hex → register pin on native
 *      → POST /pair over pinned transport → save token → GET /me verify
 *      → open WSS.
 *    The certificate pin is registered with the native network stack BEFORE
 *    the first HTTP request, so `/pair` itself is protected by pinning. A
 *    missing or malformed pin fails closed — no request is sent.
 *  - **Connection**: load token → register pin → GET /me verify → open stream
 *  - **Phase**: `online | reconnecting | offline | identity_failed`
 *  - **Forget**: clear pin + token + storage (local-only, does not revoke)
 *
 * The store is deliberately framework-agnostic — hooks subscribe to it, but
 * the store itself has no React dependencies. Live events are forwarded to
 * the task/interaction stores via {@link eventDispatcher}.
 */

export type ConnectionPhase = "idle" | "pairing" | "waking" | "online" | "reconnecting" | "offline" | "identity_failed";

const WAKE_RECONNECT_TIMEOUT_MS = 45_000;
const WAKE_RECONNECT_INTERVAL_MS = 2_500;
let wakeGeneration = 0;
let connectionGeneration = 0;

interface ConnectionState {
  // Persisted pairing data
  stored: StoredConnection | null;

  // Runtime state
  phase: ConnectionPhase;
  lastError: string | null;
  lastErrorKind: NetErrorKind | string | null;

  // Lazy-built clients (created on connect)
  client: RemoteControlClient | null;
  stream: EventStreamClient | null;
  conversationStream: ConversationEventStreamClient | null;

  // Actions
  pair: (payload: PairingQrPayload, deviceName: string, platform: string) => Promise<boolean>;
  connect: () => Promise<boolean>;
  wake: () => Promise<boolean>;
  disconnect: () => void;
  forget: () => Promise<void>;
  loadStored: () => Promise<boolean>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  stored: null,
  phase: "idle",
  lastError: null,
  lastErrorKind: null,
  client: null,
  stream: null,
  conversationStream: null,

  loadStored: async () => {
    const stored = await tokenVault.load();
    if (stored) {
      set({ stored });
      return true;
    }
    return false;
  },

  pair: async (payload, deviceName, platform) => {
    connectionGeneration += 1;
    set({ phase: "pairing", lastError: null, lastErrorKind: null });
    try {
      // 1. Select an HTTPS endpoint (fail closed if none — never fall back to HTTP).
      const endpoint = selectEndpoint(payload.endpoints);
      if (!endpoint) {
        set({ phase: "offline", lastError: "no_endpoint", lastErrorKind: "no_endpoint" });
        return false;
      }

      // 2. Validate the pin hex BEFORE any network call. A malformed pin must
      //    never reach the transport — the request would otherwise go out
      //    unpinned.
      try {
        assertValidHexPin(payload.certificatePin.value);
      } catch (e) {
        const code = e instanceof PinCodecError ? e.code : "invalid_pin";
        set({ phase: "identity_failed", lastError: code, lastErrorKind: code });
        return false;
      }

      // 3. Register the pin with the native network stack. From this point on,
      //    every request to `endpoint` MUST match the pinned SPKI or the native
      //    layer rejects with `pin_mismatch`. No pin registered ⇒ the native
      //    layer rejects with `pin_not_registered`. Both fail closed.
      await registerPin({
        host: endpoint.host,
        port: endpoint.port,
        pinHex: payload.certificatePin.value,
      });

      // 4. Build the client over the now-pinned transport. `/pair` is the only
      //    unauthenticated endpoint — it still goes through the pinned TLS
      //    connection, which is the whole point of the QR carrying the pin.
      const baseUrl = buildBaseUrl(endpoint);
      const transport = getTransport();
      const client = new RemoteControlClient(transport, baseUrl, () => null);

      // 5. POST /pair over the pinned transport.
      const localDeviceId = generateLocalDeviceId();
      const pairResult = await client.pair({
        version: payload.version,
        pairingId: payload.pairingId,
        secret: payload.secret,
        device: {
          deviceId: localDeviceId,
          displayName: deviceName,
          platform: platform as "ios" | "android" | "desktop" | "unknown",
          appVersion: "0.1.0",
        },
      });

      if (!("token" in pairResult)) {
        // PairingFailure — do not persist; let the UI map the error.
        const failure = pairResult as { error: string };
        set({ phase: "offline", lastError: failure.error, lastErrorKind: failure.error });
        return false;
      }

      // 6. Persist the connection (token goes into secure storage).
      const stored = buildStoredConnection(payload, pairResult);
      await tokenVault.save(stored);

      // 7. Verify identity via GET /me over the pinned transport.
      const authedClient = new RemoteControlClient(transport, baseUrl, () => ({
        deviceId: pairResult.deviceId,
        token: pairResult.token,
      }));
      let me: { deviceId: string; identityEpoch: number; scopes: string[] };
      try {
        me = await authedClient.getMe();
      } catch (e) {
        // Token saved but /me failed — surface as offline so the user can
        // retry connect() later. Token is retained.
        const message = e instanceof NetError ? e.message : "verify_failed";
        const kind = e instanceof NetError ? e.kind : "unknown";
        set({
          stored,
          phase: kind === "identity_rotated" || kind === "pin_mismatch" ? "identity_failed" : "offline",
          lastError: message,
          lastErrorKind: kind,
          client: authedClient,
        });
        return false;
      }

      // 8. Identity epoch check — rotation invalidates the token.
      const finalStored: StoredConnection = {
        ...stored,
        identityEpoch: me.identityEpoch,
      };
      await tokenVault.save(finalStored);

      set({
        stored: finalStored,
        phase: "online",
        lastError: null,
        client: authedClient,
      });
      return true;
    } catch (e) {
      const message = e instanceof NetError ? e.message : (e as Error)?.message ?? "pairing_failed";
      const kind = e instanceof NetError ? e.kind : "unknown";
      set({
        phase: kind === "pin_mismatch" || kind === "identity_rotated" ? "identity_failed" : "offline",
        lastError: message,
        lastErrorKind: kind,
      });
      return false;
    }
  },

  connect: async () => {
    const { stored } = get();
    if (!stored) {
      set({ phase: "offline", lastError: "not_paired", lastErrorKind: "not_paired" });
      return false;
    }
    const generation = ++connectionGeneration;

    try {
      const endpoint = selectEndpoint(stored.endpoints);
      if (!endpoint) {
        set({ phase: "offline", lastError: "no_endpoint", lastErrorKind: "no_endpoint" });
        return false;
      }

      // Re-register pin (app may have been reinstalled; pin is in-memory on native).
      await registerPin({
        host: endpoint.host,
        port: endpoint.port,
        pinHex: stored.certificatePin.value,
      });

      const baseUrl = buildBaseUrl(endpoint);
      const transport = getTransport();
      const client = new RemoteControlClient(transport, baseUrl, () => ({
        deviceId: stored.deviceId,
        token: stored.token,
      }));

      // Verify token via GET /me
      const me = await client.getMe();
      if (generation !== connectionGeneration) return false;

      // Check identity epoch — if rotated, the token is invalid.
      if (stored.identityEpoch > 0 && me.identityEpoch !== stored.identityEpoch) {
        set({ phase: "identity_failed", lastError: "identity_rotated", lastErrorKind: "identity_rotated" });
        return false;
      }

      // Update stored identity epoch
      const updated = { ...stored, identityEpoch: me.identityEpoch };
      await tokenVault.save(updated);

      // Open the event stream. Events are forwarded to the task/interaction
      // stores via the eventDispatcher; snapshot_required triggers a refetch.
      const stream = new EventStreamClient(
        transport,
        (after) => client.getEventStreamUrl(after),
        () => ({
          "x-pi-device-id": stored.deviceId,
          Authorization: `Bearer ${stored.token}`,
        }),
        {
          onEvent: (event) => eventDispatcher.dispatch(event),
          onSnapshotRequired: () => eventDispatcher.dispatchSnapshotRequired(),
          onPhaseChange: (p: EventStreamPhase) => {
            const phaseMap: Record<EventStreamPhase, ConnectionPhase> = {
              connecting: "reconnecting",
              open: "online",
              reconnecting: "reconnecting",
              closed: "offline",
            };
            set({ phase: phaseMap[p] });
          },
          onTerminalError: (message) => {
            eventDispatcher.dispatchTerminalError(message);
            if (message.includes("identity") || message.includes("pin_mismatch")) {
              set({ phase: "identity_failed", lastError: message, lastErrorKind: "identity_failed" });
            } else {
              set({ phase: "offline", lastError: message, lastErrorKind: "offline" });
            }
          },
        },
      );

      await stream.connect();
      if (generation !== connectionGeneration) {
        await stream.stop();
        return false;
      }

      let conversationStream: ConversationEventStreamClient | null = null;
      const { useConversationStore } = await import("./conversation-store");
      try {
        await client.getConversationCapabilities();
        useConversationStore.setState({ v2Available: true, v2ProbeError: null });
      } catch (e) {
        const unavailable = e instanceof NetError && e.status === 503;
        useConversationStore.setState((state) => ({
          v2Available: unavailable ? false : state.v2Available,
          v2ProbeError: e instanceof NetError ? e.message : "conversation_probe_failed",
        }));
      }

      if (useConversationStore.getState().v2Available === true) {
        try {
          conversationStream = new ConversationEventStreamClient(
            transport,
            (after) => client.getConversationEventStreamUrl(after),
            () => ({
              "x-pi-device-id": stored.deviceId,
              Authorization: `Bearer ${stored.token}`,
            }),
            {
              onEvent: (event) => conversationEventDispatcher.dispatch(event),
              onSnapshotRequired: () => conversationEventDispatcher.dispatchSnapshotRequired(),
              onTerminalError: (message) => conversationEventDispatcher.dispatchTerminalError(message),
            },
          );
          await conversationStream.connect();
        } catch {
          // The REST conversation API remains usable when the live stream is
          // temporarily unavailable. Screens reconcile from authoritative
          // snapshots instead of degrading new work to legacy one-shot tasks.
          conversationStream = null;
        }
      }

      set({
        client,
        stream,
        conversationStream,
        stored: updated,
        phase: "online",
        lastError: null,
        lastErrorKind: null,
      });
      return true;
    } catch (e) {
      const message = e instanceof NetError ? e.message : (e as Error)?.message ?? "connect_failed";
      const kind = e instanceof NetError ? e.kind : "unknown";
      if (kind === "identity_rotated" || kind === "pin_mismatch") {
        set({ phase: "identity_failed", lastError: message, lastErrorKind: kind });
      } else {
        set({ phase: "offline", lastError: message, lastErrorKind: kind });
      }
      return false;
    }
  },

  wake: async () => {
    const { stored, phase } = get();
    if (!stored?.wakeOnLan?.targets.length) {
      set({ phase: "offline", lastError: "wake_unavailable", lastErrorKind: "wake_unavailable" });
      return false;
    }
    if (phase === "waking") return false;

    const generation = ++wakeGeneration;
    set({ phase: "waking", lastError: null, lastErrorKind: null });
    try {
      await getTransport().wakeOnLan({ targets: stored.wakeOnLan.targets });
    } catch (error) {
      if (generation !== wakeGeneration) return false;
      const code = (error as { code?: string; message?: string }).code
        ?? (error as { message?: string }).message
        ?? "wake_failed";
      set({ phase: "offline", lastError: code, lastErrorKind: code });
      return false;
    }

    const deadline = Date.now() + WAKE_RECONNECT_TIMEOUT_MS;
    while (Date.now() < deadline && generation === wakeGeneration) {
      await delay(WAKE_RECONNECT_INTERVAL_MS);
      if (generation !== wakeGeneration) return false;
      if (await get().connect()) return true;
      if (get().phase === "identity_failed") return false;
      set({ phase: "waking", lastError: null, lastErrorKind: null });
    }

    if (generation === wakeGeneration) {
      set({ phase: "offline", lastError: "wake_timeout", lastErrorKind: "wake_timeout" });
    }
    return false;
  },

  disconnect: () => {
    wakeGeneration += 1;
    connectionGeneration += 1;
    const { stream } = get();
    void stream?.stop();
    void get().conversationStream?.stop();
    set({ phase: "offline", stream: null, conversationStream: null, client: null });
  },

  forget: async () => {
    wakeGeneration += 1;
    connectionGeneration += 1;
    const { stored, stream, conversationStream } = get();
    if (stream) await stream.stop();
    if (conversationStream) await conversationStream.stop();
    if (stored) {
      const endpoint = selectEndpoint(stored.endpoints);
      if (endpoint) {
        await clearPin(endpoint.host, endpoint.port);
      }
    }
    await tokenVault.clear();
    eventDispatcher.reset();
    set({
      stored: null,
      phase: "idle",
      lastError: null,
      lastErrorKind: null,
      client: null,
      stream: null,
      conversationStream: null,
    });
  },
}));

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function selectEndpoint(endpoints: readonly RemoteEndpoint[]): RemoteEndpoint | null {
  // Prefer the first HTTPS endpoint; never fall back to a non-HTTPS endpoint
  // (cleartext is rejected by the manifest and the native layer).
  return endpoints.find((e) => e.scheme === "https") ?? null;
}

function buildBaseUrl(endpoint: RemoteEndpoint): string {
  return `${endpoint.scheme}://${endpoint.host}:${endpoint.port}`;
}

/**
 * Generate a local UUID v4 for the device ID sent in the pairing request.
 * The server may accept or reassign it; PairingSuccess returns the final ID.
 * Uses crypto.randomUUID when available, falls back to a manual implementation.
 */
function generateLocalDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Exported for tests that need to validate pin shape without the store.
export { isValidHexPin };

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

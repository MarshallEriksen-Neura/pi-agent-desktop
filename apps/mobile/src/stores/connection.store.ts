import { create } from "zustand";
import type {
  PairingQrPayload,
  RemoteEndpoint,
} from "@pi/remote-control-contracts";
import { RemoteControlClient } from "@/net/client";
import { EventStreamClient, type EventStreamPhase } from "@/net/event-stream";
import { getTransport } from "@/net/transport";
import { NetError } from "@/net/errors";
import { registerPin, clearPin } from "@/security/cert-pin";
import {
  tokenVault,
  buildStoredConnection,
  type StoredConnection,
} from "@/security/token-vault";

/**
 * Connection store — the single source of truth for the desktop connection
 * lifecycle. Owns:
 *
 *  - **Pairing**: QR scan → POST /pair → register pin → persist token
 *  - **Connection**: load token → GET /me verify → open EventStream
 *  - **Phase**: `online | reconnecting | offline | identity_failed`
 *  - **Forget**: clear pin + token + storage (local-only, does not revoke)
 *
 * The store is deliberately framework-agnostic — hooks subscribe to it, but
 * the store itself has no React dependencies.
 */

export type ConnectionPhase = "idle" | "pairing" | "online" | "reconnecting" | "offline" | "identity_failed";

interface ConnectionState {
  // Persisted pairing data
  stored: StoredConnection | null;

  // Runtime state
  phase: ConnectionPhase;
  lastError: string | null;

  // Lazy-built clients (created on connect)
  client: RemoteControlClient | null;
  stream: EventStreamClient | null;

  // Actions
  pair: (payload: PairingQrPayload, deviceName: string, platform: string) => Promise<boolean>;
  connect: () => Promise<boolean>;
  disconnect: () => void;
  forget: () => Promise<void>;
  loadStored: () => Promise<boolean>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  stored: null,
  phase: "idle",
  lastError: null,
  client: null,
  stream: null,

  loadStored: async () => {
    const stored = await tokenVault.load();
    if (stored) {
      set({ stored });
      return true;
    }
    return false;
  },

  pair: async (payload, deviceName, platform) => {
    set({ phase: "pairing", lastError: null });
    try {
      // 1. Build the base URL from the first endpoint
      const endpoint = selectEndpoint(payload.endpoints);
      if (!endpoint) {
        set({ phase: "offline", lastError: "no_endpoint" });
        return false;
      }
      const baseUrl = buildBaseUrl(endpoint);

      // 2. Create a client (no auth yet — /pair doesn't need it)
      const transport = getTransport();
      const client = new RemoteControlClient(transport, baseUrl, () => null);

      // 3. POST /pair — generate a local device ID before pairing (the server
      //    may accept or reassign it; PairingSuccess returns the final deviceId)
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
        // PairingFailure
        const failure = pairResult as { error: string };
        set({
          phase: "offline",
          lastError: failure.error,
        });
        return false;
      }

      // 4. Register the certificate pin BEFORE any authenticated request
      await registerPin({
        host: endpoint.host,
        port: endpoint.port,
        pinValue: payload.certificatePin.value,
      });

      // 5. Persist the connection
      const stored = buildStoredConnection(payload, pairResult);
      await tokenVault.save(stored);

      set({
        stored,
        phase: "online",
        lastError: null,
      });
      return true;
    } catch (e) {
      const message = e instanceof NetError ? e.message : (e as Error)?.message ?? "pairing_failed";
      set({ phase: "offline", lastError: message });
      return false;
    }
  },

  connect: async () => {
    const { stored } = get();
    if (!stored) {
      set({ phase: "offline", lastError: "not_paired" });
      return false;
    }

    try {
      const endpoint = selectEndpoint(stored.endpoints);
      if (!endpoint) {
        set({ phase: "offline", lastError: "no_endpoint" });
        return false;
      }

      // Ensure pin is registered (in case app was reinstalled but storage kept)
      await registerPin({
        host: endpoint.host,
        port: endpoint.port,
        pinValue: stored.certificatePin.value,
      });

      const baseUrl = buildBaseUrl(endpoint);
      const transport = getTransport();
      const client = new RemoteControlClient(transport, baseUrl, () => ({
        deviceId: stored.deviceId,
        token: stored.token,
      }));

      // Verify token via GET /me
      const me = await client.getMe();

      // Check identity epoch — if rotated, the token is invalid
      if (stored.identityEpoch > 0 && me.identityEpoch !== stored.identityEpoch) {
        set({ phase: "identity_failed", lastError: "identity_rotated" });
        return false;
      }

      // Update stored identity epoch
      const updated = { ...stored, identityEpoch: me.identityEpoch };
      await tokenVault.save(updated);

      // Open the event stream
      const stream = new EventStreamClient(
        transport,
        (after) => client.getEventStreamUrl(after),
        () => ({
          "x-pi-device-id": stored.deviceId,
          Authorization: `Bearer ${stored.token}`,
        }),
        {
          onEvent: () => {
            // Events are consumed by task/interaction stores (later Phase)
          },
          onSnapshotRequired: () => {
            // Trigger full re-fetch of tasks (later Phase)
          },
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
            if (message.includes("identity") || message.includes("pin_mismatch")) {
              set({ phase: "identity_failed", lastError: message });
            } else {
              set({ phase: "offline", lastError: message });
            }
          },
        },
      );

      await stream.connect();

      set({
        client,
        stream,
        stored: updated,
        phase: "online",
        lastError: null,
      });
      return true;
    } catch (e) {
      const message = e instanceof NetError ? e.message : (e as Error)?.message ?? "connect_failed";
      const kind = e instanceof NetError ? e.kind : "unknown";
      if (kind === "identity_rotated" || kind === "pin_mismatch") {
        set({ phase: "identity_failed", lastError: message });
      } else {
        set({ phase: "offline", lastError: message });
      }
      return false;
    }
  },

  disconnect: () => {
    const { stream } = get();
    void stream?.stop();
    set({ phase: "offline", stream: null, client: null });
  },

  forget: async () => {
    const { stored, stream } = get();
    if (stream) await stream.stop();
    if (stored) {
      const endpoint = selectEndpoint(stored.endpoints);
      if (endpoint) {
        await clearPin(endpoint.host, endpoint.port);
      }
    }
    await tokenVault.clear();
    set({
      stored: null,
      phase: "idle",
      lastError: null,
      client: null,
      stream: null,
    });
  },
}));

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function selectEndpoint(endpoints: readonly RemoteEndpoint[]): RemoteEndpoint | null {
  // Prefer the first HTTPS endpoint; fall back to first available.
  return endpoints.find((e) => e.scheme === "https") ?? endpoints[0] ?? null;
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
  // Fallback (older browsers)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

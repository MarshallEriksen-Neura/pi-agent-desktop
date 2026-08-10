/**
 * Token Vault — persistent storage for the device token and pairing metadata.
 *
 * On native, this uses `@capacitor/preferences` (backed by SharedPreferences on
 * Android, UserDefaults on iOS). On browser (dev), it falls back to
 * localStorage. The token is the only long-lived credential — losing it forces
 * re-pairing, so writes are atomic and reads are cached.
 */

import type {
  PairingQrPayload,
  RemoteEndpoint,
} from "@pi/remote-control-contracts";

const STORAGE_KEY = "pi.remote.connection";

/** Everything the app needs to reconnect without re-pairing. */
export interface StoredConnection {
  readonly desktopName: string;
  readonly deviceId: string;
  readonly token: string;
  readonly endpoints: readonly RemoteEndpoint[];
  readonly certificatePin: { algorithm: "spki-sha256"; value: string };
  readonly identityEpoch: number;
  readonly pairedAt: string; // ISO timestamp
}

// Lazy-load Capacitor Preferences on native; fall back to localStorage.
async function getStorage(): Promise<StorageLike> {
  if (typeof window !== "undefined" && "Capacitor" in window) {
    const { Preferences } = await import("@capacitor/preferences");
    return {
      async get(key: string): Promise<string | null> {
        const { value } = await Preferences.get({ key });
        return value;
      },
      async set(key: string, value: string): Promise<void> {
        await Preferences.set({ key, value });
      },
      async remove(key: string): Promise<void> {
        await Preferences.remove({ key });
      },
    };
  }
  return {
    async get(key: string): Promise<string | null> {
      return localStorage.getItem(key);
    },
    async set(key: string, value: string): Promise<void> {
      localStorage.setItem(key, value);
    },
    async remove(key: string): Promise<void> {
      localStorage.removeItem(key);
    },
  };
}

interface StorageLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const tokenVault = {
  /** Load the stored connection, or null if never paired. */
  async load(): Promise<StoredConnection | null> {
    const storage = await getStorage();
    const raw = await storage.get(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredConnection;
    } catch {
      // Corrupted entry — clear it so the user can re-pair.
      await storage.remove(STORAGE_KEY);
      return null;
    }
  },

  /** Persist the connection after a successful pairing. */
  async save(conn: StoredConnection): Promise<void> {
    const storage = await getStorage();
    await storage.set(STORAGE_KEY, JSON.stringify(conn));
  },

  /** Clear the stored connection (local "forget" — does not revoke on desktop). */
  async clear(): Promise<void> {
    const storage = await getStorage();
    await storage.remove(STORAGE_KEY);
  },
};

/**
 * Build a StoredConnection from the pairing QR payload + the pair response.
 * This is the single place that translates the QR ticket into a persistent
 * connection record.
 */
export function buildStoredConnection(
  payload: PairingQrPayload,
  pairResult: { deviceId: string; token: string; serverTime?: string },
): StoredConnection {
  return {
    desktopName: payload.desktop.displayName,
    deviceId: pairResult.deviceId,
    token: pairResult.token,
    endpoints: payload.endpoints,
    certificatePin: payload.certificatePin,
    identityEpoch: 0, // Updated on first GET /me
    pairedAt: pairResult.serverTime ?? new Date().toISOString(),
  };
}

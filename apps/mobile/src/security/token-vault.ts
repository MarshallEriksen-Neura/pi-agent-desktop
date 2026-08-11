import type {
  PairingQrPayload,
  PairingSuccess,
  RemoteEndpoint,
  WakeOnLanConfig,
} from "@pi/remote-control-contracts";
import type { SecureStoragePlugin } from "@aparajita/capacitor-secure-storage";
import { assertValidHexPin } from "./pin-codec";
import { isValidWakeOnLanConfig } from "./wake-on-lan";

/**
 * Token Vault — persistent storage for the device token and pairing metadata.
 *
 * Storage backend (P0-secured):
 *  - **Native (Android/iOS)**: `@aparajita/capacitor-secure-storage`, which
 *    encrypts values with AES-GCM using a key held in the Android Keystore
 *    (iOS Keychain on iOS). The device token, certificate pin and endpoints
 *    never enter plaintext SharedPreferences, localStorage, or logs.
 *  - **Browser (dev preview only)**: the same plugin falls back to unencrypted
 *    `localStorage`. This is gated behind `import.meta.env.DEV` so a production
 *    browser bundle cannot accidentally persist credentials — the production
 *    network stack is the native APK, never the browser build. A clearly
 *    flagged `mock.` key prefix makes dev-mode data obvious in storage inspectors.
 *
 * The token is the only long-lived credential — losing it forces re-pairing, so
 * writes are atomic and corruption is fail-closed: any malformed entry is
 * cleared and `load()` returns `null` so the UI routes back to pairing.
 *
 * Token/Pin never enter logs, exceptions, toasts, or debug output.
 */

const STORAGE_KEY = "pi.remote.connection";
const MOCK_PREFIX = "mock.";

/** Everything the app needs to reconnect without re-pairing. */
export interface StoredConnection {
  readonly desktopName: string;
  readonly deviceId: string;
  readonly token: string;
  readonly endpoints: readonly RemoteEndpoint[];
  readonly certificatePin: { algorithm: "spki-sha256"; value: string };
  readonly identityEpoch: number;
  readonly pairedAt: string; // ISO timestamp
  readonly wakeOnLan?: WakeOnLanConfig;
}

interface SecureStorageLike {
  get(opts: { key: string }): Promise<{ value: string } | null>;
  set(opts: { key: string; value: string }): Promise<{ value: string }>;
  remove(opts: { key: string }): Promise<{ value: string } | null>;
}

type NativeSecureStorageLike = Pick<
  SecureStoragePlugin,
  "getItem" | "setItem" | "removeItem"
>;

const isNative = typeof window !== "undefined" && "Capacitor" in window;
const isDevBrowser = !isNative && Boolean(import.meta.env?.DEV);

let storagePromise: Promise<SecureStorageLike> | null = null;

async function getStorage(): Promise<SecureStorageLike> {
  if (storagePromise) return storagePromise;
  storagePromise = (async () => {
    if (isNative) {
      const mod = await import("@aparajita/capacitor-secure-storage");
      return wrapSecureStorage(mod.SecureStorage);
    }
    if (isDevBrowser) {
      // Dev preview only. localStorage is unencrypted — flagged so it cannot be
      // mistaken for a production credential store.
      return wrapMockStorage();
    }
    // Production browser build — fail closed. The production network stack is
    // the native APK; a browser bundle must not persist credentials.
    throw new Error("secure_storage_unavailable");
  })();
  return storagePromise;
}

/** Adapt the plugin's scalar string-storage API to the vault's internal shape. */
export function wrapSecureStorage(impl: NativeSecureStorageLike): SecureStorageLike {
  return {
    async get(opts) {
      const value = await impl.getItem(opts.key);
      return value == null ? null : { value };
    },
    async set(opts) {
      await impl.setItem(opts.key, opts.value);
      return { value: opts.value };
    },
    async remove(opts) {
      try {
        await impl.removeItem(opts.key);
        return null;
      } catch {
        return null;
      }
    },
  };
}

function wrapMockStorage(): SecureStorageLike {
  const keyFor = (key: string) => `${MOCK_PREFIX}${key}`;
  return {
    async get(opts) {
      const v = localStorage.getItem(keyFor(opts.key));
      return v == null ? null : { value: v };
    },
    async set(opts) {
      localStorage.setItem(keyFor(opts.key), opts.value);
      return { value: opts.value };
    },
    async remove(opts) {
      const k = keyFor(opts.key);
      const v = localStorage.getItem(k);
      localStorage.removeItem(k);
      return v == null ? null : { value: v };
    },
  };
}

/**
 * Validate the persisted connection shape after parse. Defends against a
 * tampered or half-written entry — any invalid field returns false so the
 * caller clears the entry and routes back to pairing.
 */
function isStoredConnection(value: unknown): value is StoredConnection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.desktopName === "string" &&
    typeof v.deviceId === "string" &&
    typeof v.token === "string" &&
    Array.isArray(v.endpoints) &&
    typeof v.certificatePin === "object" &&
    v.certificatePin !== null &&
    typeof (v.certificatePin as Record<string, unknown>).value === "string" &&
    typeof v.identityEpoch === "number" &&
    typeof v.pairedAt === "string" &&
    (v.wakeOnLan === undefined || isValidWakeOnLanConfig(v.wakeOnLan))
  );
}

export const tokenVault = {
  /**
   * Load the stored connection, or null if never paired or the entry is
   * corrupt. A corrupt entry is cleared so the user can re-pair cleanly.
   */
  async load(): Promise<StoredConnection | null> {
    let storage: SecureStorageLike;
    try {
      storage = await getStorage();
    } catch {
      return null;
    }
    const result = await storage.get({ key: STORAGE_KEY });
    if (!result) return null;
    const raw = result.value;
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt JSON — clear and force re-pair.
      await storage.remove({ key: STORAGE_KEY });
      return null;
    }
    if (!isStoredConnection(parsed)) {
      await storage.remove({ key: STORAGE_KEY });
      return null;
    }
    // Validate the persisted pin shape (defense in depth). A bad pin would
    // explode later inside the TLS handshake; fail earlier and re-pair.
    try {
      assertValidHexPin(parsed.certificatePin.value);
    } catch {
      await storage.remove({ key: STORAGE_KEY });
      return null;
    }
    return parsed;
  },

  /** Persist the connection after a successful pairing. */
  async save(conn: StoredConnection): Promise<void> {
    const storage = await getStorage();
    await storage.set({ key: STORAGE_KEY, value: JSON.stringify(conn) });
  },

  /** Clear the stored connection (local "forget" — does not revoke on desktop). */
  async clear(): Promise<void> {
    let storage: SecureStorageLike;
    try {
      storage = await getStorage();
    } catch {
      return;
    }
    await storage.remove({ key: STORAGE_KEY });
  },

  /** True iff running on a native device with Keystore-backed storage. */
  isNativeSecure(): boolean {
    return isNative;
  },
};

/**
 * Build a StoredConnection from the pairing QR payload + the pair response.
 * This is the single place that translates the QR ticket into a persistent
 * connection record.
 */
export function buildStoredConnection(
  payload: PairingQrPayload,
  pairResult: PairingSuccess,
): StoredConnection {
  return {
    desktopName: payload.desktop.displayName,
    deviceId: pairResult.deviceId,
    token: pairResult.token,
    endpoints: payload.endpoints,
    certificatePin: payload.certificatePin,
    identityEpoch: 0, // Updated on first GET /me
    pairedAt: pairResult.serverTime ?? new Date().toISOString(),
    wakeOnLan: isValidWakeOnLanConfig(pairResult.wakeOnLan)
      ? pairResult.wakeOnLan
      : undefined,
  };
}

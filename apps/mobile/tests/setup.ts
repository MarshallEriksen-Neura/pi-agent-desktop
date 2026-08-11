/**
 * Vitest global setup — provides the minimal browser globals that the
 * token-vault's dev-browser fallback (`wrapMockStorage`) touches.
 *
 * The production Android path uses @aparajita/capacitor-secure-storage and
 * never touches localStorage; this polyfill only exists so the pure-logic
 * TS tests (which exercise the vault's corruption / forget paths) can run
 * in the fast node environment without spinning up jsdom.
 *
 * Each test file gets a fresh store via beforeEach in vitest's isolation.
 */
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const localStoragePolyfill: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: localStoragePolyfill,
    writable: true,
    configurable: true,
  });
}

// Some stores read `navigator.userAgent` to detect platform. Provide a stable
// userAgent so tests don't crash on `navigator` access.
if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node/vitest" },
    writable: true,
    configurable: true,
  });
}

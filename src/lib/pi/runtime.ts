"use client";

/**
 * Runtime configuration for Pi's command environment.
 *
 * Pi itself stays native so its settings, credentials, packages, and sessions
 * remain unchanged. In WSL mode its bash commands are routed through the
 * desktop executable's `-c` shell bridge into the selected distro.
 *
 * In browser preview (no Tauri) this is always native and inert.
 */

import { create } from "zustand";
import { getPort } from "../backend/composition/container";

export type RuntimeMode = "native" | "wsl";

export interface RuntimeConfig {
  mode: RuntimeMode;
  /** WSL distro name; "" = wsl.exe default distro. */
  distro: string;
  /** Native shell settings restored when leaving WSL mode. */
  nativeShellPath?: string | null;
  nativeShellCommandPrefix?: string | null;
  nativeShellSaved?: boolean;
}

const DEFAULT_CONFIG: RuntimeConfig = { mode: "native", distro: "" };

interface RuntimeStore {
  config: RuntimeConfig;
  persistedConfig: RuntimeConfig;
  distros: string[];
  loaded: boolean;
  busy: boolean;
  lastError: string | null;

  /** Load persisted config on app start; never blocks Pi on WSL discovery. */
  load: () => Promise<void>;
  /** Discover installed distros lazily when the settings section is visible. */
  loadDistros: () => Promise<void>;
  /** Update the settings-page draft without changing the active runtime. */
  setConfig: (config: RuntimeConfig) => void;
  /** Persist a validated config. Does NOT restart pi. */
  save: (config: RuntimeConfig) => Promise<void>;
}

function runtimePort() {
  return getPort("runtimeConfig");
}

export const useRuntime = create<RuntimeStore>((set) => ({
  config: DEFAULT_CONFIG,
  persistedConfig: DEFAULT_CONFIG,
  distros: [],
  loaded: false,
  busy: false,
  lastError: null,

  load: async () => {
    try {
      const config = await runtimePort().read();
      const loadedConfig = config ?? DEFAULT_CONFIG;
      set({
        config: loadedConfig,
        persistedConfig: loadedConfig,
        loaded: true,
        lastError: null,
      });
    } catch (e) {
      set({ loaded: true, lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  loadDistros: async () => {
    try {
      const distros = await runtimePort().listWslDistros();
      set({ distros: distros ?? [], lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  setConfig: (config) => set({ config }),

  save: async (config) => {
    set({ config });
    set({ busy: true });
    try {
      await runtimePort().write(config);
      set({ persistedConfig: config, lastError: null });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      set({ lastError: error.message });
      throw error;
    } finally {
      set({ busy: false });
    }
  },
}));

export function resetRuntimeStoreForTests(): void {
  useRuntime.setState({
    config: DEFAULT_CONFIG,
    persistedConfig: DEFAULT_CONFIG,
    distros: [],
    loaded: false,
    busy: false,
    lastError: null,
  });
}

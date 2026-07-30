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
import { isTauri } from "./client";

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

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

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

export const useRuntime = create<RuntimeStore>((set) => ({
  config: DEFAULT_CONFIG,
  persistedConfig: DEFAULT_CONFIG,
  distros: [],
  loaded: false,
  busy: false,
  lastError: null,

  load: async () => {
    if (!isTauri()) {
      set({ loaded: true });
      return;
    }
    try {
      const config = await tauriInvoke<RuntimeConfig>("runtime_config_read");
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
    if (!isTauri()) return;
    try {
      const distros = await tauriInvoke<string[]>("wsl_list_distros");
      set({ distros: distros ?? [], lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  setConfig: (config) => set({ config }),

  save: async (config) => {
    set({ config });
    if (!isTauri()) {
      set({ persistedConfig: config });
      return;
    }
    set({ busy: true });
    try {
      await tauriInvoke("runtime_config_write", { config });
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

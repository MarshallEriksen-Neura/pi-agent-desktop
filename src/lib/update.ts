"use client";

/**
 * Software-update state.
 * The desktop adapter uses Tauri's built-in updater plugin
 * for self-update: `check()` compares the running version against the GitHub
 * release `latest.json`, and `apply()` downloads + installs + relaunches.
 * The Pi CLI update is handled separately by `useCliUpdate` (Rust `pi_cli_update_check`).
 * In the browser preview the store runs a mock so the page is explorable.
 */

import { create } from "zustand";
import { getBackendKind, getPort } from "./backend/composition/container";
import pkg from "../../package.json";

/** Version from package.json — kept in sync automatically. */
export const APP_VERSION = pkg.version;

export interface UpdateInfo {
  configured: boolean;
  repoUrl: string;
  currentVersion: string;
  latestVersion: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "unconfigured"
  | "upToDate"
  | "available"
  | "applying"
  | "error";

/** Sentinel error meaning "install is desktop-only" in the browser preview. */
export const MOCK_APPLY_ERROR = "mock-preview";

interface UpdateState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  error: string | null;
  lastCheckedAt: number | null;
  mock: boolean;
  /** User closed the top-bar reminder — stays hidden until the next launch. */
  dismissed: boolean;
  check: () => Promise<void>;
  apply: () => Promise<void>;
  dismiss: () => void;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useUpdate = create<UpdateState>((set, get) => ({
  phase: "idle",
  info: null,
  error: null,
  lastCheckedAt: null,
  mock: false,
  dismissed: false,

  check: async () => {
    const { phase } = get();
    if (phase === "checking" || phase === "applying") return;
    set({ phase: "checking", error: null });
    try {
      const mock = getBackendKind() === "browser-preview";
      if (mock) await delay(900);
      const info = await getPort("updater").check();
      set({
        mock,
        info,
        lastCheckedAt: Date.now(),
        phase: !info.configured
          ? "unconfigured"
          : info.updateAvailable
            ? "available"
            : "upToDate",
      });
    } catch (e) {
      set({ phase: "error", error: String(e), lastCheckedAt: Date.now() });
    }
  },

  apply: async () => {
    if (get().phase !== "available") return;
    set({ phase: "applying", error: null });
    try {
      if (get().mock) await delay(1600);
      await getPort("updater").downloadAndInstall();
      await getPort("updater").relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ phase: "available", error: msg });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));

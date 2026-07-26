"use client";

/**
 * Software-update state — wraps the Rust `update_check` / `update_apply`
 * commands (remote git tag query). In the browser preview the store runs a
 * mock that shows the "update available" flow so the page is explorable.
 */

import { create } from "zustand";
import { isTauri } from "./pi/client";

/** Mirrors tauri.conf.json / Cargo.toml — shown before the first check lands. */
export const APP_VERSION = "0.1.0";

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
  check: () => Promise<void>;
  apply: () => Promise<void>;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const MOCK_INFO: UpdateInfo = {
  configured: true,
  repoUrl: "https://github.com/pi-agent/pi-desktop.git",
  currentVersion: APP_VERSION,
  latestVersion: "v0.2.0",
  latestCommit: "9f3ab12",
  updateAvailable: true,
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useUpdate = create<UpdateState>((set, get) => ({
  phase: "idle",
  info: null,
  error: null,
  lastCheckedAt: null,
  mock: !isTauri(),

  check: async () => {
    const { phase } = get();
    if (phase === "checking" || phase === "applying") return;
    set({ phase: "checking", error: null });
    try {
      let info: UpdateInfo;
      if (get().mock) {
        await delay(900);
        info = MOCK_INFO;
      } else {
        info = await invoke<UpdateInfo>("update_check");
      }
      set({
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
      if (get().mock) {
        await delay(1600);
        throw new Error(MOCK_APPLY_ERROR);
      }
      await invoke<void>("update_apply");
      // The real pipeline relaunches the app; nothing to do here yet.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ phase: "available", error: msg });
    }
  },
}));

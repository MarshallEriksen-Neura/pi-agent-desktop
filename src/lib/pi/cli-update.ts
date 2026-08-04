"use client";

/**
 * pi CLI update state — the desktop app is a GUI over the `pi` binary, which
 * updates itself with `pi update`. Checking wraps the Rust
 * `pi_cli_update_check` command (git tag query against pi-mono); applying
 * reuses the existing `pi_cli` command. Outside Tauri (browser preview)
 * there is no pi binary to reach, so checks are skipped instead of mocked.
 */

import { create } from "zustand";
import { getBackendKind, getPort } from "../backend/composition/container";

export interface PiCliUpdateInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

export type CliUpdatePhase =
  | "idle"
  | "checking"
  | "notFound" // pi binary missing from PATH
  | "upToDate"
  | "available"
  | "updating"
  | "updated" // pi update succeeded — restart pi to load it
  | "error";

/** localStorage key holding a version the user chose to skip. */
const SKIP_KEY = "pi-cli-skip-version";

interface CliUpdateState {
  phase: CliUpdatePhase;
  info: PiCliUpdateInfo | null;
  error: string | null;
  /** Trailing `pi update` output, for the failure state. */
  output: string | null;
  /** Launch reminder visibility (toast). */
  promptVisible: boolean;
  /** Silent startup check — pops the toast when an unskipped update exists. */
  checkOnLaunch: () => Promise<void>;
  /** Manual check from the update page — surfaces errors. */
  check: () => Promise<void>;
  /** Run `pi update` through the existing pi_cli Tauri command. */
  apply: () => Promise<void>;
  /** Close the toast for this session only. */
  later: () => void;
  /** Never remind again for the currently offered version. */
  skip: () => void;
}

function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

function phaseFor(info: PiCliUpdateInfo): CliUpdatePhase {
  if (!info.installed) return "notFound";
  return info.updateAvailable ? "available" : "upToDate";
}

export const useCliUpdate = create<CliUpdateState>((set, get) => ({
  phase: "idle",
  info: null,
  error: null,
  output: null,
  promptVisible: false,

  checkOnLaunch: async () => {
    if (getBackendKind() !== "desktop-tauri") return; // browser preview — no pi binary, no reminder
    // React strict-mode double effect / AppShell remount guard
    if (get().phase !== "idle") return;
    set({ phase: "checking" });
    try {
      const info = await getPort("piConfiguration").checkPiCliUpdate();
      const phase = phaseFor(info);
      set({
        info,
        phase,
        promptVisible:
          phase === "available" && info.latest !== skippedVersion(),
      });
    } catch {
      // Startup check is best-effort (offline, git missing…) — stay quiet.
      set({ phase: "idle" });
    }
  },

  check: async () => {
    const { phase } = get();
    if (phase === "checking" || phase === "updating") return;
    if (getBackendKind() !== "desktop-tauri") {
      set({
        info: { installed: null, latest: null, updateAvailable: false },
        phase: "notFound",
        error: null,
      });
      return;
    }
    set({ phase: "checking", error: null });
    try {
      const info = await getPort("piConfiguration").checkPiCliUpdate();
      set({ info, phase: phaseFor(info) });
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },

  apply: async () => {
    const { phase } = get();
    if (phase !== "available" && phase !== "error") return;
    set({ phase: "updating", error: null, output: null });
    try {
      const r = await getPort("piConfiguration").runPiCli(["update"], null);
      if (r.code !== 0) {
        throw new Error(
          (r.stderr || r.stdout || `pi update exited with ${r.code}`)
            .trim()
            .slice(-500)
        );
      }
      set({ phase: "updated", output: r.stdout.trim().slice(-500) || null });
    } catch (e) {
      set({
        phase: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  later: () => set({ promptVisible: false }),

  skip: () => {
    const latest = get().info?.latest;
    if (latest) {
      try {
        localStorage.setItem(SKIP_KEY, latest);
      } catch {
        // private mode etc. — session-only dismissal still applies
      }
    }
    set({ promptVisible: false });
  },
}));

"use client";

/**
 * pi settings.json access — read, deep-merge view, edit, write-through.
 *
 * pi has no settings RPC ( /settings is TUI-only ), so the desktop app edits
 * the JSON files directly via the Tauri `pi_settings_*` commands and restarts
 * the pi process to apply. In browser preview everything runs on an in-memory
 * mock so the Settings UI is fully explorable.
 *
 * File locations (identical scheme on Windows & macOS — pi uses homedir()):
 *   global : ~/.pi/agent/settings.json
 *   project: <project root>/.pi/settings.json   (overrides global, deep-merged)
 */

import { create } from "zustand";
import { getBackendKind, getPort } from "../backend/composition/container";
import { usePi } from "./store";
import { useWorkspace } from "../workspace";

/** Currently open project root — scopes "project" settings & pi CLI runs. */
function projectRoot(): string | null {
  return useWorkspace.getState().root || null;
}

export type SettingsScope = "global" | "project";

/** package entry in settings.json — string or filtered object form */
export type PackageEntry =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
      autoload?: boolean;
    };

export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  hideThinkingBlock?: boolean;
  showCacheMissNotices?: boolean;
  thinkingBudgets?: Record<string, number>;
  theme?: string;
  externalEditor?: string;
  quietStartup?: boolean;
  defaultProjectTrust?: "ask" | "always" | "never";
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  httpProxy?: string;
  warnings?: { anthropicExtraUsage?: boolean };
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
  };
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  transport?: "auto" | "sse" | "websocket" | "websocket-cached";
  httpIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  images?: { autoResize?: boolean; blockImages?: boolean };
  shellPath?: string;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  /**
   * Built-in tools pi enables at startup. Three distinct states:
   * `undefined` → pi's own defaults, `[]` → no built-ins (extension/SDK tools
   * survive), non-empty → exactly these. A project array *replaces* the global
   * one rather than merging, which `mergeSettings` already does for arrays.
   */
  defaultTools?: string[];
  sessionDir?: string;
  enabledModels?: string[];
  packages?: PackageEntry[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  enableSkillCommands?: boolean;
  [key: string]: unknown; // preserve keys we don't model (lastChangelogVersion, …)
}

export function packageSource(p: PackageEntry): string {
  return typeof p === "string" ? p : p.source;
}

/** deep merge: project over global — mirrors pi's own merge (settings.md) */
export function mergeSettings(global: PiSettings, project: PiSettings): PiSettings {
  const out: PiSettings = { ...global };
  for (const [k, v] of Object.entries(project)) {
    const g = out[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      g && typeof g === "object" && !Array.isArray(g)
    ) {
      out[k] = { ...(g as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface ScopeFile {
  path: string;
  exists: boolean;
  /** parsed content; null = file missing or parse error */
  data: PiSettings | null;
  parseError: string | null;
}

const EMPTY_SCOPE: ScopeFile = { path: "", exists: false, data: null, parseError: null };

interface PiSettingsStore {
  mock: boolean;
  loaded: boolean;
  busy: boolean;
  /** true after a write until pi is restarted */
  dirtyRestart: boolean;
  lastError: string | null;
  global: ScopeFile;
  project: ScopeFile;

  load: () => Promise<void>;
  /** merged view the running pi would see */
  effective: () => PiSettings;
  /** shallow-set a key in one scope's file and persist (read-merge-write) */
  setKey: (scope: SettingsScope, key: string, value: unknown) => Promise<void>;
  /**
   * set a nested key via dotted path ("retry.provider.timeoutMs") and persist.
   * value === undefined deletes the leaf and prunes empty parent objects.
   */
  setPath: (scope: SettingsScope, path: string, value: unknown) => Promise<void>;
  /** update the packages array in one scope and persist */
  setPackages: (scope: SettingsScope, packages: PackageEntry[]) => Promise<void>;
  /** run a pi package CLI command (install/remove/update/list) */
  runPiCli: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** stop + start pi so file edits take effect, then refresh RPC state */
  restartPi: () => Promise<void>;
}

function parseScope(raw: { path: string; exists: boolean; content: string }): ScopeFile {
  if (!raw.exists || !raw.content.trim()) {
    return { path: raw.path, exists: raw.exists, data: raw.exists ? {} : null, parseError: null };
  }
  try {
    return { path: raw.path, exists: true, data: JSON.parse(raw.content), parseError: null };
  } catch (e) {
    return {
      path: raw.path,
      exists: true,
      data: null,
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
}

export const usePiSettings = create<PiSettingsStore>((set, get) => ({
  mock: false,
  loaded: false,
  busy: false,
  dirtyRestart: false,
  lastError: null,
  global: EMPTY_SCOPE,
  project: EMPTY_SCOPE,

  load: async () => {
    const isMock = getBackendKind() === "browser-preview";
    try {
      const piConfiguration = getPort("piConfiguration");
      const [g, p] = await Promise.all([
        piConfiguration.readSettings("global"),
        piConfiguration.readSettings("project", projectRoot()),
      ]);
      set({
        mock: isMock,
        loaded: true,
        global: parseScope(g),
        project: parseScope(p),
        lastError: null,
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  effective: () => {
    const { global, project } = get();
    return mergeSettings(global.data ?? {}, project.data ?? {});
  },

  setKey: async (scope, key, value) => {
    const st = get();
    const file = st[scope];
    if (file.parseError) {
      set({ lastError: `${file.path} has invalid JSON — fix it in the editor first` });
      return;
    }
    const next: PiSettings = { ...(file.data ?? {}) };
    if (value === undefined) delete next[key];
    else next[key] = value;

    // optimistic local update
    set({ [scope]: { ...file, exists: true, data: next } } as never);

    try {
      await getPort("piConfiguration").writeSettings(
        scope,
        JSON.stringify(next, null, 2) + "\n",
        scope === "project" ? projectRoot() : null
      );
      set({ dirtyRestart: true, lastError: null });
    } catch (e) {
      set({ [scope]: file, lastError: e instanceof Error ? e.message : String(e) } as never);
    }
  },

  setPath: async (scope, path, value) => {
    const segs = path.split(".");
    if (segs.length === 1) return get().setKey(scope, path, value);

    const file = get()[scope];
    const top = segs[0];
    const topVal = (file.data ?? {})[top];
    const root: Record<string, unknown> =
      topVal && typeof topVal === "object" && !Array.isArray(topVal)
        ? structuredClone(topVal as Record<string, unknown>)
        : {};

    // walk to the leaf's parent, creating intermediate objects
    let node = root;
    for (const seg of segs.slice(1, -1)) {
      const next = node[seg];
      if (!next || typeof next !== "object" || Array.isArray(next)) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1];
    if (value === undefined) delete node[leaf];
    else node[leaf] = value;

    // prune now-empty intermediate objects bottom-up (delete only)
    if (value === undefined) {
      for (let depth = segs.length - 2; depth >= 1; depth--) {
        let parent = root;
        for (const seg of segs.slice(1, depth)) parent = parent[seg] as Record<string, unknown>;
        const child = parent[segs[depth]];
        if (child && typeof child === "object" && Object.keys(child).length === 0) {
          delete parent[segs[depth]];
        }
      }
    }

    await get().setKey(scope, top, Object.keys(root).length === 0 ? undefined : root);
  },

  setPackages: async (scope, packages) => {
    await get().setKey(scope, "packages", packages);
  },

  runPiCli: async (args) => {
    set({ busy: true });
    try {
      return await getPort("piConfiguration").runPiCli(args, projectRoot());
    } finally {
      set({ busy: false });
    }
  },

  restartPi: async () => {
    set({ busy: true });
    try {
      // restart pi inside the currently open project
      await usePi.getState().restart(projectRoot() ?? undefined);
      await get().load();
      set({ dirtyRestart: false, lastError: null });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ busy: false });
    }
  },
}));

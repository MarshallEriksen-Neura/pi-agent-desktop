"use client";

import { create } from "zustand";
import { useAppearance } from "./appearance";
import {
  SEND_SHORTCUT_DEFAULT,
  isSendShortcut,
  type SendShortcut,
} from "./composer-shortcut";
import {
  parseShortcutOverrides,
  type Binding,
  type ShortcutOverrides,
} from "./shortcuts";

import {
  AUTO_TERMINAL_SHELL_PROFILE,
  loadTerminalShellProfile,
  parseTerminalShellProfile,
  persistTerminalShellProfile,
  type LocalTerminalShellProfile,
} from "./terminal-shell-profile";
export type Theme = "light" | "dark";
export type TaskStatus = "done" | "running" | "queued" | "error";

/**
 * Which layout the app lives in. One setting rather than two orthogonal-looking
 * knobs: "IDE off" *is* permanent work mode, so a separate boolean would leave a
 * dead combination (IDE off + startup "default") that the user can select and
 * that means nothing. A third enum value also keeps room for future layouts —
 * add a variant, not a dimension.
 *
 * - `default`   — sidebar + editor + docked chat rail; work mode is a toggle
 * - `work`      — opens in the centered chat column, ⌘/ still returns to the IDE
 * - `work-only` — permanent chat column; the editor never mounts and every IDE
 *                 entry point (top-bar toggle, ⌘/, palette command) is hidden
 */
export type LayoutMode = "default" | "work" | "work-only";

const LAYOUT_MODES: readonly LayoutMode[] = ["default", "work", "work-only"];

/**
 * Guards the value read back from storage. Anything unrecognized — a key written
 * by an older build, or hand-edited — falls back to `default` rather than putting
 * the app in a layout no branch handles.
 */
function isLayoutMode(v: string | null): v is LayoutMode {
  return v !== null && (LAYOUT_MODES as readonly string[]).includes(v);
}

const THEME_STORAGE_KEY = "pi-desktop.theme";
const CLOSE_BEHAVIOR_STORAGE_KEY = "pi-desktop.closeBehavior";
const AGENT_PANEL_WIDTH_STORAGE_KEY = "pi-desktop.agentPanelWidth";
const SUBAGENT_PANEL_WIDTH_STORAGE_KEY = "pi-desktop.subagentPanelWidth";
const INSPECTOR_PANEL_WIDTH_STORAGE_KEY = "pi-desktop.inspectorPanelWidth";
const TERMINAL_HEIGHT_STORAGE_KEY = "pi-desktop.terminalHeight";
const SEND_SHORTCUT_STORAGE_KEY = "pi-desktop.sendShortcut";
const SHORTCUTS_STORAGE_KEY = "pi-desktop.shortcuts";
const LAYOUT_MODE_STORAGE_KEY = "pi-desktop.layoutMode";

/** Docked chat rail width, in px. Only applies in the default layout —
 *  work mode stretches the panel to a centered reading column, zen mode hides it. */
export const AGENT_PANEL_WIDTH_DEFAULT = 320;
/**
 * Narrower than this and the composer's bottom row (model + thinking pickers,
 * plus the delivery toggle while a turn runs) stops fitting. At this width the
 * model chip truncates to keep the row intact — see ComposerInput.
 */
export const AGENT_PANEL_WIDTH_MIN = 280;
export const AGENT_PANEL_WIDTH_MAX = 900;

/** Subagent inspector column width, in px — a docked panel, same as the rail. */
export const SUBAGENT_PANEL_WIDTH_DEFAULT = 420;
/** Below this the tool feed's `name + args` rows stop being readable. */
export const SUBAGENT_PANEL_WIDTH_MIN = 320;
export const SUBAGENT_PANEL_WIDTH_MAX = 720;

/**
 * File inspector column width, in px. Wider by default than the subagent
 * inspector: this one holds two line-number gutters and unwrapped code, so the
 * same 420px that reads fine for a tool feed puts a diff into horizontal
 * scrolling on almost every line.
 */
export const INSPECTOR_PANEL_WIDTH_DEFAULT = 480;
/** Below this the two gutters plus a sign plus code stops being worth reading. */
export const INSPECTOR_PANEL_WIDTH_MIN = 360;
export const INSPECTOR_PANEL_WIDTH_MAX = 860;

/**
 * Terminal drawer height, in px — the one panel measured on the vertical axis.
 *
 * The ceiling is not a constant here the way the column ceilings are: the drawer
 * shares the window's height with the chat and the editor, so how tall it may
 * grow depends on the viewport. The drawer caps itself against that at drag
 * time; these bounds are the absolute floor and the sanity ceiling.
 */
export const TERMINAL_HEIGHT_DEFAULT = 240;
/** Header plus a couple of rows — below this the shell stops being usable. */
export const TERMINAL_HEIGHT_MIN = 120;
export const TERMINAL_HEIGHT_MAX = 900;
/**
 * How much of the window the drawer must leave to everything above it: the top
 * bar, a few transcript rows, and the composer. Past that the drawer has taken
 * over a window it only shares.
 */
export const APP_MIN_HEIGHT_BESIDE_TERMINAL = 260;

// what happens when the user closes the main window
export type CloseBehavior = "ask" | "minimize" | "quit";

/** sync <html> with the active theme (data-theme + Appica UI .light/.dark classes) */
function applyThemeDom(theme: Theme) {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.classList.toggle("dark", theme === "dark");
  el.classList.toggle("light", theme === "light");
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** the OS light/dark preference; dark when it can't be read */
function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
}

/**
 * Where the active theme came from. "system" tracks the OS live; "user" pins
 * the explicit choice (toggling is what makes it explicit) and survives
 * restarts. Only "user" is persisted — absence of the key means "follow the OS",
 * so a fresh install adopts the system theme instead of forcing dark.
 */
export type ThemeSource = "system" | "user";

let stopThemeWatch: (() => void) | null = null;

const clampAgentPanelWidth = (px: number) =>
  Math.round(Math.min(AGENT_PANEL_WIDTH_MAX, Math.max(AGENT_PANEL_WIDTH_MIN, px)));

const clampSubagentPanelWidth = (px: number) =>
  Math.round(
    Math.min(SUBAGENT_PANEL_WIDTH_MAX, Math.max(SUBAGENT_PANEL_WIDTH_MIN, px)),
  );

const clampInspectorPanelWidth = (px: number) =>
  Math.round(
    Math.min(INSPECTOR_PANEL_WIDTH_MAX, Math.max(INSPECTOR_PANEL_WIDTH_MIN, px)),
  );

const clampTerminalHeight = (px: number) =>
  Math.round(Math.min(TERMINAL_HEIGHT_MAX, Math.max(TERMINAL_HEIGHT_MIN, px)));

export interface NotificationSettings {
  enabled: boolean;
}

export interface PendingReview {
  file: string;
  oldLine: string;
  newLine: string;
}

/* resolver lives outside React — the demo awaits the user's verdict */
let reviewResolver: ((accept: boolean) => void) | null = null;

interface UIState {
  theme: Theme;
  themeSource: ThemeSource;
  zenMode: boolean;
  workMode: boolean;
  /** persisted layout choice; `workMode` is the live state derived from it */
  layoutMode: LayoutMode;
  /**
   * False until the saved layout has been read back. The panels stay unmounted
   * until then so the editor is never mounted-then-torn-down on a work-mode
   * launch. The boot screen covers this — it lifts two frames after mount.
   */
  layoutReady: boolean;
  sidebarOpen: boolean;
  agentPanelOpen: boolean;
  /** user-dragged width of the docked chat rail (px) */
  agentPanelWidth: number;
  /** true only while the divider is being dragged — suppresses the width spring */
  agentPanelResizing: boolean;
  /** user-dragged width of the docked subagent inspector (px) */
  subagentPanelWidth: number;
  subagentPanelResizing: boolean;
  /** user-dragged width of the docked file inspector (px) */
  inspectorPanelWidth: number;
  inspectorPanelResizing: boolean;
  commandPaletteOpen: boolean;
  terminalOpen: boolean;
  /** user-dragged height of the terminal drawer (px) */
  terminalHeight: number;
  /** App-local preference for newly launched native local PTYs. */
  terminalShellProfile: LocalTerminalShellProfile;
  /** True after the persisted terminal shell preference has been restored on the client. */
  terminalShellProfileReady: boolean;
  terminalResizing: boolean;
  activeFile: string;

  /* agent run state */
  agentRunning: boolean;
  demoTick: number; // bump to ask the editor to run the streaming demo
  pendingReview: PendingReview | null;

  /* notification settings */
  notificationSettings: NotificationSettings;

  /* window close behavior */
  closeBehavior: CloseBehavior;
  closeDialogOpen: boolean;

  /** which key combination sends a message from the chat composer */
  sendShortcut: SendShortcut;

  /**
   * Rebound keyboard chords, keyed by registry id. Only what the user changed —
   * an absent id means the shipped default in `SHORTCUT_REGISTRY`.
   */
  shortcutOverrides: ShortcutOverrides;

  toggleTheme: () => void;
  /** adopt an explicit theme (pins it as the user's choice) */
  setTheme: (theme: Theme) => void;
  /** drop the pinned choice and track the OS again */
  useSystemTheme: () => void;
  /**
   * Restore the saved theme, or adopt the OS one, and start tracking OS
   * changes. Call once on mount; safe to call again (the watcher is replaced).
   */
  initTheme: () => void;
  toggleZen: () => void;
  /** no-op in `work-only`, where the chat column is the only layout */
  toggleWork: () => void;
  /** persist the layout choice and switch to it now */
  setLayoutMode: (mode: LayoutMode) => void;
  /** restore the saved layout before the editor is allowed to mount */
  initLayout: () => void;
  toggleSidebar: () => void;
  toggleAgentPanel: () => void;
  /** live width during a drag — clamped, not persisted (call persist on release) */
  setAgentPanelWidth: (px: number) => void;
  /** write the current width to storage; call once when the drag settles */
  persistAgentPanelWidth: () => void;
  setAgentPanelResizing: (resizing: boolean) => void;
  /** back to the stock 320px rail and forget the saved width */
  resetAgentPanelWidth: () => void;
  /** restore the saved rail width — call once on mount */
  initAgentPanelWidth: () => void;
  setSubagentPanelWidth: (px: number) => void;
  persistSubagentPanelWidth: () => void;
  setSubagentPanelResizing: (resizing: boolean) => void;
  resetSubagentPanelWidth: () => void;
  initSubagentPanelWidth: () => void;
  setInspectorPanelWidth: (px: number) => void;
  persistInspectorPanelWidth: () => void;
  setInspectorPanelResizing: (resizing: boolean) => void;
  resetInspectorPanelWidth: () => void;
  initInspectorPanelWidth: () => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  setTerminalHeight: (px: number) => void;
  persistTerminalHeight: () => void;
  setTerminalResizing: (resizing: boolean) => void;
  resetTerminalHeight: () => void;
  initTerminalHeight: () => void;
  setTerminalShellProfile: (profile: LocalTerminalShellProfile) => void;
  /** Restore the shell preference; corrupt or obsolete values resolve to Auto. */
  initTerminalShellProfile: () => void;
  setCommandPalette: (open: boolean) => void;
  setActiveFile: (file: string) => void;

  /* real agent run — driven by pi tool events via agent-bridge */
  beginAgentRun: () => void;
  endAgentRun: () => void;
  startDemo: () => void;
  finishDemo: () => void;
  requestReview: (r: PendingReview) => Promise<boolean>;
  resolveReview: (accept: boolean) => void;
  setNotificationEnabled: (enabled: boolean) => void;
  setCloseBehavior: (b: CloseBehavior) => void;
  /** restore the saved close behavior — call once on mount */
  initCloseBehavior: () => void;
  setCloseDialogOpen: (open: boolean) => void;
  setSendShortcut: (s: SendShortcut) => void;
  /** restore the saved composer send shortcut — call once on mount */
  initSendShortcut: () => void;
  /** rebind one command; the caller is responsible for rejecting conflicts */
  setShortcutBinding: (id: string, binding: Binding) => void;
  /** drop one override, returning that command to its shipped chord */
  resetShortcutBinding: (id: string) => void;
  /** drop every override */
  resetAllShortcuts: () => void;
  /** restore the saved chord overrides — call once on mount */
  initShortcuts: () => void;
}

/**
 * Write the override map and hand back the state patch.
 *
 * An empty map removes the key rather than storing `{}` — "no overrides" and
 * "never touched" should not read differently on disk, and a stale `{}` is one
 * more thing a future migration would have to recognize.
 */
function persistShortcuts(overrides: ShortcutOverrides): Pick<UIState, "shortcutOverrides"> {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(SHORTCUTS_STORAGE_KEY);
    } else {
      localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // storage unavailable — keep the rebinds in-memory only
  }
  return { shortcutOverrides: overrides };
}

export const useUI = create<UIState>((set) => ({
  // matches the SSR <html> default; initTheme() reconciles with storage/OS
  theme: "dark",
  themeSource: "system",
  zenMode: false,
  workMode: false,
  layoutMode: "default",
  layoutReady: false,
  sidebarOpen: true,
  agentPanelOpen: true,
  agentPanelWidth: AGENT_PANEL_WIDTH_DEFAULT,
  subagentPanelWidth: SUBAGENT_PANEL_WIDTH_DEFAULT,
  subagentPanelResizing: false,
  inspectorPanelWidth: INSPECTOR_PANEL_WIDTH_DEFAULT,
  inspectorPanelResizing: false,
  agentPanelResizing: false,
  commandPaletteOpen: false,
  activeFile: "src/lib/agent.ts",

  terminalOpen: false,
  terminalHeight: TERMINAL_HEIGHT_DEFAULT,
  terminalShellProfile: AUTO_TERMINAL_SHELL_PROFILE,
  terminalShellProfileReady: false,
  terminalResizing: false,
  agentRunning: false,
  demoTick: 0,
  pendingReview: null,
  notificationSettings: { enabled: true },
  closeBehavior: "ask",
  closeDialogOpen: false,
  sendShortcut: SEND_SHORTCUT_DEFAULT,
  shortcutOverrides: {},

  /**
   * system → light → dark → system. Three-way rather than a plain flip because
   * pinning a theme has to stay undoable: a two-way toggle would strand the user
   * off the OS track with no way back to it from the top bar.
   */
  toggleTheme: () => {
    const { theme, themeSource, setTheme, useSystemTheme } = useUI.getState();
    if (themeSource === "system") setTheme("light");
    else if (theme === "light") setTheme("dark");
    else useSystemTheme();
  },
  setTheme: (theme) =>
    set(() => {
      applyThemeDom(theme);
      // re-derive appearance overrides that depend on the theme (bg image base)
      useAppearance.getState().set({});
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        // storage unavailable (private mode) — keep the choice in-memory only
      }
      return { theme, themeSource: "user" as const };
    }),
  useSystemTheme: () =>
    set(() => {
      const theme = systemTheme();
      applyThemeDom(theme);
      useAppearance.getState().set({});
      try {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } catch {
        // storage unavailable — the in-memory source still tracks the OS
      }
      return { theme, themeSource: "system" as const };
    }),
  initTheme: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        // storage unavailable — fall through to the OS preference
      }
      const pinned: Theme | null = saved === "light" || saved === "dark" ? saved : null;
      const theme: Theme = pinned ?? systemTheme();

      // Always write the DOM: <html> ships a hardcoded dark default for SSR, so
      // skipping this when theme === state left a light-OS user on dark chrome.
      applyThemeDom(theme);

      // One watcher per process — initTheme is idempotent under Fast Refresh.
      stopThemeWatch?.();
      const mq = typeof window !== "undefined" ? window.matchMedia?.(DARK_QUERY) : null;
      if (mq) {
        const onChange = (event: MediaQueryListEvent) => {
          // A pinned choice outranks the OS; keep tracking so unpinning is live.
          if (useUI.getState().themeSource !== "system") return;
          const next: Theme = event.matches ? "dark" : "light";
          applyThemeDom(next);
          useUI.setState({ theme: next });
          // appearance reads data-theme, so this must follow applyThemeDom
          useAppearance.getState().set({});
        };
        mq.addEventListener("change", onChange);
        stopThemeWatch = () => mq.removeEventListener("change", onChange);
      }

      return { theme, themeSource: pinned ? ("user" as const) : ("system" as const) };
    }),
  toggleZen: () => set((s) => ({ zenMode: !s.zenMode })),
  toggleWork: () =>
    set((s) => (s.layoutMode === "work-only" ? {} : { workMode: !s.workMode })),
  setLayoutMode: (mode) =>
    set(() => {
      try {
        localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, mode);
      } catch {
        // storage unavailable — keep the choice in-memory only
      }
      // Apply immediately rather than only on next launch: picking a layout in
      // settings and seeing nothing happen reads as a broken control.
      return { layoutMode: mode, workMode: mode !== "default" };
    }),
  initLayout: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
      } catch {
        // storage unavailable — fall back to the pre-setting default layout
      }
      const layoutMode: LayoutMode = isLayoutMode(saved) ? saved : "default";
      return { layoutMode, workMode: layoutMode !== "default", layoutReady: true };
    }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleAgentPanel: () => set((s) => ({ agentPanelOpen: !s.agentPanelOpen })),
  /**
   * Storage is deliberately not touched here: a drag fires this once per frame,
   * so persisting inline would mean ~60 synchronous localStorage writes a second.
   * The caller writes once on pointer release instead.
   */
  setAgentPanelWidth: (px) =>
    set((s) => {
      const width = clampAgentPanelWidth(px);
      return width === s.agentPanelWidth ? {} : { agentPanelWidth: width };
    }),
  persistAgentPanelWidth: () => {
    try {
      localStorage.setItem(
        AGENT_PANEL_WIDTH_STORAGE_KEY,
        String(useUI.getState().agentPanelWidth),
      );
    } catch {
      // storage unavailable (private mode) — the width stays for this session only
    }
  },
  setAgentPanelResizing: (resizing) => set({ agentPanelResizing: resizing }),
  resetAgentPanelWidth: () =>
    set(() => {
      try {
        localStorage.removeItem(AGENT_PANEL_WIDTH_STORAGE_KEY);
      } catch {
        // storage unavailable — the in-memory reset still applies
      }
      return { agentPanelWidth: AGENT_PANEL_WIDTH_DEFAULT };
    }),
  initAgentPanelWidth: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(AGENT_PANEL_WIDTH_STORAGE_KEY);
      } catch {
        // storage unavailable — stay on the default rail width
      }
      const px = saved === null ? NaN : Number(saved);
      if (!Number.isFinite(px)) return {};
      return { agentPanelWidth: clampAgentPanelWidth(px) };
    }),

  /* subagent inspector — same contract as the rail above: drag updates in
     memory, the caller persists once on pointer release */
  setSubagentPanelWidth: (px) =>
    set((s) => {
      const width = clampSubagentPanelWidth(px);
      return width === s.subagentPanelWidth ? {} : { subagentPanelWidth: width };
    }),
  persistSubagentPanelWidth: () => {
    try {
      localStorage.setItem(
        SUBAGENT_PANEL_WIDTH_STORAGE_KEY,
        String(useUI.getState().subagentPanelWidth),
      );
    } catch {
      // storage unavailable (private mode) — the width stays for this session only
    }
  },
  setSubagentPanelResizing: (resizing) => set({ subagentPanelResizing: resizing }),
  resetSubagentPanelWidth: () =>
    set(() => {
      try {
        localStorage.removeItem(SUBAGENT_PANEL_WIDTH_STORAGE_KEY);
      } catch {
        // storage unavailable — the in-memory reset still applies
      }
      return { subagentPanelWidth: SUBAGENT_PANEL_WIDTH_DEFAULT };
    }),
  initSubagentPanelWidth: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(SUBAGENT_PANEL_WIDTH_STORAGE_KEY);
      } catch {
        // storage unavailable — stay on the default inspector width
      }
      const px = saved === null ? NaN : Number(saved);
      if (!Number.isFinite(px)) return {};
      return { subagentPanelWidth: clampSubagentPanelWidth(px) };
    }),

  /* file inspector — same contract again */
  setInspectorPanelWidth: (px) =>
    set((s) => {
      const width = clampInspectorPanelWidth(px);
      return width === s.inspectorPanelWidth ? {} : { inspectorPanelWidth: width };
    }),
  persistInspectorPanelWidth: () => {
    try {
      localStorage.setItem(
        INSPECTOR_PANEL_WIDTH_STORAGE_KEY,
        String(useUI.getState().inspectorPanelWidth),
      );
    } catch {
      // storage unavailable (private mode) — the width stays for this session only
    }
  },
  setInspectorPanelResizing: (resizing) => set({ inspectorPanelResizing: resizing }),
  resetInspectorPanelWidth: () =>
    set(() => {
      try {
        localStorage.removeItem(INSPECTOR_PANEL_WIDTH_STORAGE_KEY);
      } catch {
        // storage unavailable — the in-memory reset still applies
      }
      return { inspectorPanelWidth: INSPECTOR_PANEL_WIDTH_DEFAULT };
    }),
  initInspectorPanelWidth: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(INSPECTOR_PANEL_WIDTH_STORAGE_KEY);
      } catch {
        // storage unavailable — stay on the default inspector width
      }
      const px = saved === null ? NaN : Number(saved);
      if (!Number.isFinite(px)) return {};
      return { inspectorPanelWidth: clampInspectorPanelWidth(px) };
    }),

  setCommandPalette: (open) => set({ commandPaletteOpen: open }),
  setActiveFile: (file) => set({ activeFile: file }),

  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalOpen: (open) => set({ terminalOpen: open }),

  /* terminal drawer height — the column contract, on the vertical axis */
  setTerminalHeight: (px) =>
    set((s) => {
      const height = clampTerminalHeight(px);
      return height === s.terminalHeight ? {} : { terminalHeight: height };
    }),
  persistTerminalHeight: () => {
    try {
      localStorage.setItem(
        TERMINAL_HEIGHT_STORAGE_KEY,
        String(useUI.getState().terminalHeight),
      );
    } catch {
      // storage unavailable (private mode) — the height stays for this session only
    }
  },
  setTerminalResizing: (resizing) => set({ terminalResizing: resizing }),
  resetTerminalHeight: () =>
    set(() => {
      try {
        localStorage.removeItem(TERMINAL_HEIGHT_STORAGE_KEY);
      } catch {
        // storage unavailable — the in-memory reset still applies
      }
      return { terminalHeight: TERMINAL_HEIGHT_DEFAULT };
    }),
  initTerminalHeight: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
      } catch {
        // storage unavailable — stay on the default drawer height
      }
      const px = saved === null ? NaN : Number(saved);
      if (!Number.isFinite(px)) return {};
      return { terminalHeight: clampTerminalHeight(px) };
    }),

  setTerminalShellProfile: (profile) =>
    set(() => {
      const normalized = parseTerminalShellProfile(profile);
      try {
        return {
          terminalShellProfile: persistTerminalShellProfile(localStorage, normalized),
          terminalShellProfileReady: true,
        };
      } catch {
        // storage unavailable — keep the preference in memory for this session
        return { terminalShellProfile: normalized, terminalShellProfileReady: true };
      }
    }),
  initTerminalShellProfile: () =>
    set(() => {
      try {
        return {
          terminalShellProfile: loadTerminalShellProfile(localStorage),
          terminalShellProfileReady: true,
        };
      } catch {
        return {
          terminalShellProfile: AUTO_TERMINAL_SHELL_PROFILE,
          terminalShellProfileReady: true,
        };
      }
    }),

  beginAgentRun: () => set((s) => (s.agentRunning ? {} : { agentRunning: true })),
  endAgentRun: () => set({ agentRunning: false }),
  startDemo: () =>
    set((s) =>
      s.agentRunning
        ? {}
        : {
            agentRunning: true,
            demoTick: s.demoTick + 1,
            activeFile: "src/lib/agent.ts",
          }
    ),
  finishDemo: () => set({ agentRunning: false }),

  requestReview: (r) =>
    new Promise<boolean>((resolve) => {
      reviewResolver = resolve;
      set({ pendingReview: r });
    }),
  resolveReview: (accept) => {
    set({ pendingReview: null });
    reviewResolver?.(accept);
    reviewResolver = null;
  },
  setNotificationEnabled: (enabled) =>
    set((s) => ({
      notificationSettings: { ...s.notificationSettings, enabled },
    })),
  setCloseBehavior: (b) =>
    set(() => {
      try {
        localStorage.setItem(CLOSE_BEHAVIOR_STORAGE_KEY, b);
      } catch {
        // storage unavailable — keep the choice in-memory only
      }
      return { closeBehavior: b };
    }),
  initCloseBehavior: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(CLOSE_BEHAVIOR_STORAGE_KEY);
      } catch {
        // storage unavailable — stay on the default
      }
      if (saved !== "ask" && saved !== "minimize" && saved !== "quit") return {};
      return { closeBehavior: saved as CloseBehavior };
    }),
  setCloseDialogOpen: (open) => set({ closeDialogOpen: open }),
  setSendShortcut: (s) =>
    set(() => {
      try {
        localStorage.setItem(SEND_SHORTCUT_STORAGE_KEY, s);
      } catch {
        // storage unavailable — keep the choice in-memory only
      }
      return { sendShortcut: s };
    }),
  initSendShortcut: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(SEND_SHORTCUT_STORAGE_KEY);
      } catch {
        // storage unavailable — stay on the default
      }
      return isSendShortcut(saved) ? { sendShortcut: saved } : {};
    }),
  setShortcutBinding: (id, binding) =>
    set((s) => persistShortcuts({ ...s.shortcutOverrides, [id]: binding })),
  resetShortcutBinding: (id) =>
    set((s) => {
      const next = { ...s.shortcutOverrides };
      delete next[id];
      return persistShortcuts(next);
    }),
  resetAllShortcuts: () => set(() => persistShortcuts({})),
  initShortcuts: () =>
    set(() => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
      } catch {
        // storage unavailable — every command stays on its shipped chord
      }
      return { shortcutOverrides: parseShortcutOverrides(saved) };
    }),
}));

"use client";

import { create } from "zustand";
import { useAppearance } from "./appearance";

export type Theme = "light" | "dark";
export type TaskStatus = "done" | "running" | "queued" | "error";

const THEME_STORAGE_KEY = "pi-desktop.theme";
const CLOSE_BEHAVIOR_STORAGE_KEY = "pi-desktop.closeBehavior";

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

export interface AgentTask {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  /** originating pi tool name — picks the icon on the activity row */
  tool?: string;
}

export interface NotificationSettings {
  enabled: boolean;
}

const IDLE_TASKS: AgentTask[] = [
  { id: "read", title: "Read src/lib/agent.ts", detail: "142 lines · 3 symbols", status: "queued", tool: "read" },
  { id: "reason", title: "Reason over context", detail: "depth 3 · 4 candidates", status: "queued", tool: "agent" },
  { id: "edit", title: "Edit runAgentLoop()", detail: "streaming diff · +1 −1", status: "queued", tool: "edit" },
  { id: "test", title: "Run test suite", detail: "pnpm test", status: "queued", tool: "bash" },
];

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
  sidebarOpen: boolean;
  agentPanelOpen: boolean;
  commandPaletteOpen: boolean;
  terminalOpen: boolean;
  activeFile: string;

  /* agent demo state */
  agentTasks: AgentTask[];
  agentRunning: boolean;
  demoTick: number; // bump to ask the editor to run the streaming demo
  pendingReview: PendingReview | null;

  /* notification settings */
  notificationSettings: NotificationSettings;

  /* window close behavior */
  closeBehavior: CloseBehavior;
  closeDialogOpen: boolean;

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
  toggleWork: () => void;
  toggleSidebar: () => void;
  toggleAgentPanel: () => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  setCommandPalette: (open: boolean) => void;
  setActiveFile: (file: string) => void;

  setTaskStatus: (id: string, status: TaskStatus) => void;
  /* real agent run — driven by pi tool events via agent-bridge */
  beginAgentRun: () => void;
  endAgentRun: () => void;
  upsertAgentTask: (task: AgentTask) => void;
  patchAgentTask: (id: string, patch: Partial<AgentTask>) => void;
  startDemo: () => void;
  finishDemo: () => void;
  requestReview: (r: PendingReview) => Promise<boolean>;
  resolveReview: (accept: boolean) => void;
  setNotificationEnabled: (enabled: boolean) => void;
  setCloseBehavior: (b: CloseBehavior) => void;
  /** restore the saved close behavior — call once on mount */
  initCloseBehavior: () => void;
  setCloseDialogOpen: (open: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  // matches the SSR <html> default; initTheme() reconciles with storage/OS
  theme: "dark",
  themeSource: "system",
  zenMode: false,
  workMode: false,
  sidebarOpen: true,
  agentPanelOpen: true,
  commandPaletteOpen: false,
  activeFile: "src/lib/agent.ts",

  terminalOpen: false,
  agentTasks: IDLE_TASKS,
  agentRunning: false,
  demoTick: 0,
  pendingReview: null,
  notificationSettings: { enabled: true },
  closeBehavior: "ask",
  closeDialogOpen: false,

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
  toggleWork: () => set((s) => ({ workMode: !s.workMode })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleAgentPanel: () => set((s) => ({ agentPanelOpen: !s.agentPanelOpen })),
  setCommandPalette: (open) => set({ commandPaletteOpen: open }),
  setActiveFile: (file) => set({ activeFile: file }),

  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalOpen: (open) => set({ terminalOpen: open }),

  setTaskStatus: (id, status) =>
    set((s) => ({
      agentTasks: s.agentTasks.map((t) => (t.id === id ? { ...t, status } : t)),
    })),

  /* real run: clear the strip, then tool events stream tasks in */
  beginAgentRun: () =>
    set((s) => (s.agentRunning ? {} : { agentRunning: true, agentTasks: [] })),
  endAgentRun: () =>
    set((s) => ({
      agentRunning: false,
      agentTasks: s.agentTasks.map((t) =>
        t.status === "running" ? { ...t, status: "done" as const } : t
      ),
    })),
  upsertAgentTask: (task) =>
    set((s) => {
      const i = s.agentTasks.findIndex((t) => t.id === task.id);
      if (i === -1) return { agentTasks: [...s.agentTasks, task] };
      const next = [...s.agentTasks];
      next[i] = { ...next[i], ...task };
      return { agentTasks: next };
    }),
  patchAgentTask: (id, patch) =>
    set((s) => ({
      agentTasks: s.agentTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  startDemo: () =>
    set((s) =>
      s.agentRunning
        ? {}
        : {
            agentRunning: true,
            demoTick: s.demoTick + 1,
            agentTasks: IDLE_TASKS,
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
}));

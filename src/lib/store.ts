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
  /** restore the saved theme — call once on mount */
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
  theme: "dark",
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

  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === "dark" ? "light" : "dark";
      applyThemeDom(theme);
      // re-derive appearance overrides that depend on the theme (bg image base)
      useAppearance.getState().set({});
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        // storage unavailable (private mode) — keep the choice in-memory only
      }
      return { theme };
    }),
  initTheme: () =>
    set((s) => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        // storage unavailable — stay on the default
      }
      if (saved !== "light" && saved !== "dark") return {};
      if (saved === s.theme) return {};
      applyThemeDom(saved);
      return { theme: saved };
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

"use client";

import { create } from "zustand";

export type Theme = "light" | "dark";
export type TaskStatus = "done" | "running" | "queued";

export interface AgentTask {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
}

const IDLE_TASKS: AgentTask[] = [
  { id: "read", title: "Read src/lib/agent.ts", detail: "142 lines · 3 symbols", status: "queued" },
  { id: "reason", title: "Reason over context", detail: "depth 3 · 4 candidates", status: "queued" },
  { id: "edit", title: "Edit runAgentLoop()", detail: "streaming diff · +1 −1", status: "queued" },
  { id: "test", title: "Run test suite", detail: "pnpm test", status: "queued" },
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

  toggleTheme: () => void;
  toggleZen: () => void;
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
}

export const useUI = create<UIState>((set) => ({
  theme: "dark",
  zenMode: false,
  sidebarOpen: true,
  agentPanelOpen: true,
  commandPaletteOpen: false,
  activeFile: "src/lib/agent.ts",

  terminalOpen: false,
  agentTasks: IDLE_TASKS,
  agentRunning: false,
  demoTick: 0,
  pendingReview: null,

  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        const el = document.documentElement;
        el.setAttribute("data-theme", theme);
        // Appica UI themes via .light/.dark classes — keep them in sync
        el.classList.toggle("dark", theme === "dark");
        el.classList.toggle("light", theme === "light");
      }
      return { theme };
    }),
  toggleZen: () => set((s) => ({ zenMode: !s.zenMode })),
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
}));

"use client";

import { create } from "zustand";
import { getPiClient, isTauri } from "./client";
import type { PiModel, PiState, ThinkingLevel } from "./protocol";

// Re-export so `usePiSettings` resolves whether imported from here or from
// "@/lib/pi/settings" — guards against stale bundler graphs.
export { usePiSettings } from "./settings";

export type PiStatus = "disconnected" | "connecting" | "ready" | "running";

export interface PiCommandInfo {
  name: string;
  description?: string;
  source?: string; // "extension:<name>" for extension-provided commands
}

interface PiStore {
  status: PiStatus;
  mock: boolean;
  models: PiModel[];
  currentModel: PiModel | null;
  thinkingLevel: ThinkingLevel;
  commands: PiCommandInfo[];
  lastError: string | null;

  connect: (opts?: { cwd?: string }) => Promise<void>;
  /** Stop pi and reconnect — used when the working directory changes. */
  restart: (cwd?: string) => Promise<void>;
  refresh: () => Promise<void>;
  setModel: (m: PiModel) => Promise<void>;
  setThinking: (level: ThinkingLevel) => Promise<void>;
  cycleModel: () => Promise<void>;
}

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const usePi = create<PiStore>((set, get) => ({
  status: "disconnected",
  mock: !isTauri(),
  models: [],
  currentModel: null,
  thinkingLevel: "medium",
  commands: [],
  lastError: null,

  connect: async (opts) => {
    if (get().status !== "disconnected") return;
    set({ status: "connecting", lastError: null });
    const client = getPiClient();
    try {
      await client.start({ cwd: opts?.cwd });

      // agent activity → status
      client.on("agent_start", () => set({ status: "running" }));
      client.on("agent_settled", () => set({ status: "ready" }));
      client.on("agent_end", () => {
        if (get().status === "running") set({ status: "ready" });
      });

      set({ status: "ready", mock: client.transport.kind === "mock" });
      await get().refresh();
    } catch (e) {
      set({
        status: "disconnected",
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  restart: async (cwd) => {
    const client = getPiClient();
    await client.stop();
    set({ status: "disconnected" });
    await get().connect({ cwd });
  },

  refresh: async () => {
    const client = getPiClient();
    try {
      const [models, state, commands] = await Promise.all([
        client.request<{ models: PiModel[] }>({ type: "get_available_models" }),
        client.request<PiState>({ type: "get_state" }),
        client.request<{ commands: PiCommandInfo[] }>({ type: "get_commands" }),
      ]);
      set({
        models: models.data?.models ?? [],
        currentModel: state.data?.model ?? null,
        thinkingLevel: state.data?.thinkingLevel ?? "medium",
        commands: commands.data?.commands ?? [],
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  setModel: async (m) => {
    const prev = get().currentModel;
    set({ currentModel: m }); // optimistic — feels iOS-instant
    const r = await getPiClient().request({
      type: "set_model",
      provider: m.provider,
      modelId: m.id,
    });
    if (!r.success) set({ currentModel: prev, lastError: r.error ?? null });
  },

  setThinking: async (level) => {
    const prev = get().thinkingLevel;
    set({ thinkingLevel: level });
    const r = await getPiClient().request({ type: "set_thinking_level", level });
    if (!r.success) set({ thinkingLevel: prev, lastError: r.error ?? null });
  },

  cycleModel: async () => {
    const { models, currentModel, setModel } = get();
    if (!models.length) return;
    const idx = models.findIndex(
      (m) => m.id === currentModel?.id && m.provider === currentModel?.provider
    );
    await setModel(models[(idx + 1) % models.length]);
  },
}));

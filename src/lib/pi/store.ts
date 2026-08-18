"use client";

import { create } from "zustand";
import { getPiClient } from "./client";
import type { PiModel, PiState, ThinkingLevel } from "./protocol";
import { useExtUi } from "./ext-ui";
import { t } from "../i18n";
import { piRequestErrorText } from "./request-error";
import { getBackendKind } from "../backend/composition/container";

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
  /** Error from the latest get_available_models request only. */
  modelsError: string | null;
  lastError: string | null;

  connect: (opts?: { cwd?: string; resumePath?: string }) => Promise<void>;
  /** Stop pi and reconnect — used when the working directory changes. */
  restart: (cwd?: string, resumePath?: string) => Promise<void>;
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

/**
 * Startup requests get a long leash: pi spawned with `--session <path>` loads the
 * whole prior transcript before it serves RPC, and extensions must finish
 * registering before `get_commands` can answer. The 15s default was short enough
 * that a resumed session timed out and left the composer with no models.
 */
const REFRESH_TIMEOUT_MS = 60_000;

/** bounded catch-up polling while the model list is still empty */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 20_000];

/** `client.on("session")` must be attached once, before the first start() */
let sessionHooked = false;
let activityHooked = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let modelChangeSeq = 0;
let thinkingChangeSeq = 0;

function isMockBackend() {
  return getBackendKind() === "browser-preview";
}

function surfaceSettingFailure(key: string, error: string) {
  useExtUi.getState().pushToast(t(key, { error }), "error", 6000);
}

/**
 * Keep asking for the model list while it is still empty. A single refresh at
 * connect time is not enough: a slow pi boot (session resume, extension load,
 * WSL hop) can outlast it, and nothing else ever retried — so the composer
 * stayed modelless until the user restarted pi by hand.
 */
function scheduleRetry(get: () => PiStore, attempt: number) {
  if (attempt >= RETRY_DELAYS_MS.length) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const s = get();
    if (s.status === "disconnected") return; // gone; restart() will re-arm
    if (s.models.length > 0) return; // pi answered — nothing to catch up on
    void s.refresh().then(() => {
      if (get().models.length === 0) scheduleRetry(get, attempt + 1);
    });
  }, RETRY_DELAYS_MS[attempt]);
}

export const usePi = create<PiStore>((set, get) => ({
  status: "disconnected",
  mock: isMockBackend(),
  models: [],
  currentModel: null,
  thinkingLevel: "medium",
  commands: [],
  modelsError: null,
  lastError: null,

  connect: async (opts) => {
    if (get().status !== "disconnected") return;
    set({ status: "connecting", modelsError: null, lastError: null });
    const client = getPiClient();
    try {
      // Subscribe BEFORE start(): pi announces itself with a `session` event as
      // soon as its RPC loop is up, which is the only reliable "ready for
      // requests" signal. Attaching after start() can miss it on a fast boot.
      if (!sessionHooked) {
        sessionHooked = true;
        client.on("session", () => void get().refresh());
      }

      await client.start({ cwd: opts?.cwd, resumePath: opts?.resumePath });

      // The client survives process restarts, so these hooks must be installed
      // once or every project/session switch would multiply status updates.
      if (!activityHooked) {
        activityHooked = true;
        client.on("agent_start", () => set({ status: "running" }));
        client.on("agent_settled", () => set({ status: "ready" }));
        client.on("agent_end", () => {
          if (get().status === "running") set({ status: "ready" });
        });
      }

      set({ status: "ready", mock: isMockBackend() });
      await get().refresh();
      scheduleRetry(get, 0); // catch up if pi was still booting
    } catch (e) {
      set({
        status: "disconnected",
        modelsError: e instanceof Error ? e.message : String(e),
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  restart: async (cwd, resumePath) => {
    const client = getPiClient();
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      await client.stop();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      set({ status: "disconnected", lastError: detail });
      throw error;
    }
    set({ status: "disconnected", lastError: null });
    await get().connect({ cwd, resumePath });
    if (get().status === "disconnected") {
      throw new Error(get().lastError || t("agent.piUnavailable"));
    }
  },

  refresh: async () => {
    const client = getPiClient();
    // allSettled, not all: these are three independent queries, and
    // `get_commands` is the slowest (it waits on extension registration). Under
    // Promise.all a single slow reply discarded the model list and the current
    // model with it, which is what left the composer showing "no models
    // configured" against a perfectly healthy pi.
    const [models, state, commands] = await Promise.allSettled([
      client.request<{ models: PiModel[] }>(
        { type: "get_available_models" },
        REFRESH_TIMEOUT_MS
      ),
      client.request<PiState>({ type: "get_state" }, REFRESH_TIMEOUT_MS),
      client.request<{ commands: PiCommandInfo[] }>(
        { type: "get_commands" },
        REFRESH_TIMEOUT_MS
      ),
    ]);

    const patch: Partial<PiStore> = {};
    const errors: string[] = [];
    let modelsError: string | null = null;

    const failure = (label: string, r: PromiseSettledResult<{ success: boolean; error?: string }>) => {
      if (r.status === "rejected") {
        return `${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
      }
      if (!r.value.success) {
        return `${label}: ${r.value.error ?? "failed"}`;
      }
      return null;
    };

    // Only overwrite on success — a failed query must not blank state that a
    // previous refresh already populated.
    const modelFailure = failure("get_available_models", models);
    if (models.status === "fulfilled" && !modelFailure) {
      const list = models.value.data?.models;
      if (list && list.length > 0) patch.models = list;
      else if (list) patch.models = [];
    } else {
      modelsError = modelFailure;
    }
    const stateFailure = failure("get_state", state);
    if (stateFailure) errors.push(stateFailure);
    else if (state.status === "fulfilled") {
      patch.currentModel = state.value.data?.model ?? null;
      patch.thinkingLevel = state.value.data?.thinkingLevel ?? "medium";
    }
    const commandsFailure = failure("get_commands", commands);
    if (commandsFailure) errors.push(commandsFailure);
    else if (commands.status === "fulfilled") {
      patch.commands = commands.value.data?.commands ?? [];
    }

    set({
      ...patch,
      modelsError,
      lastError: errors.length > 0 ? errors.join(" · ") : null,
    });
  },

  setModel: async (m) => {
    const prev = get().currentModel;
    const requestSeq = ++modelChangeSeq;
    set({ currentModel: m, lastError: null }); // optimistic — feels iOS-instant
    try {
      const r = await getPiClient().request({
        type: "set_model",
        provider: m.provider,
        modelId: m.id,
      });
      if (r.success || requestSeq !== modelChangeSeq) return;
      const error = r.error || t("agent.taskFailed");
      set({ currentModel: prev, lastError: error });
      surfaceSettingFailure("modelPicker.switchFailed", error);
    } catch (error) {
      if (requestSeq !== modelChangeSeq) return;
      const detail = piRequestErrorText(error);
      set({ currentModel: prev, lastError: detail });
      surfaceSettingFailure("modelPicker.switchFailed", detail);
    }
  },

  setThinking: async (level) => {
    const prev = get().thinkingLevel;
    const requestSeq = ++thinkingChangeSeq;
    set({ thinkingLevel: level, lastError: null });
    try {
      const r = await getPiClient().request({ type: "set_thinking_level", level });
      if (r.success || requestSeq !== thinkingChangeSeq) return;
      const error = r.error || t("agent.taskFailed");
      set({ thinkingLevel: prev, lastError: error });
      surfaceSettingFailure("thinking.switchFailed", error);
    } catch (error) {
      if (requestSeq !== thinkingChangeSeq) return;
      const detail = piRequestErrorText(error);
      set({ thinkingLevel: prev, lastError: detail });
      surfaceSettingFailure("thinking.switchFailed", detail);
    }
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

export function resetPiStoreForTests(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  sessionHooked = false;
  modelChangeSeq = 0;
  thinkingChangeSeq = 0;
  usePi.setState({
    status: "disconnected",
    mock: isMockBackend(),
    models: [],
    currentModel: null,
    thinkingLevel: "medium",
    commands: [],
    modelsError: null,
    lastError: null,
  });
}

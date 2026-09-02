"use client";

import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { getPiClient } from "./client";
import type { PiModel, PiState, ThinkingLevel } from "./protocol";
import { useExtUi } from "./ext-ui";
import { t } from "../i18n";
import { piRequestErrorText } from "./request-error";
import { getBackendKind } from "../backend/composition/container";
import { getActiveTaskId, useTaskContext } from "./task-context";
import { DEFAULT_TASK_ID } from "../backend/ports/pi-process";
import type { ExecutionBinding } from "../backend/ports/execution-target";
import { getChatRecoveryTarget } from "../orchestration/chat-recovery";

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

  connect: (opts?: {
    cwd?: string;
    resumePath?: string;
    executionBinding?: ExecutionBinding;
    /** Detached remote only: resume the journal after this sequence. */
    attachAfter?: number;
  }) => Promise<void>;
  /** Stop pi and reconnect — used when the working directory changes. */
  restart: (
    cwd?: string,
    resumePath?: string,
    executionBinding?: ExecutionBinding,
  ) => Promise<void>;
  refresh: () => Promise<void>;
  setModel: (m: PiModel) => Promise<void>;
  setThinking: (level: ThinkingLevel) => Promise<void>;
  cycleModel: () => Promise<void>;
}

export type PiStoreApi = UseBoundStore<StoreApi<PiStore>>;

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const THINKING_STORAGE_KEY = "pi-desktop.thinkingLevel";

function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as string[]).includes(v);
}

/**
 * The level the user last picked — one value shared by every task, persisted
 * across launches.
 *
 * A pi process has no memory of it: each one boots at the `defaultThinkingLevel`
 * from settings.json, so without this the composer's choice silently reverted on
 * every relaunch *and* on every new conversation (a new task spawns its own pi).
 * `refresh` restores it once per process; see the note there for why only once.
 */
function readRememberedThinking(): ThinkingLevel | null {
  try {
    const raw = localStorage.getItem(THINKING_STORAGE_KEY);
    return isThinkingLevel(raw) ? raw : null;
  } catch {
    return null; // storage unavailable (private mode) or prerender — use pi's default
  }
}

function rememberThinking(level: ThinkingLevel): void {
  try {
    localStorage.setItem(THINKING_STORAGE_KEY, level);
  } catch {
    // storage unavailable — the level still holds for this session
  }
}

/** Forget the remembered level, letting settings.json's default win again. */
export function clearRememberedThinking(): void {
  try {
    localStorage.removeItem(THINKING_STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * Startup requests get a long leash: pi spawned with `--session <path>` loads the
 * whole prior transcript before it serves RPC, and extensions must finish
 * registering before `get_commands` can answer. The 15s default was short enough
 * that a resumed session timed out and left the composer with no models.
 */
const REFRESH_TIMEOUT_MS = 60_000;

/** bounded catch-up polling while the model list is still empty */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 20_000];

function isMockBackend() {
  return getBackendKind() === "browser-preview";
}

function surfaceSettingFailure(key: string, error: string) {
  useExtUi.getState().pushToast(t(key, { error }), "error", 6000);
}

/**
 * Per-task pi connection state. Each task owns its own pi process, so status,
 * model list and thinking level are tracked independently per conversation.
 */
export function createPiStore(taskId: string, executionBinding?: ExecutionBinding) {
  const client = getPiClient(taskId, executionBinding);
  let sessionHooked = false;
  let activityHooked = false;
  let modelChangeSeq = 0;
  let thinkingChangeSeq = 0;
  /** false until the remembered level has been pushed into the current process */
  let appliedRemembered = false;
  /** >0 while a set_thinking_level round-trip is open — refresh must not clobber it */
  let thinkingInFlight = 0;

  return create<PiStore>()((set, get) => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Keep asking for the model list while it is still empty. A single refresh at
     * connect time is not enough: a slow pi boot (session resume or extension load)
     * can outlast it, and nothing else ever retried — so the composer
     * stayed modelless until the user restarted pi by hand.
     */
    const scheduleRetry = (attempt: number) => {
      if (attempt >= RETRY_DELAYS_MS.length) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        const s = get();
        if (s.status === "disconnected") return; // gone; restart() will re-arm
        if (s.models.length > 0) return; // pi answered — nothing to catch up on
        void s.refresh().then(() => {
          if (get().models.length === 0) scheduleRetry(attempt + 1);
        });
      }, RETRY_DELAYS_MS[attempt]);
    };

    return {
      status: "disconnected",
      mock: isMockBackend(),
      models: [],
      currentModel: null,
      // Seeded, not hardcoded: the chip animates on change, so starting at
      // "medium" made every launch visibly roll to the restored level.
      thinkingLevel: readRememberedThinking() ?? "medium",
      commands: [],
      modelsError: null,
      lastError: null,

      connect: async (opts) => {
        if (get().status !== "disconnected") return;
        set({ status: "connecting", modelsError: null, lastError: null });
        try {
          // Subscribe BEFORE start(): pi announces itself with a `session` event as
          // soon as its RPC loop is up, which is the only reliable "ready for
          // requests" signal. Attaching after start() can miss it on a fast boot.
          if (!sessionHooked) {
            sessionHooked = true;
            client.on("session", () => void get().refresh());
          }

          await client.start({
            cwd: opts?.cwd,
            resumePath: opts?.resumePath,
            executionBinding: opts?.executionBinding,
            attachAfter: opts?.attachAfter,
          });
          // A new process boots at settings.json's default, so the remembered
          // level has to be re-applied to this one.
          appliedRemembered = false;

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
          scheduleRetry(0); // catch up if pi was still booting
        } catch (e) {
          set({
            status: "disconnected",
            modelsError: e instanceof Error ? e.message : String(e),
            lastError: e instanceof Error ? e.message : String(e),
          });
        }
      },

      restart: async (cwd, resumePath, executionBinding) => {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        // Callers that restart pi *in place* (settings applied, CLI updated)
        // only pass a cwd. Without a resume path pi boots blank and opens a new
        // session file, so the conversation on screen silently loses its context
        // mid-flight. Fall back to this task's own pinned session.
        const recoveryTarget = getChatRecoveryTarget(taskId);
        const resume =
          resumePath?.trim() || recoveryTarget?.resumePath || undefined;
        try {
          await client.stop();
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          set({ status: "disconnected", lastError: detail });
          throw error;
        }
        set({ status: "disconnected", lastError: null });
        await get().connect({
          cwd: cwd ?? recoveryTarget?.cwd,
          resumePath: resume,
          executionBinding: executionBinding ?? recoveryTarget?.executionBinding,
        });
        if (get().status === "disconnected") {
          throw new Error(get().lastError || t("agent.piUnavailable"));
        }
      },

      refresh: async () => {
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
          const piLevel = state.value.data?.thinkingLevel ?? "medium";

          if (thinkingInFlight > 0) {
            // A change is mid-flight; pi is still reporting the old level. Adopting
            // it here would flicker the chip back and re-persist the stale value.
          } else if (!appliedRemembered) {
            appliedRemembered = true;
            const remembered = readRememberedThinking();
            patch.thinkingLevel = remembered ?? piLevel;
            if (remembered && remembered !== piLevel) {
              void client
                .request({ type: "set_thinking_level", level: remembered })
                .then((r) => {
                  // pi refused (e.g. this model has no such level) — show the truth
                  if (!r.success) set({ thinkingLevel: piLevel });
                })
                .catch(() => set({ thinkingLevel: piLevel }));
            }
          } else {
            // Past the first refresh pi owns the level: `/thinking` cycles it
            // there, so mirror it back into storage to keep the two in step.
            patch.thinkingLevel = piLevel;
            rememberThinking(piLevel);
          }
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
          const r = await client.request({
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
        thinkingInFlight++;
        try {
          const r = await client.request({ type: "set_thinking_level", level });
          if (requestSeq !== thinkingChangeSeq) return;
          if (r.success) {
            // Only after pi agrees: a rejected level must not come back next launch.
            rememberThinking(level);
            return;
          }
          const error = r.error || t("agent.taskFailed");
          set({ thinkingLevel: prev, lastError: error });
          surfaceSettingFailure("thinking.switchFailed", error);
        } catch (error) {
          if (requestSeq !== thinkingChangeSeq) return;
          const detail = piRequestErrorText(error);
          set({ thinkingLevel: prev, lastError: detail });
          surfaceSettingFailure("thinking.switchFailed", detail);
        } finally {
          thinkingInFlight--;
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
    };
  });
}

const piStores = new Map<string, PiStoreApi>();

export function getPiStore(taskId: string, executionBinding?: ExecutionBinding): PiStoreApi {
  const key = taskId.trim() || DEFAULT_TASK_ID;
  let store = piStores.get(key);
  if (!store) {
    store = createPiStore(key, executionBinding);
    piStores.set(key, store);
  }
  return store;
}

/** Drop every per-task pi store (used when switching projects). */
export function clearPiStores(): void {
  piStores.clear();
}

function activePiStore(): PiStoreApi {
  return getPiStore(getActiveTaskId());
}

function usePiHook(selector?: any, equalityFn?: any): any {
  const taskId = useTaskContext((s) => s.activeTaskId);
  return (getPiStore(taskId) as any)(selector, equalityFn);
}

/**
 * Zustand-compatible facade over the currently focused task's pi store. Using
 * it as a hook re-subscribes when the active conversation switches.
 */
export const usePi = Object.assign(usePiHook, {
  getState: () => activePiStore().getState(),
  setState: (partial: any, replace?: any) => activePiStore().setState(partial, replace),
  subscribe: (listener: any, selector?: any, equalityFn?: any, options?: any) =>
    (activePiStore() as any).subscribe(listener, selector, equalityFn, options),
  getInitialState: () => activePiStore().getInitialState(),
}) as unknown as PiStoreApi;

export function resetPiStoreForTests(): void {
  piStores.clear();
  clearRememberedThinking(); // persisted level would otherwise leak between tests
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
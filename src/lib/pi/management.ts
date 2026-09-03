"use client";

import { create } from "zustand";
import { getPort } from "../backend/composition/container";
import type {
  PiManagementAvailability,
  PiManagementPort,
  PiManagementSnapshot,
} from "../backend/ports/pi-management";
import { piManagementTargetKey } from "../backend/ports/pi-management";
import type { ExecutionBinding } from "../backend/ports/execution-target";
import { useSessions } from "./sessions";
import { useWorkspace } from "../workspace";
import { getActiveTaskId } from "./task-context";

export interface ManagementContext {
  binding: ExecutionBinding;
  projectRoot: string | null;
  targetKey: string;
  port: PiManagementPort;
}

function currentContext(): ManagementContext {
  const binding = useSessions.getState().executionBinding;
  const projectRoot = useWorkspace.getState().root;
  return {
    binding,
    projectRoot,
    targetKey: piManagementTargetKey(binding, projectRoot),
    port: getPort("createPiManagement")(binding, projectRoot),
  };
}

interface PiManagementStore {
  targetKey: string | null;
  generation: number;
  loading: boolean;
  loaded: boolean;
  availability: PiManagementAvailability | null;
  snapshot: PiManagementSnapshot | null;
  error: string | null;
  dirtyTasks: Record<string, true>;
  load: () => Promise<void>;
  applySnapshot: (targetKey: string, snapshot: PiManagementSnapshot) => boolean;
  markDirty: (scope: "global" | "project", context?: ManagementContext) => void;
  clearTaskDirty: (taskId: string) => void;
  context: () => ManagementContext;
}

interface ActiveManagementLoad {
  targetKey: string;
  generation: number;
  promise: Promise<void>;
}

// Only the latest generation can commit, so only that request is eligible for
// coalescing. A per-target cache would incorrectly revive an invalidated A request
// after an A → B → A switch.
let activeManagementLoad: ActiveManagementLoad | null = null;

export const usePiManagement = create<PiManagementStore>((set, get) => ({
  targetKey: null,
  generation: 0,
  loading: false,
  loaded: false,
  availability: null,
  snapshot: null,
  error: null,
  dirtyTasks: {},

  context: currentContext,

  load: () => {
    const context = currentContext();
    const existing = activeManagementLoad;
    if (
      existing?.targetKey === context.targetKey &&
      existing.generation === get().generation
    ) {
      return existing.promise;
    }

    const generation = get().generation + 1;
    let resolveLoad!: () => void;
    let rejectLoad!: (reason?: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    const request: ActiveManagementLoad = { targetKey: context.targetKey, generation, promise };

    // Install the request before set(): Zustand subscribers run synchronously and
    // may call load() again while observing the loading transition.
    activeManagementLoad = request;
    const clearRequest = () => {
      if (activeManagementLoad === request) activeManagementLoad = null;
    };

    try {
      set({
        targetKey: context.targetKey,
        generation,
        loading: true,
        loaded: false,
        availability: null,
        snapshot: null,
        error: null,
      });
    } catch (error) {
      clearRequest();
      rejectLoad(error);
      return promise;
    }

    void (async () => {
      try {
        const availability = await context.port.availability();
        if (get().generation !== generation || currentContext().targetKey !== context.targetKey) return;
        const readable = availability.capabilities.some(
          (capability) => capability === "pi-packages-read-v1" || capability === "pi-skills-read-v1",
        );
        if (!readable) {
          set({ availability, loading: false, loaded: true });
          return;
        }
        const snapshot = await context.port.inspect();
        if (get().generation !== generation || currentContext().targetKey !== context.targetKey) return;
        set({ availability, snapshot, loading: false, loaded: true });
      } catch (error) {
        if (get().generation !== generation || currentContext().targetKey !== context.targetKey) return;
        set({
          loading: false,
          loaded: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().then(
      () => {
        clearRequest();
        resolveLoad();
      },
      (error) => {
        clearRequest();
        rejectLoad(error);
      },
    );

    return promise;
  },

  applySnapshot: (targetKey, snapshot) => {
    const state = get();
    if (state.targetKey !== targetKey || currentContext().targetKey !== targetKey) return false;

    const invalidatesLoad =
      activeManagementLoad?.targetKey === targetKey &&
      activeManagementLoad.generation === state.generation;
    if (invalidatesLoad) activeManagementLoad = null;

    // A mutation snapshot is authoritative. Invalidate any older read so it cannot
    // overwrite the mutation result, and let post-mutation reconciliation start fresh.
    set({
      generation: invalidatesLoad ? state.generation + 1 : state.generation,
      loading: false,
      snapshot: { ...snapshot, targetKey },
      loaded: true,
      error: null,
    });
    return true;
  },

  markDirty: (scope, mutationContext) => {
    const context = mutationContext ?? currentContext();
    const sessions = useSessions.getState();
    const currentBinding = context.binding;
    const sameHost = (binding: ExecutionBinding | undefined) => {
      const candidate = binding ?? ({ kind: "local", targetId: "local" } as const);
      if (candidate.kind !== currentBinding.kind) return false;
      if (candidate.kind === "local") return true;
      return (
        currentBinding.kind === "ssh" &&
        candidate.profileId === currentBinding.profileId &&
        candidate.profileRevision === currentBinding.profileRevision
      );
    };
    const ids = sessions.sessions
      .filter((session) => {
        if (!sameHost(session.executionBinding)) return false;
        if (scope === "global") return true;
        return piManagementTargetKey(session.executionBinding, session.projectRoot) === context.targetKey;
      })
      .map((session) => session.id);
    const activeContext = currentContext();
    const activeMatches =
      sameHost(activeContext.binding) &&
      (scope === "global" || activeContext.targetKey === context.targetKey);
    if (activeMatches) ids.push(sessions.activeId ?? getActiveTaskId());
    const dirtyTasks = { ...get().dirtyTasks };
    for (const id of ids) dirtyTasks[id] = true;
    set({ dirtyTasks });
  },

  clearTaskDirty: (taskId) => {
    const dirtyTasks = { ...get().dirtyTasks };
    delete dirtyTasks[taskId];
    set({ dirtyTasks });
  },
}));

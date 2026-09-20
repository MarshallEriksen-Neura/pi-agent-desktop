import { create } from "zustand";
import { getBackendKind, getPort } from "@/lib/backend/composition/container";
import type { ExecutionBinding } from "@/lib/backend/ports/execution-target";
import { t } from "@/lib/i18n";
import { useSessions } from "./sessions";

const LEGACY_SKIP_KEY = "pi-cli-skip-version";
const SKIP_KEY_PREFIX = "pi-cli-skip-version:";

export interface PiCliUpdateInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

type Phase = "idle" | "checking" | "upToDate" | "available" | "updating" | "updated" | "notFound" | "error";

export function cliUpdateTargetKey(binding: ExecutionBinding): string {
  return binding.kind === "local" ? "local" : `ssh:${binding.profileId}`;
}

export function cliUpdateTargetStamp(binding: ExecutionBinding): string {
  return binding.kind === "local"
    ? "local"
    : `ssh:${binding.profileId}@${binding.profileRevision}`;
}

function skippedVersion(binding: ExecutionBinding): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(`${SKIP_KEY_PREFIX}${cliUpdateTargetKey(binding)}`)
    ?? (binding.kind === "local" ? localStorage.getItem(LEGACY_SKIP_KEY) : null);
}

interface CliUpdateState {
  phase: Phase;
  info: PiCliUpdateInfo | null;
  error: string | null;
  targetStamp: string | null;
  targetKind: ExecutionBinding["kind"] | null;
  targetHost: string | null;
  targetDetached: boolean;
  generation: number;
  checkOnLaunch: (binding: ExecutionBinding) => Promise<void>;
  check: (binding: ExecutionBinding) => Promise<void>;
  apply: (binding: ExecutionBinding) => Promise<void>;
  skip: (binding: ExecutionBinding) => void;
  dismiss: (binding: ExecutionBinding) => void;
}

async function checkFor(binding: ExecutionBinding, silent: boolean): Promise<void> {
  const store = useCliUpdate;
  const generation = store.getState().generation + 1;
  const stamp = cliUpdateTargetStamp(binding);
  store.setState({
    generation,
    targetStamp: stamp,
    targetKind: binding.kind,
    targetHost: binding.kind === "ssh" ? binding.hostAlias : null,
    targetDetached: binding.kind === "ssh" && Boolean(binding.remoteTaskId || binding.remoteTaskPending),
    phase: "checking",
    info: null,
    error: null,
  });

  if (getBackendKind() === "browser-preview") {
    if (store.getState().generation === generation) store.setState({ phase: "idle" });
    return;
  }

  try {
    const info = await getPort("piConfiguration").checkPiCliUpdate(binding);
    const current = store.getState();
    if (current.generation !== generation || current.targetStamp !== stamp) return;
    if (!info.installed) {
      store.setState({ phase: "notFound", info });
    } else if (!info.updateAvailable || !info.latest || skippedVersion(binding) === info.latest) {
      store.setState({ phase: "upToDate", info });
    } else {
      store.setState({ phase: "available", info });
    }
  } catch (error) {
    const current = store.getState();
    if (current.generation !== generation || current.targetStamp !== stamp) return;
    store.setState(silent
      ? { phase: "idle", info: null, error: null }
      : { phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

export const useCliUpdate = create<CliUpdateState>((set, get) => ({
  phase: "idle",
  info: null,
  error: null,
  targetStamp: null,
  targetKind: null,
  targetHost: null,
  targetDetached: false,
  generation: 0,

  checkOnLaunch: (binding) => checkFor(binding, true),
  check: (binding) => checkFor(binding, false),

  apply: async (binding) => {
    const stamp = cliUpdateTargetStamp(binding);
    if (get().targetStamp !== stamp || cliUpdateTargetStamp(useSessions.getState().executionBinding) !== stamp) {
      throw new Error(t("cliUpdate.targetChanged"));
    }
    const generation = get().generation + 1;
    set({ phase: "updating", error: null, generation });
    try {
      await getPort("piConfiguration").applyPiCliUpdate(binding);
      const current = get();
      if (current.generation === generation && current.targetStamp === stamp) {
        set({ phase: "updated" });
      }
    } catch (error) {
      if (get().generation === generation && get().targetStamp === stamp) {
        set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  },

  skip: (binding) => {
    const stamp = cliUpdateTargetStamp(binding);
    if (get().targetStamp !== stamp || cliUpdateTargetStamp(useSessions.getState().executionBinding) !== stamp) return;
    const latest = get().info?.latest;
    if (latest && typeof localStorage !== "undefined") {
      localStorage.setItem(`${SKIP_KEY_PREFIX}${cliUpdateTargetKey(binding)}`, latest);
      if (binding.kind === "local") localStorage.setItem(LEGACY_SKIP_KEY, latest);
    }
    set({ phase: "upToDate" });
  },
  dismiss: (binding) => {
    const stamp = cliUpdateTargetStamp(binding);
    if (get().targetStamp === stamp && cliUpdateTargetStamp(useSessions.getState().executionBinding) === stamp) {
      set({ phase: "upToDate" });
    }
  },
}));

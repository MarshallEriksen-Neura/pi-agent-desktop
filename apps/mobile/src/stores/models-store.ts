import { create } from "zustand";
import type { RemoteModelDto } from "@pi/remote-control-contracts";
import { useConnectionStore } from "./connection.store";
import { NetError } from "@/net/errors";

/**
 * Redacted model catalog store.
 *
 * The gateway exposes only host-configured models with `remoteAllowed`
 * semantics; provider credentials and base URLs never leave the desktop.
 * Capability probes are fail-closed: when the catalog is unavailable the
 * selectors render the "host default" option and remote routes reject a
 * `modelRef` with a stable error instead of silently downgrading.
 */

interface ModelCatalogState {
  models: readonly RemoteModelDto[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  available: boolean | null;

  refresh: () => Promise<void>;
  reset: () => void;
}

function errorMessage(e: unknown): string {
  return e instanceof NetError ? e.message : "fetch_failed";
}

export const useModelCatalog = create<ModelCatalogState>((set, get) => ({
  models: [],
  loaded: false,
  loading: false,
  error: null,
  available: null,

  refresh: async () => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await client.listModels();
      set({
        models: res.models,
        loaded: true,
        loading: false,
        error: null,
        available: true,
      });
    } catch (e) {
      const unavailable = e instanceof NetError && e.status === 503;
      set((state) => ({
        loading: false,
        error: unavailable ? null : errorMessage(e),
        available: unavailable ? false : state.available,
      }));
    }
  },

  reset: () =>
    set({
      models: [],
      loaded: false,
      loading: false,
      error: null,
      available: null,
    }),
}));

/** Models the current device may actually select (host-available + allowed). */
export function selectableModels(models: readonly RemoteModelDto[]): RemoteModelDto[] {
  return models.filter((model) => model.available && model.remoteAllowed);
}

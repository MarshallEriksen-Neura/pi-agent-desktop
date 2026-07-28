"use client";

/**
 * pi models.json access — custom provider/model definitions.
 *
 * pi merges ~/.pi/agent/models.json into its model registry at startup, so
 * adding/removing entries here requires a pi restart to take effect (same
 * write-then-restart flow as settings.json — we piggyback on the settings
 * store's dirtyRestart banner).
 *
 * File shape (confirmed against pi's loader):
 *   {
 *     "providers": {
 *       "<providerId>": {
 *         "baseUrl": "https://…/v1",
 *         "api": "openai-completions" | "openai-responses" | "anthropic-messages" | …,
 *         "apiKey": "sk-…",
 *         "models": [{ "id", "name", "reasoning", "input", "contextWindow", "maxTokens" }]
 *       }
 *     }
 *   }
 */

import { create } from "zustand";
import { isTauri } from "./client";
import { usePiSettings } from "./settings";

export interface CustomModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface CustomProvider {
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: CustomModelDef[];
  [key: string]: unknown;
}

export interface ModelsJson {
  providers: Record<string, CustomProvider>;
  [key: string]: unknown;
}

export const API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

const MOCK_MODELS: ModelsJson = {
  providers: {
    "my-proxy": {
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      apiKey: "sk-mock",
      models: [
        {
          id: "gpt-5-mini",
          name: "GPT-5 Mini (proxy)",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200000,
          maxTokens: 16384,
        },
      ],
    },
  },
};

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface ProviderConfig {
  baseUrl: string;
  api: string;
  apiKey?: string;
}

interface PiModelsStore {
  mock: boolean;
  loaded: boolean;
  path: string;
  /** parsed models.json; { providers: {} } when the file doesn't exist */
  data: ModelsJson;
  parseError: string | null;
  lastError: string | null;

  load: () => Promise<void>;
  /**
   * Add (or replace, same provider+id) a model. If the provider already
   * exists, non-empty cfg fields update it and other models are kept.
   */
  addModel: (
    providerId: string,
    cfg: ProviderConfig,
    model: CustomModelDef
  ) => Promise<void>;
  /**
   * Fetch the provider's model list over HTTP (OpenAI-compatible / Google).
   * In mock (non-Tauri) mode returns a static sample list so the UI is usable.
   */
  fetchModels: (baseUrl: string, api: string, apiKey?: string) => Promise<string[]>;
  /** Bulk-add many models to a provider in a single save. */
  addModels: (
    providerId: string,
    cfg: ProviderConfig,
    models: CustomModelDef[]
  ) => Promise<void>;
  /** Update a provider's connection settings (baseUrl/api/apiKey); creates the
   * provider with no models if it doesn't exist yet. Models are preserved. */
  updateProvider: (providerId: string, cfg: ProviderConfig) => Promise<void>;
  /** Remove a whole provider (and all its models). */
  removeProvider: (providerId: string) => Promise<void>;
  /** Remove a model; a provider left with no models is dropped entirely. */
  removeModel: (providerId: string, modelId: string) => Promise<void>;
  /**
   * Edit an existing model. Handles provider/model ID renames atomically:
   * removes from the old location and upserts at the new one in a single save.
   * If baseUrl/apiKey are empty the old provider's values are inherited.
   */
  updateModel: (
    oldProviderId: string,
    oldModelId: string,
    newProviderId: string,
    cfg: ProviderConfig,
    model: CustomModelDef
  ) => Promise<void>;
}

const EMPTY: ModelsJson = { providers: {} };

function normalize(data: unknown): ModelsJson {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as ModelsJson;
    return { ...d, providers: d.providers ?? {} };
  }
  return structuredClone(EMPTY);
}

export const usePiModels = create<PiModelsStore>((set, get) => ({
  mock: !isTauri(),
  loaded: false,
  path: "",
  data: structuredClone(EMPTY),
  parseError: null,
  lastError: null,

  load: async () => {
    if (get().mock) {
      set({
        loaded: true,
        path: "~/.pi/agent/models.json",
        data: structuredClone(MOCK_MODELS),
        parseError: null,
      });
      return;
    }
    try {
      const raw = await tauriInvoke<{ path: string; exists: boolean; content: string }>(
        "pi_settings_read",
        { scope: "models" }
      );
      if (!raw.exists || !raw.content.trim()) {
        set({ loaded: true, path: raw.path, data: structuredClone(EMPTY), parseError: null });
        return;
      }
      try {
        set({
          loaded: true,
          path: raw.path,
          data: normalize(JSON.parse(raw.content)),
          parseError: null,
        });
      } catch (e) {
        set({
          loaded: true,
          path: raw.path,
          parseError: e instanceof Error ? e.message : String(e),
        });
      }
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  addModel: async (providerId, cfg, model) => {
    const st = get();
    if (st.parseError) return; // never overwrite a file we couldn't parse
    const data = structuredClone(st.data);
    const existing = data.providers[providerId];
    const provider: CustomProvider = existing
      ? {
          ...existing,
          ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          ...(cfg.api ? { api: cfg.api } : {}),
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          models: [...(existing.models ?? [])],
        }
      : {
          baseUrl: cfg.baseUrl,
          api: cfg.api,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          models: [],
        };
    const idx = provider.models.findIndex((m) => m.id === model.id);
    if (idx >= 0) provider.models[idx] = model;
    else provider.models.push(model);
    data.providers[providerId] = provider;
    await save(data, set, get);
  },

  fetchModels: async (baseUrl, api, apiKey) => {
    if (get().mock) {
      // sample list so the UI flow is testable in the browser
      await new Promise((r) => setTimeout(r, 300));
      return [
        "gpt-4o-mini",
        "gpt-4o",
        "gpt-4-turbo",
        "o3-mini",
        "text-embedding-3-small",
      ];
    }
    return tauriInvoke<string[]>("pi_fetch_models", {
      baseUrl,
      api,
      apiKey: apiKey ?? null,
    });
  },

  addModels: async (providerId, cfg, models) => {
    const st = get();
    if (st.parseError) return; // never overwrite a file we couldn't parse
    if (models.length === 0) return;
    const data = structuredClone(st.data);
    const existing = data.providers[providerId];
    const provider: CustomProvider = existing
      ? {
          ...existing,
          ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          ...(cfg.api ? { api: cfg.api } : {}),
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          models: [...(existing.models ?? [])],
        }
      : {
          baseUrl: cfg.baseUrl,
          api: cfg.api,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          models: [],
        };
    const seen = new Set(provider.models.map((m) => m.id));
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      provider.models.push(m);
    }
    data.providers[providerId] = provider;
    await save(data, set, get);
  },

  updateProvider: async (providerId, cfg) => {
    const st = get();
    if (st.parseError) return;
    const data = structuredClone(st.data);
    const existing = data.providers[providerId];
    const provider: CustomProvider = existing
      ? {
          ...existing,
          baseUrl: cfg.baseUrl,
          api: cfg.api,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          models: existing.models ?? [],
        }
      : {
          baseUrl: cfg.baseUrl,
          api: cfg.api,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          models: [],
        };
    data.providers[providerId] = provider;
    await save(data, set, get);
  },

  removeProvider: async (providerId) => {
    const st = get();
    if (st.parseError) return;
    const data = structuredClone(st.data);
    delete data.providers[providerId];
    await save(data, set, get);
  },

  removeModel: async (providerId, modelId) => {
    const st = get();
    if (st.parseError) return;
    const data = structuredClone(st.data);
    const provider = data.providers[providerId];
    if (!provider) return;
    provider.models = (provider.models ?? []).filter((m) => m.id !== modelId);
    if (provider.models.length === 0) delete data.providers[providerId];
    await save(data, set, get);
  },

  updateModel: async (oldProviderId, oldModelId, newProviderId, cfg, model) => {
    const st = get();
    if (st.parseError) return;
    const data = structuredClone(st.data);

    // Snapshot the old provider before we potentially delete it, so we can
    // fall back to its baseUrl/apiKey when the user left those fields empty.
    const oldSnap = data.providers[oldProviderId]
      ? { ...data.providers[oldProviderId] }
      : undefined;

    // Remove old entry; drop the provider if it becomes empty
    const oldProvider = data.providers[oldProviderId];
    if (oldProvider) {
      oldProvider.models = (oldProvider.models ?? []).filter((m) => m.id !== oldModelId);
      if (oldProvider.models.length === 0) delete data.providers[oldProviderId];
    }

    // Upsert into the (possibly renamed) provider
    const existing = data.providers[newProviderId];
    const provider: CustomProvider = existing
      ? {
          ...existing,
          ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          ...(cfg.api ? { api: cfg.api } : {}),
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          models: [...(existing.models ?? [])],
        }
      : {
          // provider doesn't exist yet — use submitted values, falling back to
          // the old snapshot so an unchanged baseUrl/apiKey isn't lost
          baseUrl: cfg.baseUrl || oldSnap?.baseUrl || "",
          api: cfg.api || oldSnap?.api || "openai-completions",
          ...(cfg.apiKey
            ? { apiKey: cfg.apiKey }
            : oldSnap?.apiKey
              ? { apiKey: oldSnap.apiKey }
              : {}),
          models: [],
        };
    const idx = provider.models.findIndex((m) => m.id === model.id);
    if (idx >= 0) provider.models[idx] = model;
    else provider.models.push(model);
    data.providers[newProviderId] = provider;

    await save(data, set, get);
  },
}));

async function save(
  next: ModelsJson,
  set: (partial: Partial<PiModelsStore>) => void,
  get: () => PiModelsStore
) {
  const prev = get().data;
  set({ data: next }); // optimistic
  if (get().mock) {
    usePiSettings.setState({ dirtyRestart: true });
    return;
  }
  try {
    await tauriInvoke("pi_settings_write", {
      scope: "models",
      content: JSON.stringify(next, null, 2) + "\n",
      root: null,
    });
    usePiSettings.setState({ dirtyRestart: true });
    set({ lastError: null });
  } catch (e) {
    set({ data: prev, lastError: e instanceof Error ? e.message : String(e) });
  }
}

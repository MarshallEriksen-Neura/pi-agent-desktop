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
import { getBackendKind, getPort } from "../backend/composition/container";
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

/**
 * One entry under `providers` in models.json.
 *
 * Every field is optional, matching pi's own `ProviderConfigSchema`. pi only
 * requires that *something* is set — `baseUrl`, `headers`, `compat`,
 * `modelOverrides`, `apiKey`, `oauth` or `authHeader` — so a bare
 * `{ "anthropic": { "apiKey": "sk-…" } }` credential override is valid and must
 * not be read as if `models` were an array. models.json entries are applied on
 * top of pi's built-in catalog, not in place of it.
 */
export interface CustomProvider {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: CustomModelDef[];
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
  /**
   * Reconcile a provider against a fetched list: add `add`, delete `remove`,
   * one save. Unlike `removeModel` this keeps a provider that ends up with no
   * models — the baseUrl/apiKey are still worth something, and an upstream that
   * momentarily lists nothing shouldn't cost the user their credentials.
   */
  syncModels: (
    providerId: string,
    cfg: ProviderConfig,
    add: CustomModelDef[],
    remove: string[]
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

/**
 * Kept byte-faithful past the `providers` key: whatever we hold here is what
 * `save` writes back, so filling in defaults or dropping odd entries would
 * quietly rewrite the user's file. Reads defend themselves instead.
 */
function normalize(data: unknown): ModelsJson {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as ModelsJson;
    return { ...d, providers: d.providers ?? {} };
  }
  return structuredClone(EMPTY);
}

/**
 * A provider's own model definitions, or `[]`.
 *
 * `models` is absent from a credential-only override, and a hand-edited file
 * can hold something that isn't an array at all. pi would reject the latter,
 * but the UI still has to render rather than throw.
 */
export function providerModels(provider: CustomProvider | undefined): CustomModelDef[] {
  return Array.isArray(provider?.models) ? provider.models : [];
}

/**
 * The connection fields to persist, blanks omitted.
 *
 * pi types `baseUrl`/`api` as `String({ minLength: 1 })` and rejects the
 * *whole* models.json on a schema error, so writing `""` for a field the user
 * left blank would take every other provider down with it. An absent key is
 * the valid way to say "no override".
 */
function endpointFields(cfg: ProviderConfig): CustomProvider {
  return {
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.api ? { api: cfg.api } : {}),
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  };
}

export const usePiModels = create<PiModelsStore>((set, get) => ({
  mock: false,
  loaded: false,
  path: "",
  data: structuredClone(EMPTY),
  parseError: null,
  lastError: null,

  load: async () => {
    const isMock = getBackendKind() === "browser-preview";
    try {
      const raw = await getPort("piConfiguration").readSettings("models");
      if (!raw.exists || !raw.content.trim()) {
        set({
          mock: isMock,
          loaded: true,
          path: raw.path,
          data: structuredClone(EMPTY),
          parseError: null,
        });
        return;
      }
      try {
        set({
          mock: isMock,
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
    // pi rejects the whole models.json if any entry has an empty id — refuse
    // to write one here so a single blank model can't blank the model list.
    if (!model.id || !model.id.trim()) return;
    const data = structuredClone(st.data);
    const existing = data.providers[providerId];
    const provider: CustomProvider = {
      ...(existing ?? {}),
      ...endpointFields(cfg),
      models: [...providerModels(existing)],
    };
    const models = provider.models!;
    const idx = models.findIndex((m) => m.id === model.id);
    if (idx >= 0) models[idx] = model;
    else models.push(model);
    data.providers[providerId] = provider;
    await save(data, set, get);
  },

  fetchModels: async (baseUrl, api, apiKey) => {
    return getPort("piConfiguration").fetchModels({
      baseUrl,
      api,
      apiKey,
    });
  },

  addModels: async (providerId, cfg, models) => {
    const st = get();
    if (st.parseError) return; // never overwrite a file we couldn't parse
    const clean = models.filter((m) => m.id && m.id.trim());
    if (clean.length === 0) return;
    const data = structuredClone(st.data);
    const existing = data.providers[providerId];
    const provider: CustomProvider = {
      ...(existing ?? {}),
      ...endpointFields(cfg),
      models: [...providerModels(existing)],
    };
    const next = provider.models!;
    const seen = new Set(next.map((m) => m.id));
    for (const m of clean) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      next.push(m);
    }
    data.providers[providerId] = provider;
    await save(data, set, get);
  },

  syncModels: async (providerId, cfg, add, remove) => {
    const st = get();
    if (st.parseError) return; // never overwrite a file we couldn't parse
    const clean = add.filter((m) => m.id && m.id.trim());
    const drop = new Set(remove);
    if (clean.length === 0 && drop.size === 0) return;

    const data = structuredClone(st.data);
    const existing = data.providers[providerId];
    if (!existing) return; // sync only reconciles a provider that already exists
    const provider: CustomProvider = {
      ...existing,
      ...endpointFields(cfg),
      models: providerModels(existing).filter((m) => !drop.has(m.id)),
    };
    const models = provider.models!;
    const seen = new Set(models.map((m) => m.id));
    for (const m of clean) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
    data.providers[providerId] = provider;
    await save(data, set, get);
  },

  updateProvider: async (providerId, cfg) => {
    const st = get();
    if (st.parseError) return;
    const data = structuredClone(st.data);
    const existing = data.providers[providerId];
    const provider: CustomProvider = { ...(existing ?? {}), ...endpointFields(cfg) };
    // Unlike the other writers, this one is the provider editor: blanking a
    // field there means "clear the override", not "leave it alone".
    if (!cfg.baseUrl) delete provider.baseUrl;
    if (!cfg.api) delete provider.api;
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
    if (!model.id || !model.id.trim()) return;
    const data = structuredClone(st.data);

    // Snapshot the old provider before we potentially delete it, so we can fall
    // back to its baseUrl/api/apiKey when the user left those fields empty.
    const oldSnap = data.providers[oldProviderId]
      ? { ...data.providers[oldProviderId] }
      : undefined;

    // Remove old entry; drop the provider if it becomes empty
    const oldProvider = data.providers[oldProviderId];
    if (oldProvider) {
      oldProvider.models = providerModels(oldProvider).filter((m) => m.id !== oldModelId);
      if (oldProvider.models.length === 0) delete data.providers[oldProviderId];
    }

    // Upsert into the (possibly renamed) provider
    const existing = data.providers[newProviderId];
    const provider: CustomProvider = {
      ...(existing ?? {}),
      // A provider that doesn't exist yet inherits the old snapshot's
      // connection fields, so an unchanged baseUrl/api/apiKey isn't lost. An
      // existing one keeps its own — the snapshot belongs to a different entry.
      ...endpointFields(
        existing
          ? cfg
          : {
              baseUrl: cfg.baseUrl || oldSnap?.baseUrl || "",
              // A model needs *some* api; pi errors out without one.
              api: cfg.api || oldSnap?.api || "openai-completions",
              apiKey: cfg.apiKey || oldSnap?.apiKey,
            }
      ),
      models: [...providerModels(existing)],
    };
    const models = provider.models!;
    const idx = models.findIndex((m) => m.id === model.id);
    if (idx >= 0) models[idx] = model;
    else models.push(model);
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
  try {
    await getPort("piConfiguration").writeSettings(
      "models",
      JSON.stringify(next, null, 2) + "\n",
      null
    );
    usePiSettings.setState({ dirtyRestart: true });
    set({ lastError: null });
  } catch (e) {
    set({ data: prev, lastError: e instanceof Error ? e.message : String(e) });
  }
}

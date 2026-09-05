"use client";

/**
 * How models.json and pi's live report combine into the cards the models page
 * renders.
 *
 * The two are not alternatives. pi applies a models.json provider *on top of*
 * its built-in catalog (`applyModelsJson`: it maps the base models, then upserts
 * `config.models ?? []` over them), and every field of a provider entry is
 * optional in pi's own `ProviderConfigSchema` — `models` included. So all of
 * these are valid files:
 *
 *   { "my-proxy":  { "baseUrl": "…", "api": "…", "models": [ … ] } }  own catalog
 *   { "anthropic": { "apiKey": "sk-ant-…" } }                        credentials only
 *   { "openai":    { "modelOverrides": { "gpt-5": { … } } } }        tweaks only
 *
 * The last two define no models of their own. Reading `provider.models` as an
 * array there throws, and treating them as empty is barely better: the card
 * would claim zero models while suppressing the built-in card it stands in for,
 * hiding a provider the user is signed in to.
 */

import { type CustomModelDef, type CustomProvider, providerModels } from "./models";

/**
 * One rendered provider card.
 *
 * `builtin` and `localIds` answer two questions that used to be conflated.
 * `builtin` is about the *provider*: absent from models.json, so provider-level
 * actions (settings, fetch, delete) have nothing to act on. `localIds` is about
 * each *model*: a models.json definition we can edit, or a built-in one we can
 * only enable. A credential-only override is a models.json provider whose models
 * are all built-in — editable card, read-only rows.
 */
export interface ProviderEntry {
  providerId: string;
  provider: CustomProvider;
  /** Pi's merged catalog overlaid with local definitions awaiting restart. */
  allModels: CustomModelDef[];
  /** Ids in `allModels` that models.json defines — the editable/deletable ones. */
  localIds: Set<string>;
  /** `allModels` narrowed by the page-wide search term. */
  matchedModels: CustomModelDef[];
  /** The provider id itself matched, so all its models are shown. */
  providerMatch: boolean;
  builtin: boolean;
}

/** pi's reported models grouped by provider — its merged catalog. */
export function groupPiModels(
  models: readonly { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }[]
): Record<string, CustomModelDef[]> {
  const out: Record<string, CustomModelDef[]> = {};
  for (const model of models) {
    (out[model.provider] ??= []).push({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
    });
  }
  return out;
}

/**
 * Built-in providers to render as cards of their own, so a subscription signed
 * in under Settings → Accounts shows up where users already look.
 *
 * A provider models.json names is skipped: it renders as the editable card
 * instead, which is the one worth keeping. That also settles the overlap case (a
 * provider both built in and overridden, like `openrouter`) the way pi does —
 * one card, the override's.
 */
export function builtinProviderCards(
  piProviderModels: Record<string, CustomModelDef[]>,
  customProviders: Record<string, CustomProvider>
): Record<string, CustomProvider> {
  const out: Record<string, CustomProvider> = {};
  for (const [providerId, models] of Object.entries(piProviderModels)) {
    if (customProviders[providerId]) continue;
    // Built-in catalogs live in pi, not models.json: no baseUrl or api to show,
    // and nothing here is editable.
    out[providerId] = { models };
  }
  return out;
}

/**
 * The cards to render, custom first — those are the ones the user configured by
 * hand. Providers that match neither the term nor any model are dropped.
 */
export function buildProviderEntries(
  customProviders: Record<string, CustomProvider>,
  piProviderModels: Record<string, CustomModelDef[]>,
  search: string
): ProviderEntry[] {
  const term = search.trim().toLowerCase();
  const entries: ProviderEntry[] = [];

  const collect = (source: Record<string, CustomProvider>, builtin: boolean) => {
    for (const [providerId, provider] of Object.entries(source)) {
      const own = providerModels(provider);
      // Pi reports the effective merged catalog. Overlay local definitions so newly
      // saved models are visible before the restart that makes Pi load models.json.
      const allModels = [...(piProviderModels[providerId] ?? [])];
      const positions = new Map(allModels.map((model, index) => [model.id, index]));
      for (const model of own) {
        const index = positions.get(model.id);
        if (index === undefined) {
          positions.set(model.id, allModels.length);
          allModels.push(model);
        } else {
          allModels[index] = { ...allModels[index], ...model };
        }
      }
      const providerMatch = providerId.toLowerCase().includes(term);
      const isEditableProvider = Object.keys(provider).some((key) => key !== "modelOverrides");
      const effectiveBuiltin =
        builtin || (!isEditableProvider && Boolean(piProviderModels[providerId]));
      entries.push({
        providerId,
        provider,
        allModels,
        localIds: new Set(own.map((m) => m.id)),
        matchedModels: allModels.filter(
          (m) =>
            providerMatch ||
            m.id.toLowerCase().includes(term) ||
            (m.name && m.name.toLowerCase().includes(term))
        ),
        providerMatch,
        builtin: effectiveBuiltin,
      });
    }
  };

  collect(customProviders, false);
  collect(builtinProviderCards(piProviderModels, customProviders), true);

  return entries.filter(
    ({ matchedModels, providerMatch }) => providerMatch || matchedModels.length > 0
  );
}

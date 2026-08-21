"use client";

/**
 * `enabledModels` entries — pi's model-scope patterns as they live in
 * settings.json.
 *
 * pi identifies a model by provider **and** id, and its own selector persists
 * canonical `provider/id` refs. A bare model id is still accepted, but pi's
 * resolver (`core/model-resolver.findExactModelReferenceMatch`) rejects a bare
 * id that exists under more than one provider and then falls back to fuzzy
 * matching — so when two providers serve the same model (`anthropic/claude-opus-5`
 * and a proxy's `claude-opus-5`), a bare entry resolves to the wrong copy or to
 * none at all. Writing bare ids also fuses the two copies into a single on/off
 * bit in our own UI.
 *
 * So: always *write* canonical refs, keep *reading* legacy bare ids.
 *
 * Refs are compared whole, never split: model ids may themselves contain
 * slashes (`inclusionai/ling-3.0-flash:free`), which makes `provider/id`
 * unsplittable without knowing the provider list.
 */

/** Minimum shape needed to identify a model — `PiModel` satisfies it. */
export interface ModelRefLike {
  provider: string;
  id: string;
}

/** The canonical `provider/id` ref pi writes to settings.json. */
export function modelRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/**
 * Glob patterns stay pi's business — resolving them client-side would need
 * minimatch and pi's precedence rules, so callers show everything instead.
 */
export function hasGlobEntry(entries: readonly string[]): boolean {
  return entries.some((e) => e.includes("*") || e.includes("?") || e.includes("["));
}

/** Is this exact provider+model named by the scope list? */
export function isModelEnabled(
  entries: readonly string[],
  provider: string,
  id: string
): boolean {
  const ref = modelRef(provider, id);
  // `e === id` is the legacy bare-id form; it matches every provider serving it.
  return entries.some((e) => e === ref || e === id);
}

/**
 * Flip one model's scope membership, always writing canonical refs.
 *
 * Switching a model *off* that was only covered by a legacy bare id expands
 * that entry into canonical refs for the other providers serving the same id,
 * so its siblings stay enabled instead of disappearing with it.
 */
export function toggleModelEnabled(
  entries: readonly string[],
  provider: string,
  id: string,
  allModels: readonly ModelRefLike[] = []
): string[] {
  const ref = modelRef(provider, id);

  if (!isModelEnabled(entries, provider, id)) {
    return entries.includes(ref) ? [...entries] : [...entries, ref];
  }

  const out: string[] = [];
  const push = (e: string) => {
    if (!out.includes(e)) out.push(e);
  };
  for (const entry of entries) {
    if (entry === ref) continue; // this model's own ref — the one being removed
    if (entry === id) {
      for (const sib of allModels) {
        if (sib.id === id && sib.provider !== provider) push(modelRef(sib.provider, sib.id));
      }
      continue;
    }
    push(entry);
  }
  return out;
}

/**
 * Drop scope entries naming models that no longer exist.
 *
 * `enabledModels` is a plain string list, so a model deleted from models.json —
 * or dropped upstream and pruned by a fetch — leaves an entry behind that no UI
 * can see or uncheck. Those dead refs are not harmless: pi still counts them
 * when deciding whether the scope list is non-empty, so a list that has decayed
 * to nothing but dead refs hides *every* live model from the picker.
 *
 * `allModels` must be the model list from **before** the removal, so a legacy
 * bare id can still expand into canonical refs for the providers that keep
 * serving it. Glob entries are left alone — matching them is pi's job.
 */
export function pruneModelsFromScope(
  entries: readonly string[],
  removed: readonly ModelRefLike[],
  allModels: readonly ModelRefLike[] = []
): string[] {
  let out = [...entries];
  for (const m of removed) {
    // toggle *adds* when absent, so only flip the ones actually named
    if (!isModelEnabled(out, m.provider, m.id)) continue;
    out = toggleModelEnabled(out, m.provider, m.id, allModels);
  }
  return out;
}

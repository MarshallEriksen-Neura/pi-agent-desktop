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

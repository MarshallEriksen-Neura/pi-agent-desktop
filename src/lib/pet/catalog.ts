/**
 * Built-in pet catalog — dynamically loaded from build-time manifest
 */

import type { BuiltinPet } from './types';

/** In-memory cache to avoid repeated fetches within a session */
let _builtinCache: BuiltinPet[] | null = null;

/**
 * Fetch the builtin pet catalog from the bundled manifest.
 * The manifest is generated at build time by scripts/gen-pet-manifest.mjs.
 */
export async function fetchBuiltinCatalog(): Promise<BuiltinPet[]> {
  if (_builtinCache) return _builtinCache;

  try {
    const res = await fetch('/pets/builtin/manifest.json');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json() as { pets: BuiltinPet[] };
    _builtinCache = data.pets;
    return data.pets;
  } catch (e) {
    console.error('[catalog] Failed to load builtin pet catalog:', e);
    // Return empty array if manifest is missing (e.g., development before first build)
    return [];
  }
}

/**
 * Get a specific builtin pet from the catalog
 */
export function getBuiltinPet(id: string, catalog: BuiltinPet[]): BuiltinPet | null {
  return catalog.find((p) => p.id === id) ?? null;
}

export const CDN_BASE_URL = 'https://persistent.oaistatic.com/codex/pets/v1';

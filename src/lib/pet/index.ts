/**
 * Pet loader — orchestrates asset download and manifest loading
 */

import { getBuiltinPet } from "./catalog";
import { ensureBuiltinPet } from "./assets";
import { loadPetManifest, validateSpritesheet } from "./loader";
import type { Pet } from "./types";

const BUILTIN_MANIFEST_BASE = "/pets/builtin";
const CUSTOM_MANIFEST_BASE = "/pets/custom";

/**
 * Load a builtin pet by ID
 *
 * Local-first: builtin manifests AND spritesheets ship in /public/pets/builtin,
 * so we use them directly. Only if the bundled spritesheet is missing or
 * invalid do we fall back to downloading from the CDN (blob URL).
 */
export async function loadBuiltinPet(petId: string): Promise<Pet> {
  const catalogEntry = getBuiltinPet(petId);
  if (!catalogEntry) {
    throw new Error(`Unknown builtin pet: ${petId}`);
  }

  const base = `${BUILTIN_MANIFEST_BASE}/${petId}`;
  const pet = await loadPetManifest(`${base}/pet.json`, base);

  try {
    // Also warms the image cache for the sprite renderer
    await validateSpritesheet(pet.spritesheetPath);
  } catch {
    // Bundled asset missing/invalid — fall back to CDN download.
    // Use the returned blob URL as-is; it is a complete opaque URL and
    // must never be joined with a file name.
    pet.spritesheetPath = await ensureBuiltinPet(petId);
  }

  return pet;
}

/**
 * Load a custom pet from user directory
 * Format: /path/to/pets/<pet-id>/pet.json
 */
export async function loadCustomPet(petId: string): Promise<Pet> {
  const manifestPath = `${CUSTOM_MANIFEST_BASE}/${petId}/pet.json`;
  const spritesheetBasePath = `${CUSTOM_MANIFEST_BASE}/${petId}`;

  return await loadPetManifest(manifestPath, spritesheetBasePath);
}

/**
 * Load any pet (tries builtin first, then custom)
 */
export async function loadPet(petId: string): Promise<Pet> {
  if (getBuiltinPet(petId)) {
    return await loadBuiltinPet(petId);
  }
  return await loadCustomPet(petId);
}

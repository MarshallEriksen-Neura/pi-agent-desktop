/**
 * Pet loader — orchestrates asset download and manifest loading
 */

import { fetchBuiltinCatalog, getBuiltinPet } from "./catalog";
import { ensureBuiltinPet } from "./assets";
import { loadPetManifest, validateSpritesheet } from "./loader";
import type { Pet } from "./types";

const BUILTIN_MANIFEST_BASE = "/pets/builtin";

/**
 * Load a builtin pet by ID.
 *
 * Local-first: builtin manifests AND spritesheets ship in /public/pets/builtin,
 * so we use them directly. Only if the bundled spritesheet is missing or
 * invalid do we fall back to downloading from the CDN (blob URL).
 */
export async function loadBuiltinPet(petId: string): Promise<Pet> {
  const catalog = await fetchBuiltinCatalog();
  if (!getBuiltinPet(petId, catalog)) {
    throw new Error(`Unknown builtin pet: ${petId}`);
  }

  const base = `${BUILTIN_MANIFEST_BASE}/${petId}`;
  const pet = await loadPetManifest(`${base}/pet.json`, base);

  try {
    await validateSpritesheet(pet.spritesheetPath);
  } catch {
    // Bundled asset missing/invalid — fall back to CDN download.
    pet.spritesheetPath = await ensureBuiltinPet(petId);
  }

  return pet;
}

/**
 * Load a user-installed custom pet from a filesystem path (Tauri desktop only).
 *
 * basePath is the absolute path returned by list_custom_pets (e.g.
 * C:/Users/…/AppData/Local/dev.pi.desktop/pets/custom/my-pet).
 * convertFileSrc turns it into an asset:// URL the WebView can load.
 */
export async function loadCustomPetFromDisk(
  petId: string,
  basePath: string
): Promise<Pet> {
  // Convert filesystem path to an asset:// URL served by Tauri's asset protocol
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const assetBase = convertFileSrc(basePath);

  const manifestUrl = `${assetBase}/pet.json`;
  return await loadPetManifest(manifestUrl, assetBase);
}

/**
 * Load any pet — builtin by ID, or custom from disk.
 * When basePath is provided the pet is loaded as a custom disk pet.
 */
export async function loadPet(
  petId: string,
  basePath?: string
): Promise<Pet> {
  if (basePath) {
    return loadCustomPetFromDisk(petId, basePath);
  }
  return loadBuiltinPet(petId);
}

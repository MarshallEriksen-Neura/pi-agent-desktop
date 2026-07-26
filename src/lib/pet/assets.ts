/**
 * Pet asset manager — handles CDN download, caching, and validation
 * Compatible with Codex CDN structure
 */

import { getBuiltinPet, CDN_BASE_URL } from "./catalog";
import { validateSpritesheet, PetLoadError } from "./loader";
import type { BuiltinPet } from "./types";

const MAX_DOWNLOAD_SIZE = 4 * 1024 * 1024; // 4MB
const DOWNLOAD_TIMEOUT_MS = 15_000;
const CACHE_PREFIX = "pi-pet-cache-";

/**
 * Ensure a builtin pet's spritesheet is cached locally
 * Returns the blob URL for the cached spritesheet
 */
export async function ensureBuiltinPet(petId: string): Promise<string> {
  const pet = getBuiltinPet(petId);
  if (!pet) {
    throw new PetLoadError(`Unknown builtin pet: ${petId}`);
  }

  // Check cache first
  const cached = await getCachedSpritesheet(pet);
  if (cached) return cached;

  // Download and cache
  const url = `${CDN_BASE_URL}/${pet.spritesheetFile}`;
  const blob = await downloadWithLimit(url, MAX_DOWNLOAD_SIZE);

  // Validate before caching
  const blobUrl = URL.createObjectURL(blob);
  try {
    await validateSpritesheet(blobUrl);
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw e;
  }

  // Cache the blob
  await cacheSpritesheet(pet, blob);

  return blobUrl;
}

/**
 * Download with size limit
 */
async function downloadWithLimit(
  url: string,
  maxBytes: number
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PetLoadError(
      `Failed to download spritesheet: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!response.ok) {
    throw new PetLoadError(`Failed to download: HTTP ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new PetLoadError(
      `Download exceeds size limit: ${contentLength} > ${maxBytes}`
    );
  }

  const blob = await response.blob();
  if (blob.size > maxBytes) {
    throw new PetLoadError(
      `Downloaded file exceeds size limit: ${blob.size} > ${maxBytes}`
    );
  }

  return blob;
}

// v2: v1 databases may have been created without the store (open path lacked
// an upgrade handler), so bump the version to force onupgradeneeded and repair.
const DB_NAME = "PiPetCache";
const DB_VERSION = 2;
const STORE_NAME = "spritesheets";

function openPetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(new Error("Failed to open IndexedDB"));

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Cache spritesheet in IndexedDB
 */
async function cacheSpritesheet(
  pet: BuiltinPet,
  blob: Blob
): Promise<void> {
  const cacheKey = `${CACHE_PREFIX}${pet.spritesheetFile}`;

  if (typeof indexedDB === "undefined") {
    // No IndexedDB support (shouldn't happen in Tauri WebView)
    console.warn("IndexedDB not available, pet cache disabled");
    return;
  }

  const db = await openPetDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const putRequest = store.put(blob, cacheKey);
    putRequest.onsuccess = () => resolve();
    putRequest.onerror = () => reject(new Error("Failed to cache spritesheet"));
    tx.oncomplete = () => db.close();
  });
}

/**
 * Get cached spritesheet as blob URL
 */
async function getCachedSpritesheet(
  pet: BuiltinPet
): Promise<string | null> {
  const cacheKey = `${CACHE_PREFIX}${pet.spritesheetFile}`;

  if (typeof indexedDB === "undefined") return null;

  let db: IDBDatabase;
  try {
    db = await openPetDb();
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const getRequest = store.get(cacheKey);

    getRequest.onsuccess = () => {
      const blob = getRequest.result as Blob | undefined;
      if (blob) {
        resolve(URL.createObjectURL(blob));
      } else {
        resolve(null);
      }
    };

    getRequest.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

/**
 * Clear all cached pet assets
 */
export async function clearPetCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;

  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("PiPetCache");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Failed to clear pet cache"));
  });
}

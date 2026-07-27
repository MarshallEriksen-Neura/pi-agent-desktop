/**
 * Pet asset manager — handles CDN download, caching, and validation
 */

import { fetchBuiltinCatalog, CDN_BASE_URL } from "./catalog";
import { validateSpritesheet, PetLoadError } from "./loader";

const MAX_DOWNLOAD_SIZE = 4 * 1024 * 1024; // 4MB
const DOWNLOAD_TIMEOUT_MS = 15_000;
const CACHE_PREFIX = "pi-pet-cache-";

/**
 * Ensure a builtin pet's spritesheet is cached locally.
 * Requires the pet to have a cdnFile entry; throws if not present.
 * Returns the blob URL for the cached spritesheet.
 */
export async function ensureBuiltinPet(petId: string): Promise<string> {
  const catalog = await fetchBuiltinCatalog();
  const pet = catalog.find((p) => p.id === petId);
  if (!pet) {
    throw new PetLoadError(`Unknown builtin pet: ${petId}`);
  }
  if (!pet.cdnFile) {
    throw new PetLoadError(`No CDN fallback configured for pet: ${petId}`);
  }

  // Check cache first
  const cached = await getCachedSpritesheet(pet.cdnFile);
  if (cached) return cached;

  // Download and cache
  const url = `${CDN_BASE_URL}/${pet.cdnFile}`;
  const blob = await downloadWithLimit(url, MAX_DOWNLOAD_SIZE);

  // Validate before caching
  const blobUrl = URL.createObjectURL(blob);
  try {
    await validateSpritesheet(blobUrl);
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw e;
  }

  await cacheSpritesheet(pet.cdnFile, blob);
  return blobUrl;
}

async function downloadWithLimit(url: string, maxBytes: number): Promise<Blob> {
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

async function cacheSpritesheet(cdnFile: string, blob: Blob): Promise<void> {
  const cacheKey = `${CACHE_PREFIX}${cdnFile}`;

  if (typeof indexedDB === "undefined") {
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

async function getCachedSpritesheet(cdnFile: string): Promise<string | null> {
  const cacheKey = `${CACHE_PREFIX}${cdnFile}`;

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
      resolve(blob ? URL.createObjectURL(blob) : null);
    };
    getRequest.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

export async function clearPetCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;

  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("PiPetCache");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Failed to clear pet cache"));
  });
}

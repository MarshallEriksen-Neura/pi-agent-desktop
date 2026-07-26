/**
 * Pet preference persistence
 */

const STORAGE_KEY = "pi-desktop-pet-prefs";

export interface PetPreferences {
  enabled: boolean;
  petId: string | null;
  windowPosition?: { x: number; y: number };
  windowVisible: boolean;
}

const DEFAULT_PREFS: PetPreferences = {
  enabled: false,
  petId: null,
  windowVisible: true,
};

/**
 * Load pet preferences from localStorage
 */
export function loadPetPreferences(): PetPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_PREFS;

    const parsed = JSON.parse(stored);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch (error) {
    console.error("Failed to load pet preferences:", error);
    return DEFAULT_PREFS;
  }
}

/**
 * Save pet preferences to localStorage
 */
export function savePetPreferences(prefs: Partial<PetPreferences>): void {
  if (typeof window === "undefined") return;

  try {
    const current = loadPetPreferences();
    const updated = { ...current, ...prefs };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error("Failed to save pet preferences:", error);
  }
}

/**
 * Clear all pet preferences
 */
export function clearPetPreferences(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

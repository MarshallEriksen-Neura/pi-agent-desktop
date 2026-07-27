/**
 * Pet settings UI component for main app
 */

"use client";

import { useState, useEffect } from "react";
import { usePet } from "@/lib/pet/store";
import { fetchBuiltinCatalog } from "@/lib/pet/catalog";
import { loadPet } from "@/lib/pet/index";
import { showPetWindow, hidePetWindow, togglePetWindow } from "@/lib/pet/commands";
import { isTauri } from "@/lib/pi/client";
import { loadPetPreferences, savePetPreferences } from "@/lib/pet/persistence";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { PetConfigUpdate, BuiltinPet, CustomPetEntry } from "@/lib/pet/types";

/** Tell an already-open pet window that the selection changed */
function broadcastPetConfig(petId: string | null) {
  if (!isTauri()) return;
  const update: PetConfigUpdate = { petId };
  emit("pet-config-update", update).catch((err) => {
    console.error("[PetSettings] Failed to broadcast pet config:", err);
  });
}

interface PetEntry {
  id: string;
  displayName: string;
  description: string;
  source: "builtin" | "custom";
  basePath?: string; // for custom pets
}

export function PetSettings() {
  const { activePet, windowVisible, loadPet: storePet, disablePet } = usePet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PetEntry[]>([]);

  // Load catalog on mount
  useEffect(() => {
    loadCatalog();
  }, []);

  // Load saved preferences after catalog is loaded
  useEffect(() => {
    if (catalog.length === 0) return;
    const prefs = loadPetPreferences();
    if (prefs.enabled && prefs.petId) {
      handleSelectPet(prefs.petId, false); // Don't save on load
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  async function loadCatalog() {
    setError(null);
    try {
      const builtin = await fetchBuiltinCatalog();
      const builtinEntries: PetEntry[] = builtin.map((p) => ({
        ...p,
        source: "builtin" as const,
      }));

      let customEntries: PetEntry[] = [];
      if (isTauri()) {
        const custom = await invoke<CustomPetEntry[]>("list_custom_pets");
        customEntries = custom.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          description: p.description,
          source: "custom" as const,
          basePath: p.basePath,
        }));
      }

      setCatalog([...builtinEntries, ...customEntries]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[PetSettings] Failed to load catalog:", msg);
      setError(`Failed to load pet catalog: ${msg}`);
    }
  }

  const handleSelectPet = async (petId: string | null, persist = true) => {
    if (!petId) {
      disablePet();
      if (persist) {
        savePetPreferences({ enabled: false, petId: null });
      }
      broadcastPetConfig(null);
      if (isTauri()) {
        await hidePetWindow();
      }
      return;
    }

    const entry = catalog.find((p) => p.id === petId);
    if (!entry) {
      setError(`Pet not found in catalog: ${petId}`);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const pet = await loadPet(petId, entry.basePath);
      storePet(pet);

      if (persist) {
        savePetPreferences({ enabled: true, petId });
      }

      if (isTauri()) {
        await showPetWindow();
      }

      broadcastPetConfig(petId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      disablePet();
      if (persist) {
        savePetPreferences({ enabled: false, petId: null });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleToggleWindow = async () => {
    if (!isTauri()) return;
    try {
      await togglePetWindow();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const builtinPets = catalog.filter((p) => p.source === "builtin");
  const customPets = catalog.filter((p) => p.source === "custom");

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Desktop Pet</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          Choose a companion to show your agent's status
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="pet"
            value=""
            checked={!activePet}
            onChange={() => handleSelectPet(null)}
            disabled={loading}
          />
          <span className="text-sm">Disabled</span>
        </label>

        {builtinPets.length > 0 && (
          <>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-medium mt-3 mb-1">
              Built-in Pets
            </div>
            {builtinPets.map((pet) => (
              <label key={pet.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="pet"
                  value={pet.id}
                  checked={activePet?.id === pet.id}
                  onChange={() => handleSelectPet(pet.id)}
                  disabled={loading}
                />
                <span className="text-sm">{pet.displayName}</span>
                <span className="text-xs text-gray-500">— {pet.description}</span>
              </label>
            ))}
          </>
        )}

        {customPets.length > 0 && (
          <>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-medium mt-3 mb-1">
              Custom Pets
            </div>
            {customPets.map((pet) => (
              <label key={pet.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="pet"
                  value={pet.id}
                  checked={activePet?.id === pet.id}
                  onChange={() => handleSelectPet(pet.id)}
                  disabled={loading}
                />
                <span className="text-sm">{pet.displayName}</span>
                <span className="text-xs text-gray-500">— {pet.description}</span>
              </label>
            ))}
          </>
        )}
      </div>

      {isTauri() && customPets.length === 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 p-2 rounded">
          To add custom pets, place pet folders in:{" "}
          <code className="text-[11px]">AppData/Local/dev.pi.desktop/pets/custom/</code>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}

      {loading && <div className="text-xs text-gray-500">Loading pet...</div>}

      {activePet && isTauri() && (
        <button
          onClick={handleToggleWindow}
          className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          {windowVisible ? "Hide" : "Show"} Pet Window
        </button>
      )}

      {!isTauri() && activePet && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-2 rounded">
          Pet window requires Tauri desktop app
        </div>
      )}
    </div>
  );
}

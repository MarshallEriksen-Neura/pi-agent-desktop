/**
 * Pet settings UI component for main app
 */

"use client";

import { useState, useEffect } from "react";
import { usePet } from "@/lib/pet/store";
import { BUILTIN_PETS } from "@/lib/pet/catalog";
import { loadBuiltinPet } from "@/lib/pet/index";
import { showPetWindow, hidePetWindow, togglePetWindow } from "@/lib/pet/commands";
import { isTauri } from "@/lib/pi/client";
import { loadPetPreferences, savePetPreferences } from "@/lib/pet/persistence";
import { emit } from "@tauri-apps/api/event";
import type { PetConfigUpdate } from "@/lib/pet/types";

/** Tell an already-open pet window that the selection changed */
function broadcastPetConfig(petId: string | null) {
  if (!isTauri()) return;
  const update: PetConfigUpdate = { petId };
  emit("pet-config-update", update).catch((err) => {
    console.error("[PetSettings] Failed to broadcast pet config:", err);
  });
}

export function PetSettings() {
  const { activePet, windowVisible, loadPet, disablePet } = usePet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load saved preferences on mount
  useEffect(() => {
    const prefs = loadPetPreferences();
    if (prefs.enabled && prefs.petId) {
      handleSelectPet(prefs.petId, false); // Don't save on load
    }
  }, []);

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

    setLoading(true);
    setError(null);

    try {
      const pet = await loadBuiltinPet(petId);
      loadPet(pet);

      // A newly-created pet webview bootstraps from localStorage. Persist the
      // selection before opening it so it cannot start with stale preferences.
      if (persist) {
        savePetPreferences({ enabled: true, petId });
      }

      if (isTauri()) {
        await showPetWindow();
      }

      // Existing windows receive the update here; new windows also recover via
      // their pet-window-ready handshake after their listeners are installed.
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

        {BUILTIN_PETS.map((pet) => (
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
      </div>

      {error && (
        <div className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-xs text-gray-500">Loading pet...</div>
      )}

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

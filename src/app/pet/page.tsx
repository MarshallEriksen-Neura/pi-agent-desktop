"use client";

/**
 * Pet window — independent Tauri window for the desktop companion
 * Remains visible when main window is minimized.
 *
 * This route is NOT wrapped by the main app chrome (AppShell bypasses "/pet"),
 * runs in its own webview, and owns its own zustand store instance — so it
 * loads the active pet itself from persisted preferences instead of relying
 * on the main window's store.
 */

import { useEffect, useState } from "react";
import { usePet } from "@/lib/pet/store";
import { PetSprite } from "@/components/PetSprite";
import { loadPet as loadPetById } from "@/lib/pet";
import { loadPetPreferences } from "@/lib/pet/persistence";
import { isTauri } from "@/lib/pi/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import type { PetConfigUpdate, PetStateUpdate } from "@/lib/pet/types";

export default function PetWindow() {
  const { activePet, state, body, animationStartedAt, checkExpiry } = usePet();
  // Mount gate: the page is statically prerendered at build time, so anything
  // window/time/localStorage-dependent must only render after hydration.
  const [mounted, setMounted] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  useEffect(() => {
    setMounted(true);
    setLastUpdate(Date.now());
    // Frameless transparent window: the app-wide background must not paint here
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  // Load the persisted pet into THIS window's store
  useEffect(() => {
    let cancelled = false;
    const prefs = loadPetPreferences();
    if (prefs.enabled && prefs.petId) {
      loadPetById(prefs.petId)
        .then((pet) => {
          if (!cancelled) usePet.getState().loadPet(pet);
        })
        .catch((err) => {
          console.error("[PetWindow] Failed to load pet:", err);
          if (!cancelled) setConnectionError("Failed to load pet");
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for state + config updates from the main window
  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    const unlistenFns: (() => void)[] = [];

    const setupListeners = async () => {
      try {
        const unlistenState = await listen<PetStateUpdate>(
          "pet-state-update",
          (event) => {
            const { state, body } = event.payload;
            usePet.getState().setState(state, body);
            setLastUpdate(Date.now());
            setConnectionError(null); // Clear error on successful update
          }
        );
        const unlistenConfig = await listen<PetConfigUpdate>(
          "pet-config-update",
          async (event) => {
            const { petId } = event.payload;
            if (!petId) {
              usePet.getState().disablePet();
              return;
            }
            try {
              const pet = await loadPetById(petId);
              usePet.getState().loadPet(pet);
              setConnectionError(null);
            } catch (err) {
              console.error("[PetWindow] Failed to switch pet:", err);
              setConnectionError("Failed to load pet");
            }
          }
        );
        if (disposed) {
          unlistenState();
          unlistenConfig();
          return;
        }
        unlistenFns.push(unlistenState, unlistenConfig);
        setConnectionError(null);
        // Ask the main window to re-send the current agent state
        await emit("pet-window-ready", {});
      } catch (err) {
        console.error("[PetWindow] Failed to setup listener:", err);
        setConnectionError("Failed to connect to main window");
      }
    };

    setupListeners();

    return () => {
      disposed = true;
      unlistenFns.forEach((fn) => fn());
    };
  }, []);

  // Periodic expiry check
  useEffect(() => {
    const interval = setInterval(checkExpiry, 5000);
    return () => clearInterval(interval);
  }, [checkExpiry]);

  // Connection health check (detect if main window stopped sending updates)
  useEffect(() => {
    if (lastUpdate === 0) return;
    const healthCheck = setInterval(() => {
      const timeSinceLastUpdate = Date.now() - lastUpdate;
      // If no update in 30 seconds and not idle, show warning
      if (timeSinceLastUpdate > 30000 && state !== "idle") {
        setConnectionError("Main window may be unresponsive");
      }
    }, 10000);

    return () => clearInterval(healthCheck);
  }, [lastUpdate, state]);

  // Draggable window
  const handleMouseDown = async () => {
    try {
      const window = getCurrentWindow();
      await window.startDragging();
    } catch (err) {
      console.error("[PetWindow] Drag failed:", err);
    }
  };

  // Nothing until hydrated — the prerendered HTML stays empty and always matches
  if (!mounted) return null;

  if (!activePet) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-transparent">
        <div className="text-xs text-gray-500">No pet selected</div>
      </div>
    );
  }

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-end cursor-move select-none"
      onMouseDown={handleMouseDown}
      style={{
        // Transparent background for Tauri window
        backgroundColor: "transparent",
      }}
    >
      {/* Connection error indicator */}
      {connectionError && (
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2
                     bg-red-500/90 text-white text-[10px] px-2 py-1 rounded
                     shadow-lg whitespace-nowrap z-10"
        >
          {connectionError}
        </div>
      )}

      <PetSprite
        pet={activePet}
        state={state}
        animationStartedAt={animationStartedAt}
        bubble={body}
      />
    </div>
  );
}

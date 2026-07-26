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

import { useEffect, useLayoutEffect, useState } from "react";
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
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  useLayoutEffect(() => {
    setLastUpdate(Date.now());
    // Belt-and-suspenders transparency; the <style> tag in render also handles it
    // from the very first paint, so the pet window never looks opaque.
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

  // Render content unconditionally — SSR and first client render both render
  // the same tree (activePet defaults to null), so there's no hydration mismatch
  // and the pet window is never an empty (opaque-white) box.
  return (
    <>
      {/* Force html/body transparent from the very first paint — this lives in
          the prerendered HTML too, so a Tauri transparent window with no JS
          effect yet cannot appear as an opaque square. */}
      <style
        dangerouslySetInnerHTML={{
          __html: "html,body{background:transparent!important}",
        }}
      />
      {activePet ? (
        <div
          className="w-full h-full flex items-center justify-center"
          onMouseDown={handleMouseDown}
        >
          <PetSprite
            pet={activePet}
            state={state}
            animationStartedAt={animationStartedAt}
            bubble={body}
          />
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center text-white/50 text-xs">
          No pet selected
        </div>
      )}
    </>
  );
}

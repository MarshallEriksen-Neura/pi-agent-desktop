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

import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { usePet } from "@/lib/pet/store";
import { PetSprite } from "@/components/PetSprite";
import { loadPet as loadPetById } from "@/lib/pet";
import { loadPetPreferences } from "@/lib/pet/persistence";
import { getPort } from "@/lib/backend/composition/container";
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
    let disposed = false;
    const unlistenFns: (() => void)[] = [];

    const setupListeners = async () => {
      try {
        const petWindow = getPort("petWindow");
        const unlistenState = await petWindow.onStateUpdate(
          (event: PetStateUpdate) => {
            const { state, body } = event;
            usePet.getState().setState(state, body);
            setLastUpdate(Date.now());
            setConnectionError(null); // Clear error on successful update
          }
        );
        const unlistenConfig = await petWindow.onConfigUpdate(
          async (event: PetConfigUpdate) => {
            const { petId } = event;
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
        await petWindow.emitWindowReady();
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

  // Draggable window — but also detect click (vs drag) so a simple
  // click on the pet can emit an event to restore the main window.
  const dragRef = useRef({ x: 0, y: 0 });

  const handleMouseDown = async (e: React.MouseEvent) => {
    dragRef.current.x = e.clientX;
    dragRef.current.y = e.clientY;

    try {
      await getPort("window").startDragging();
    } catch (err) {
      console.error("[PetWindow] Drag failed:", err);
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // If the mouse barely moved, treat it as a click instead of a drag
    const dx = Math.abs(e.clientX - dragRef.current.x);
    const dy = Math.abs(e.clientY - dragRef.current.y);
    if (dx < 5 && dy < 5) {
      // Tell the main window to restore/focus itself
      getPort("petWindow").emitRestoreMain().catch((err) => {
        console.error("[PetWindow] Failed to emit pet-restore-main:", err);
      });
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
        // Bottom-aligned: the pet stands on the lower edge of the window and the
        // leftover space sits above it, which is where the speech bubble grows.
        <div
          className="w-full h-full flex items-end justify-center"
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        >
          <PetSprite
            pet={activePet}
            state={state}
            animationStartedAt={animationStartedAt}
            bubble={body}
          />
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <div className="rounded-xl bg-gray-600/80 text-white text-xs px-3 py-2">
            No pet selected
          </div>
        </div>
      )}
    </>
  );
}

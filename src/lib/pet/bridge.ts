"use client";

/**
 * Pet bridge — connects agent events to pet state
 * Integrates with existing agent-bridge.ts
 */

import { getPiClient, isTauri } from "@/lib/pi/client";
import { usePet } from "./store";
import type { PetState, PetStateUpdate } from "./types";
import { emit, listen } from "@tauri-apps/api/event";
import { sessionManager } from "./session-manager";
import { loadPetPreferences } from "./persistence";
import type { PiEvent } from "@/lib/pi/protocol";
import type { PetConfigUpdate } from "./types";

let bridged = false;
let currentSessionId: string | null = null;
let stateCheckInterval: NodeJS.Timeout | null = null;

/**
 * Initialize pet event bridge — call this once at app startup
 */
export function initPetBridge() {
  if (bridged) return;
  bridged = true;

  const client = getPiClient();

  // Listen for session events to track current session ID
  client.on("session", (e) => {
    if (e.type === "session") {
      currentSessionId = e.id;
      sessionManager.updateSession(e.id, "idle");
    }
  });

  // Real-time event-driven state updates (replaces polling)
  client.on("agent_start", () => {
    if (currentSessionId) {
      sessionManager.updateSession(currentSessionId, "running");
      syncStateToWindow();
    }
  });

  client.on("agent_settled", () => {
    if (currentSessionId) {
      sessionManager.updateSession(currentSessionId, "review", "Task complete");
      syncStateToWindow();
    }
  });

  client.on("agent_end", (e) => {
    if (e.type === "agent_end" && !e.willRetry && currentSessionId) {
      const hasMessages = Array.isArray(e.messages) && e.messages.length > 0;
      if (hasMessages) {
        sessionManager.updateSession(currentSessionId, "review", "Ready for review");
      } else {
        sessionManager.removeSession(currentSessionId);
      }
      syncStateToWindow();
    }
  });

  // Tool approval requests → waiting state
  client.on("extension_ui_request", () => {
    if (currentSessionId) {
      sessionManager.updateSession(currentSessionId, "waiting", "Needs approval");
      syncStateToWindow();
    }
  });

  // Tool execution events
  client.on("tool_execution_start", (e) => {
    if (e.type !== "tool_execution_start" || !currentSessionId) return;
    sessionManager.updateSession(currentSessionId, "running", `Running ${e.toolName}`);
    syncStateToWindow();
  });

  // Auto-retry events
  client.on("auto_retry_start", (e) => {
    if (e.type !== "auto_retry_start" || !currentSessionId) return;
    sessionManager.updateSession(
      currentSessionId,
      "running",
      `Retry ${e.attempt}/${e.maxAttempts}`
    );
    syncStateToWindow();
  });

  client.on("auto_retry_end", (e) => {
    if (e.type !== "auto_retry_end" || !currentSessionId) return;
    if (!e.success && e.finalError) {
      sessionManager.updateSession(currentSessionId, "failed", e.finalError);
    } else {
      sessionManager.updateSession(currentSessionId, "review", "Task complete");
    }
    syncStateToWindow();
  });

  // Fallback: periodic check for edge cases (longer interval now)
  stateCheckInterval = setInterval(() => {
    syncStateToWindow();
  }, 10000); // 10 seconds instead of 2

  // Newly opened pet window asks for the current state (it starts at idle)
  if (isTauri()) {
    listen("pet-window-ready", () => {
      const { activePet, state, body } = usePet.getState();
      const prefs = loadPetPreferences();
      const config: PetConfigUpdate = {
        petId: activePet?.id ?? (prefs.enabled ? prefs.petId : null),
      };
      const update: PetStateUpdate = {
        state,
        body: body ?? undefined,
        timestamp: Date.now(),
      };
      Promise.all([
        emit("pet-config-update", config),
        emit("pet-state-update", update),
      ]).catch((err) => {
        console.error("[PetBridge] Failed to answer pet-window-ready:", err);
      });
    }).catch((err) => {
      console.error("[PetBridge] Failed to listen for pet-window-ready:", err);
    });
  }
}

/**
 * Sync effective state to both main store and pet window
 */
function syncStateToWindow() {
  const effective = sessionManager.getEffectiveState();
  if (!effective) return;

  const current = usePet.getState();

  // Only update if state actually changed (avoid redundant updates)
  if (current.state === effective.state && current.body === effective.body) {
    return;
  }

  // Update main store
  usePet.getState().setState(effective.state, effective.body);

  // Emit to pet window
  if (isTauri()) {
    const update: PetStateUpdate = {
      state: effective.state,
      body: effective.body,
      timestamp: Date.now(),
    };
    emit("pet-state-update", update).catch((err) => {
      console.error("[PetBridge] Failed to emit state update:", err);
      // Attempt recovery: try again after 1 second
      setTimeout(() => {
        emit("pet-state-update", update).catch((retryErr) => {
          console.error("[PetBridge] Retry failed:", retryErr);
        });
      }, 1000);
    });
  }
}

/**
 * Update pet state for current session (for external use)
 */
export function updatePetState(state: PetState, body?: string) {
  if (currentSessionId) {
    sessionManager.updateSession(currentSessionId, state, body);
    syncStateToWindow();
  }
}

/**
 * Get current session ID (for debugging/testing)
 */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

/**
 * Manual state updates (for testing or direct control)
 */
export const petBridge = {
  setRunning: (body?: string) => updatePetState("running", body),
  setWaiting: (body?: string) => updatePetState("waiting", body),
  setReview: (body?: string) => updatePetState("review", body),
  setFailed: (body?: string) => updatePetState("failed", body),
  setIdle: () => updatePetState("idle"),
  getSessionId: () => getCurrentSessionId(),
};

/**
 * Cleanup on unmount
 */
export function destroyPetBridge() {
  if (stateCheckInterval) {
    clearInterval(stateCheckInterval);
    stateCheckInterval = null;
  }
  bridged = false;
  currentSessionId = null;
}

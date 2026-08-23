"use client";

/**
 * Pet bridge — connects agent events to pet state
 * Integrates with existing agent-bridge.ts
 */

import { getPiClient } from "@/lib/pi/client";
import { getActiveTaskId } from "@/lib/pi/task-context";
import { usePet } from "./store";
import type { PetState, PetStateUpdate } from "./types";
import { sessionManager } from "./session-manager";
import { loadPetPreferences } from "./persistence";
import { showPetWindow } from "./commands";
import { STATE_FALLBACK_BODIES } from "./state-lifetimes";
import type { PiEvent } from "@/lib/pi/protocol";
import type { PetConfigUpdate } from "./types";
import { showNotification } from "@/lib/notifications";
import { MODAL_METHODS } from "@/lib/pi/ext-ui";
import { useUI } from "@/lib/store";
import { restoreFromTray } from "@/lib/window-close";
import { t } from "@/lib/i18n";
import { getPort } from "@/lib/backend/composition/container";

let bridged = false;
let currentSessionId: string | null = null;
let stateCheckInterval: NodeJS.Timeout | null = null;
let petWindowUnlisteners: Array<() => void> = [];
let piUnlisteners: Array<() => void> = [];

/**
 * Session key used when pi has not announced a session id.
 *
 * `protocol.ts` declares a `session` event, but pi does not emit one — verified
 * against pi 0.83.0 two ways: `pi --mode rpc` produces only
 * extension_ui_request / response / entry_appended / custom (at boot, and after
 * `get_state` and `new_session`), and its own `docs/rpc.md` documents no such
 * event. Gating every handler on a real session id therefore left
 * sessionManager permanently empty, the effective state pinned to idle, and the
 * pet mute for entire runs — no bubble, no state animation, no notification.
 *
 * The id is only a map key for sessionManager, so a constant is enough; a real
 * `session` event (future pi, or the mock transport) still takes over below.
 */
const FALLBACK_SESSION_ID = "pi-default";

function sessionKey(): string {
  return currentSessionId ?? FALLBACK_SESSION_ID;
}

/**
 * Subscribe the pet's live state to a specific task's pi event stream. Rebinding
 * to a new task switches which conversation drives the pet.
 */
function bindPetPi(taskId: string) {
  piUnlisteners.forEach((unlisten) => unlisten());
  piUnlisteners = [];

  const client = getPiClient(taskId);

  // Listen for session events to track current session ID
  piUnlisteners.push(client.on("session", (e) => {
    if (e.type === "session") {
      currentSessionId = e.id;
      // Drop the synthetic entry so priority resolution cannot pick a stale
      // pre-session state over the real one.
      sessionManager.removeSession(FALLBACK_SESSION_ID);
      sessionManager.updateSession(e.id, "idle");
    }
  }));

  // Real-time event-driven state updates (replaces polling)
  piUnlisteners.push(client.on("agent_start", () => {
    sessionManager.updateSession(sessionKey(), "running");
    syncStateToWindow();
  }));

  piUnlisteners.push(client.on("agent_settled", () => {
    sessionManager.updateSession(sessionKey(), "review", "Task complete");
    syncStateToWindow();
  }));

  piUnlisteners.push(client.on("agent_end", (e) => {
    if (e.type !== "agent_end" || e.willRetry) return;
    const hasMessages = Array.isArray(e.messages) && e.messages.length > 0;
    if (hasMessages) {
      sessionManager.updateSession(sessionKey(), "review", "Ready for review");
    } else {
      sessionManager.removeSession(sessionKey());
    }
    syncStateToWindow();
  }));

  // Tool approval requests → waiting state. Only the modal methods are actual
  // requests: pi fires extension_ui_request for setStatus/setWidget/notify
  // chatter too (18 within 12s of an idle boot), and treating those as approvals
  // pinned the pet to "waiting" — priority 4, a 24h lifetime — which outranks
  // and hides the running state for the rest of the day.
  piUnlisteners.push(client.on("extension_ui_request", (e) => {
    if (e.type !== "extension_ui_request" || !MODAL_METHODS.has(e.method)) return;
    sessionManager.updateSession(sessionKey(), "waiting", "Needs approval");
    syncStateToWindow();
  }));

  // Tool execution events
  piUnlisteners.push(client.on("tool_execution_start", (e) => {
    if (e.type !== "tool_execution_start") return;
    sessionManager.updateSession(sessionKey(), "running", `Running ${e.toolName}`);
    syncStateToWindow();
  }));

  // Auto-retry events
  piUnlisteners.push(client.on("auto_retry_start", (e) => {
    if (e.type !== "auto_retry_start") return;
    sessionManager.updateSession(
      sessionKey(),
      "running",
      `Retry ${e.attempt}/${e.maxAttempts}`
    );
    syncStateToWindow();
  }));

  piUnlisteners.push(client.on("auto_retry_end", (e) => {
    if (e.type !== "auto_retry_end") return;
    if (!e.success && e.finalError) {
      sessionManager.updateSession(sessionKey(), "failed", e.finalError);
    } else {
      sessionManager.updateSession(sessionKey(), "review", "Task complete");
    }
    syncStateToWindow();
  }));
}

/**
 * Initialize pet event bridge — call this once at app startup. Re-binding to a
 * different task id switches which conversation drives the pet's state.
 */
export function initPetBridge(taskId?: string) {
  bindPetPi(taskId ?? getActiveTaskId());
  if (bridged) return;
  bridged = true;

  // Fallback: periodic check for edge cases (longer interval now)
  stateCheckInterval = setInterval(() => {
    syncStateToWindow();
  }, 10000); // 10 seconds instead of 2

  // Newly opened pet window asks for the current state (it starts at idle)
  const petWindow = getPort("petWindow");

  petWindow
    .onWindowReady(() => {
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
        petWindow.emitConfigUpdate(config),
        petWindow.emitStateUpdate(update),
      ])
        .then(() => {
          // Reveal the window only now. Startup pre-warms it hidden (see the pet
          // effect in AppShell) so its Next boot never competes with the main
          // window's first paint; showing it any earlier would flash the
          // prerendered "No pet selected" placeholder. Hidden stays hidden when
          // the user turned the window off, and when no pet is configured.
          if (!config.petId || !prefs.enabled || !prefs.windowVisible) return;
          return showPetWindow();
        })
        .catch((err) => {
          console.error("[PetBridge] Failed to answer pet-window-ready:", err);
        });
    })
    .then((unlisten) => {
      if (!bridged) unlisten();
      else petWindowUnlisteners.push(unlisten);
    })
    .catch((err) => {
      console.error("[PetBridge] Failed to listen for pet-window-ready:", err);
    });

  // Listen for clicks on the pet window — user clicked the pet,
  // restore the main window to the foreground.
  petWindow
    .onRestoreMain(() => {
      restoreFromTray().catch((err) => {
        console.error("[PetBridge] Failed to restore main window:", err);
      });
    })
    .then((unlisten) => {
      if (!bridged) unlisten();
      else petWindowUnlisteners.push(unlisten);
    })
    .catch((err) => {
      console.error("[PetBridge] Failed to listen for pet-restore-main:", err);
    });
}

/**
 * Sync effective state to both main store and pet window
 */
function syncStateToWindow() {
  const effective = sessionManager.getEffectiveState();
  if (!effective) return;

  // Resolve the body exactly the way the store will, so the change check below
  // compares like with like. `getEffectiveState()` reports `body: undefined`
  // for a session carrying no detail text, while `setState()` normalizes that
  // to the state's fallback string (or `null` for idle) — comparing the two raw
  // values made `null === undefined` fail, so an unchanged idle state was
  // re-pushed on every 10s tick and each push reset `animationStartedAt`,
  // restarting the 6.6s idle loop.
  const resolvedBody =
    effective.body ?? (STATE_FALLBACK_BODIES[effective.state] || null);

  const current = usePet.getState();

  // Only update if state actually changed (avoid redundant updates)
  if (current.state === effective.state && current.body === resolvedBody) {
    return;
  }

  // Update main store
  usePet.getState().setState(effective.state, effective.body);

  // Emit to pet window. Send the resolved text rather than `undefined` (which
  // JSON drops) so both windows render the same bubble without depending on
  // their own copy of the fallback table.
  const update: PetStateUpdate = {
    state: effective.state,
    body: resolvedBody ?? undefined,
    timestamp: Date.now(),
  };
  getPort("petWindow").emitStateUpdate(update).catch((err) => {
      console.error("[PetBridge] Failed to emit state update:", err);
      // Attempt recovery: try again after 1 second
      setTimeout(() => {
        getPort("petWindow").emitStateUpdate(update).catch((retryErr) => {
          console.error("[PetBridge] Retry failed:", retryErr);
        });
      }, 1000);
    });

  // Fire an OS notification when the pet transitions to a terminal
  // state (review / waiting / failed) while the main window is hidden.
  // Passes the raw body so firePetNotification keeps its own per-state
  // wording ("Ready for review" etc.) instead of the terser bubble fallback.
  firePetNotification(effective.state, effective.body);
}

/**
 * Fire an OS notification when the pet transitions to a terminal state
 * (review / waiting / failed) and the main window is hidden. Respects
 * the user's notification-settings toggle.
 */
function firePetNotification(state: PetState, body?: string) {
  // Only notify for terminal-ish states
  if (state !== "review" && state !== "waiting" && state !== "failed") return;

  // Respect the user's notification setting
  const { notificationSettings } = useUI.getState();
  if (!notificationSettings.enabled) return;

  // Only show when the window is hidden (same pattern as chat.ts)
  if (typeof document !== "undefined" && document.visibilityState !== "hidden") return;

  let title: string;
  let notifBody: string;

  switch (state) {
    case "review":
      title = t("pet.notif.taskComplete");
      notifBody = body ?? "Ready for review";
      break;
    case "waiting":
      title = t("pet.notif.needsInput");
      notifBody = body ?? "Needs approval";
      break;
    case "failed":
      title = t("pet.notif.taskFailed");
      notifBody = body ?? "Blocked";
      break;
    default:
      return;
  }

  showNotification(title, {
    body: notifBody.slice(0, 120),
    onClick: () => {
      // Restore the main window from the system tray
      void restoreFromTray();
    },
  });
}

/**
 * Update pet state for current session (for external use)
 */
export function updatePetState(state: PetState, body?: string) {
  sessionManager.updateSession(sessionKey(), state, body);
  syncStateToWindow();
}

/*
 * Fire a pet notification for a manual state transition.
 * Exported for testing purposes.
 */
export function firePetNotificationForTest(state: PetState, body?: string) {
  firePetNotification(state, body);
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
  piUnlisteners.forEach((unlisten) => unlisten());
  piUnlisteners = [];
  petWindowUnlisteners.forEach((unlisten) => unlisten());
  petWindowUnlisteners = [];
}

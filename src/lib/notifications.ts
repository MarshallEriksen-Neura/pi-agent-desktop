"use client";

/**
 * OS notification wrapper for Pi Desktop.
 *
 * Two backends, picked at runtime by `isTauri()`:
 *
 * - **Tauri** (`@tauri-apps/plugin-notification`): the real desktop path. The
 *   Web Notification API is NOT usable inside Tauri's webview — WebView2 /
 *   WKWebView / WebKitGTK have no notification permission delegate wired up, so
 *   `Notification.requestPermission()` resolves to `"denied"` and nothing ever
 *   shows. The plugin talks to the OS notification centre from Rust instead.
 * - **Browser** (`pnpm dev` without Tauri): the standard Web Notification API,
 *   so the mock transport stays fully navigable and the Playwright specs can
 *   spy on `window.Notification`.
 */

import { isTauri } from "./pi/client";

export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

type NotificationPlugin = typeof import("@tauri-apps/plugin-notification");

let pluginPromise: Promise<NotificationPlugin | null> | null = null;

/** Lazily load the plugin so the browser bundle never pulls it in eagerly. */
function plugin(): Promise<NotificationPlugin | null> {
  if (!pluginPromise) {
    pluginPromise = import("@tauri-apps/plugin-notification").catch((err) => {
      console.warn("Tauri notification plugin unavailable:", err);
      return null;
    });
  }
  return pluginPromise;
}

/**
 * Last known permission state. The plugin API is async but the settings UI
 * needs a synchronous read, so the value is cached and refreshed by
 * `refreshNotificationPermission()` / `requestNotificationPermission()`.
 */
let cached: NotificationPermissionState = "default";

/** Click handler of the most recent notification (Tauri path). */
let lastClickHandler: (() => void) | null = null;
let actionListenerAttached = false;

/**
 * Wire the plugin's action channel once so clicking a toast can bring the
 * window back. Desktop support varies by platform; failures are non-fatal
 * because the tray icon is always available as a fallback.
 */
async function attachActionListener(api: NotificationPlugin) {
  if (actionListenerAttached) return;
  actionListenerAttached = true;
  try {
    await api.onAction(() => lastClickHandler?.());
  } catch (err) {
    console.warn("Notification action listener unavailable:", err);
  }
}

/**
 * Request notification permission from the user.
 * Should be called on user interaction (e.g. when enabling the setting).
 * @returns true if permission is granted
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  if (isTauri()) {
    const api = await plugin();
    if (!api) {
      cached = "unsupported";
      return false;
    }
    try {
      if (await api.isPermissionGranted()) {
        cached = "granted";
        return true;
      }
      const permission = await api.requestPermission();
      cached = permission === "granted" ? "granted" : "denied";
      return cached === "granted";
    } catch (err) {
      console.warn("Notification permission request failed:", err);
      cached = "unsupported";
      return false;
    }
  }

  if (!("Notification" in window)) {
    cached = "unsupported";
    return false;
  }
  if (Notification.permission !== "default") {
    cached = Notification.permission;
    return cached === "granted";
  }
  try {
    const permission = await Notification.requestPermission();
    cached = permission;
    return permission === "granted";
  } catch (err) {
    console.warn("Notification permission request failed:", err);
    return false;
  }
}

/**
 * Read the cached permission state without hitting the OS.
 * Call `refreshNotificationPermission()` first if the value may be stale.
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (typeof window === "undefined") return "unsupported";
  if (isTauri()) return cached;
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/**
 * Re-read the permission state from the OS (Tauri) or the browser and update
 * the cache. Safe to call on mount.
 */
export async function refreshNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === "undefined") return "unsupported";

  if (isTauri()) {
    const api = await plugin();
    if (!api) {
      cached = "unsupported";
      return cached;
    }
    try {
      cached = (await api.isPermissionGranted()) ? "granted" : "default";
    } catch (err) {
      console.warn("Notification permission check failed:", err);
      cached = "unsupported";
    }
    return cached;
  }

  cached = "Notification" in window ? Notification.permission : "unsupported";
  return cached;
}

interface ShowNotificationOptions {
  /** Notification body text */
  body: string;
  /** Optional callback when the notification is clicked */
  onClick?: () => void;
}

/**
 * Show an OS notification if the window is hidden.
 *
 * Browser path: gated on `document.visibilityState`. Tauri path: also treats a
 * window hidden into the tray or minimized as "not visible", because webview
 * document visibility is not reliably updated by a native `hide()`.
 */
export function showNotification(
  title: string,
  options: ShowNotificationOptions
): void {
  if (typeof window === "undefined") return;

  if (isTauri()) {
    void showViaPlugin(title, options);
    return;
  }

  // Only surface a notification when the user cannot see the window.
  if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
    return;
  }

  showViaWebApi(title, options);
}

/**
 * Whether the main window is currently out of sight — hidden to the tray,
 * minimized, or reported hidden by the webview.
 */
async function isWindowObscured(): Promise<boolean> {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return true;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    const [visible, minimized] = await Promise.all([
      w.isVisible(),
      w.isMinimized(),
    ]);
    return !visible || minimized;
  } catch (err) {
    console.warn("Window visibility check failed:", err);
    return false;
  }
}

async function showViaPlugin(title: string, options: ShowNotificationOptions) {
  if (!(await isWindowObscured())) return;

  const api = await plugin();
  if (!api) return;
  try {
    // The OS may have revoked permission since the last check.
    if (!(await api.isPermissionGranted())) {
      cached = "default";
      return;
    }
    cached = "granted";
    lastClickHandler = options.onClick ?? null;
    if (options.onClick) await attachActionListener(api);
    api.sendNotification({ title, body: options.body });
  } catch (err) {
    console.warn("Failed to show notification:", err);
  }
}

function showViaWebApi(title: string, options: ShowNotificationOptions) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  try {
    const notification = new Notification(title, {
      body: options.body,
      icon: "/icon.png",
      badge: "/icon.png",
      // Reuse the tag so a new notification replaces the previous one.
      tag: "pi-desktop-message",
    });
    if (options.onClick) {
      notification.onclick = () => {
        options.onClick?.();
        notification.close();
      };
    }
  } catch (err) {
    console.warn("Failed to show notification:", err);
  }
}

/** Initialize notification permission state on app load. */
export function initNotifications(): void {
  void refreshNotificationPermission();
}

"use client";

/**
 * OS notification wrapper for Pi Desktop.
 *
 * OS notification wrapper for Pi Desktop.
 */

import { getPort } from "./backend/composition/container";

export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

/**
 * Request notification permission from the user.
 * Should be called on user interaction (e.g. when enabling the setting).
 * @returns true if permission is granted
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  return getPort("notification").requestPermission();
}

/**
 * Read the cached permission state without hitting the OS.
 * Call `refreshNotificationPermission()` first if the value may be stale.
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (typeof window === "undefined") return "unsupported";
  return getPort("notification").getPermission();
}

/**
 * Re-read the permission state from the OS (Tauri) or the browser and update
 * the cache. Safe to call on mount.
 */
export async function refreshNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === "undefined") return "unsupported";
  return getPort("notification").refreshPermission();
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
  getPort("notification").show({ title, ...options });
}

/** Initialize notification permission state on app load. */
export function initNotifications(): void {
  void refreshNotificationPermission();
}

"use client";

/**
 * Browser Notification API wrapper for Pi Desktop.
 * Requests permission, shows OS notifications when the window is hidden,
 * and handles click events to focus the window.
 */

let permissionGranted = false;

/**
 * Request notification permission from the user.
 * Should be called on user interaction (e.g., when enabling the setting).
 * @returns Promise<boolean> - true if permission granted
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "granted") {
    permissionGranted = true;
    return true;
  }

  if (Notification.permission === "denied") {
    return false;
  }

  try {
    const permission = await Notification.requestPermission();
    permissionGranted = permission === "granted";
    return permissionGranted;
  } catch (err) {
    console.warn("Notification permission request failed:", err);
    return false;
  }
}

/**
 * Check current notification permission status without requesting.
 * @returns "granted" | "denied" | "default" | "unsupported"
 */
export function getNotificationPermission():
  | "granted"
  | "denied"
  | "default"
  | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

interface ShowNotificationOptions {
  /** Notification body text */
  body: string;
  /** Optional callback when notification is clicked */
  onClick?: () => void;
}

/**
 * Show an OS notification if the window is hidden and permission is granted.
 * Automatically checks document.visibilityState before showing.
 *
 * @param title - Notification title
 * @param options - Body text and optional click handler
 * @returns The Notification instance if shown, null otherwise
 */
export function showNotification(
  title: string,
  options: ShowNotificationOptions
): Notification | null {
  // Browser check
  if (typeof window === "undefined" || !("Notification" in window)) {
    return null;
  }

  // Permission check
  if (Notification.permission !== "granted") {
    return null;
  }

  // Visibility check - only show when window is hidden
  if (document.visibilityState !== "hidden") {
    return null;
  }

  try {
    const notification = new Notification(title, {
      body: options.body,
      icon: "/icon.png", // assuming icon exists in public/
      badge: "/icon.png",
      tag: "pi-desktop-message", // reuse tag to replace previous notifications
    });

    if (options.onClick) {
      notification.onclick = () => {
        options.onClick?.();
        notification.close();
      };
    }

    return notification;
  } catch (err) {
    console.warn("Failed to show notification:", err);
    return null;
  }
}

/**
 * Initialize notification permission state on app load.
 * Call this early in the app lifecycle.
 */
export function initNotifications(): void {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return;
  }
  permissionGranted = Notification.permission === "granted";
}

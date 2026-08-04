import * as notification from "@tauri-apps/plugin-notification";
import type {
  NotificationPort,
  ShowNotificationInput,
} from "../ports/notification";
import type { NotificationPermissionState } from "../../notifications";
import { desktopWindowPort } from "./window";

let cached: NotificationPermissionState = "default";
let lastClickHandler: (() => void) | null = null;
let actionListenerAttached = false;

async function attachActionListener() {
  if (actionListenerAttached) return;
  actionListenerAttached = true;
  try {
    await notification.onAction(() => lastClickHandler?.());
  } catch (err) {
    console.warn("Notification action listener unavailable:", err);
  }
}

async function isWindowObscured(): Promise<boolean> {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return true;
  }
  try {
    const [visible, minimized] = await Promise.all([
      desktopWindowPort.isVisible(),
      desktopWindowPort.isMinimized(),
    ]);
    return !visible || minimized;
  } catch (err) {
    console.warn("Window visibility check failed:", err);
    return false;
  }
}

export const desktopNotificationPort = {
  requestPermission: async () => {
    try {
      if (await notification.isPermissionGranted()) {
        cached = "granted";
        return true;
      }
      const permission = await notification.requestPermission();
      cached = permission === "granted" ? "granted" : "denied";
      return cached === "granted";
    } catch (err) {
      console.warn("Notification permission request failed:", err);
      cached = "unsupported";
      return false;
    }
  },
  getPermission: () => cached,
  refreshPermission: async () => {
    try {
      cached = (await notification.isPermissionGranted()) ? "granted" : "default";
    } catch (err) {
      console.warn("Notification permission check failed:", err);
      cached = "unsupported";
    }
    return cached;
  },
  show: (input: ShowNotificationInput) => {
    void (async () => {
      if (!(await isWindowObscured())) return;
      try {
        if (!(await notification.isPermissionGranted())) {
          cached = "default";
          return;
        }
        cached = "granted";
        lastClickHandler = input.onClick ?? null;
        if (input.onClick) await attachActionListener();
        notification.sendNotification({ title: input.title, body: input.body });
      } catch (err) {
        console.warn("Failed to show notification:", err);
      }
    })();
  },
} satisfies NotificationPort;

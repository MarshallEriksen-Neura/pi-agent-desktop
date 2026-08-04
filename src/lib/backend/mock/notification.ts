import type {
  NotificationPort,
  ShowNotificationInput,
} from "../ports/notification";
import type { NotificationPermissionState } from "../../notifications";

function browserPermission(): NotificationPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

export const mockNotificationPort = {
  requestPermission: async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    if (Notification.permission !== "default") return Notification.permission === "granted";
    try {
      return (await Notification.requestPermission()) === "granted";
    } catch (err) {
      console.warn("Notification permission request failed:", err);
      return false;
    }
  },
  getPermission: browserPermission,
  refreshPermission: async () => browserPermission(),
  show: (input: ShowNotificationInput) => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (typeof document !== "undefined" && document.visibilityState !== "hidden") return;
    if (Notification.permission !== "granted") return;
    try {
      const item = new Notification(input.title, {
        body: input.body,
        icon: "/icon.png",
        badge: "/icon.png",
        tag: "pi-desktop-message",
      });
      if (input.onClick) {
        item.onclick = () => {
          input.onClick?.();
          item.close();
        };
      }
    } catch (err) {
      console.warn("Failed to show notification:", err);
    }
  },
} satisfies NotificationPort;

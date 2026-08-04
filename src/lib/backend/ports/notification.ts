import type { NotificationPermissionState } from "../../notifications";

export interface ShowNotificationInput {
  title: string;
  body: string;
  onClick?: () => void;
}

export interface NotificationPort {
  requestPermission(): Promise<boolean>;
  getPermission(): NotificationPermissionState;
  refreshPermission(): Promise<NotificationPermissionState>;
  show(input: ShowNotificationInput): void;
}

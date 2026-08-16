/**
 * Notification service — surfaces task/conversation lifecycle events as
 * system local notifications when the user is not already looking at the
 * relevant screen.
 *
 * Rules of thumb:
 *  - Only notify for terminal completion and pending-interaction turns —
 *    running/streaming noise stays silent.
 *  - Skip when the app is foregrounded on the matching page: the transcript
 *    itself is the notification.
 *  - Tapping a notification deep-links to the conversation/task detail page.
 */
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { PluginListenerHandle } from "@capacitor/core";
import { t } from "@/i18n";

export const NOTIFICATION_CHANNEL_ID = "pi-task-events";

/** Route prefix to navigate on tap, e.g. `/tasks/conv-…` */
export interface TaskNotification {
  id: number;
  title: string;
  body: string;
  /** deep-link target appended to `/tasks/` */
  routeSuffix: string;
}

const MAX_BODY = 120;

function trimBody(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_BODY
    ? `${collapsed.slice(0, MAX_BODY)}…`
    : collapsed;
}

/** Register the Android notification channel (no-op on other platforms). */
async function ensureChannel(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return;
  await LocalNotifications.createChannel({
    id: NOTIFICATION_CHANNEL_ID,
    name: t("notify.channelName"),
    description: t("notify.channelDesc"),
    importance: 4, // IMPORTANCE_HIGH — heads-up banner
    vibration: true,
    sound: "default",
  });
}

/**
 * Request permission. Returns false when denied — callers fall back to
 * in-app banners rather than fighting the user.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (Capacitor.getPlatform() === "android") {
      // Android 13+ asks at runtime; 12- shows nothing (channel-based).
      const { display } = await LocalNotifications.requestPermissions();
      if (display === "denied") return false;
    }
    await ensureChannel();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire a local notification. Best-effort: failures are swallowed — a failed
 * notification must never break the event pipeline.
 */
export async function notifyTaskEvent(notification: TaskNotification): Promise<void> {
  try {
    const permitted = await ensureNotificationPermission();
    if (!permitted) return;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notification.id,
          title: notification.title,
          body: trimBody(notification.body),
          channelId: NOTIFICATION_CHANNEL_ID,
          smallIcon: "ic_stat_pi",
          iconColor: "#0A84FF",
          extra: { route: `/tasks/${notification.routeSuffix}` },
          actionTypeId: "",
        },
      ],
    });
  } catch {
    // Swallow — notification is a nicety, not a contract.
  }
}

/**
 * Subscribe to notification taps. Returns an unsubscribe function.
 */
export function onTaskNotificationTap(
  handler: (route: string) => void,
): () => void {
  let listener: PluginListenerHandle | null = null;
  void LocalNotifications.addListener("localNotificationActionPerformed", (res) => {
    const route = (res.notification.extra as { route?: string } | undefined)?.route;
    if (route) handler(route);
  }).then((handle) => {    listener = handle;
  });
  return () => {
    listener?.remove();
  };
}

// ---------------------------------------------------------------------------
// Lifecycle-event bridge — called from the task/conversation stores.
// ---------------------------------------------------------------------------

import { getCurrentRoute } from "./route-tracker";

const DEDUP_MAX = 128;
const notifiedIds = new Set<string>();

/** FNV-1a — stable 31-bit id from a string, for the plugin's numeric ids. */
function stableId(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return (hash % 0x7fffffff) + 1;
}

function markNotified(key: string): boolean {
  if (notifiedIds.has(key)) return false;
  notifiedIds.add(key);
  if (notifiedIds.size > DEDUP_MAX) {
    const oldest = notifiedIds.values().next().value;
    if (oldest) notifiedIds.delete(oldest);
  }
  return true;
}

/** The user is foregrounded on the exact detail page — no notification. */
function isWatching(routeSuffix: string): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    getCurrentRoute() === `/tasks/${routeSuffix}`
  );
}

/**
 * Notify when a conversation turn reaches a terminal state and the user is
 * not watching that conversation. `preview` is truncated for the body.
 */
export async function maybeNotifyConversationCompleted(
  conversationId: string,
  preview: string | undefined,
): Promise<void> {
  if (isWatching(conversationId)) return;
  if (!markNotified(`conv-${conversationId}`)) return;
  await notifyTaskEvent({
    id: stableId(conversationId),
    title: t("notify.conversationDone"),
    body: preview || t("notify.conversationDoneBody"),
    routeSuffix: conversationId,
  });
}

/** Notify when a legacy one-shot task reaches a terminal state. */
export async function maybeNotifyTaskCompleted(
  taskId: string,
  state: string,
): Promise<void> {
  if (isWatching(taskId)) return;
  if (!markNotified(`task-${taskId}`)) return;
  await notifyTaskEvent({
    id: stableId(taskId),
    title: t("notify.taskDone"),
    body: t("notify.taskDoneBody", { state: t(`tasks.state.${state}`) }),
    routeSuffix: taskId,
  });
}

/** Notify when Pi is waiting on an interaction the user must answer. */
export async function maybeNotifyInteractionWaiting(
  conversationId: string,
  prompt: string,
): Promise<void> {
  if (isWatching(conversationId)) return;
  if (!markNotified(`ix-${conversationId}-${prompt.slice(0, 32)}`)) return;
  await notifyTaskEvent({
    id: stableId(`ix-${conversationId}`),
    title: t("notify.interactionWaiting"),
    body: prompt,
    routeSuffix: conversationId,
  });
}

/** Reset dedup state (on reconnect/reconcile, so a fresh completion re-alerts). */
export function resetNotificationDedup(): void {
  notifiedIds.clear();
}

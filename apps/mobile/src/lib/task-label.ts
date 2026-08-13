import { t } from "@/i18n";
import type { RemoteTaskSnapshot } from "@pi/remote-control-contracts";

/** Longest task title rendered before ellipsis. */
const MAX_TITLE_CHARS = 48;

/**
 * Best available label for a task.
 *
 * `RemoteTaskSnapshot` deliberately carries no prompt (the gateway never ships
 * task content back), so the order is: locally cached prompt → first context
 * file → short task id. Never a fabricated title.
 */
export function taskTitle(
  task: RemoteTaskSnapshot,
  promptCache: Record<string, string>,
): string {
  const cached = promptCache[task.taskId];
  if (cached) {
    const firstLine = cached.split("\n")[0].trim();
    return firstLine.length > MAX_TITLE_CHARS
      ? `${firstLine.slice(0, MAX_TITLE_CHARS)}…`
      : firstLine;
  }
  if (task.contextFiles.length > 0) {
    const first =
      task.contextFiles[0].relativePath.split("/").pop() ??
      task.contextFiles[0].relativePath;
    const extra =
      task.contextFiles.length > 1 ? ` +${task.contextFiles.length - 1}` : "";
    return `${first}${extra}`;
  }
  return `${t("tasks.untitled")} ${task.taskId.slice(0, 8)}`;
}

/** HH:MM for list metadata. Empty string on an unparseable timestamp. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

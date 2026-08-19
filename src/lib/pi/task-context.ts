"use client";

import { create } from "zustand";
import { DEFAULT_TASK_ID } from "../backend/ports/pi-process";

/**
 * The currently focused task id — the session whose transcript is on screen.
 *
 * Kept in its own tiny store (rather than inside `useSessions`) so `useChat`
 * and `usePi` can subscribe to task switches without importing sessions and
 * forming import cycles. `useSessions` calls `setActiveTaskId` whenever the
 * active session changes.
 */
interface TaskContextState {
  activeTaskId: string;
}

export const useTaskContext = create<TaskContextState>(() => ({
  activeTaskId: DEFAULT_TASK_ID,
}));

export function setActiveTaskId(id: string | null | undefined): void {
  const next = (id ?? "").trim() || DEFAULT_TASK_ID;
  if (useTaskContext.getState().activeTaskId === next) return;
  useTaskContext.setState({ activeTaskId: next });
}

export function getActiveTaskId(): string {
  return useTaskContext.getState().activeTaskId;
}

/* ── session-name + focus indirection (kept here so `useChat`/notifications can
   reference session metadata without importing sessions and forming a cycle) ── */

const sessionTitles = new Map<string, string>();

/** Record a conversation's display name (kept in sync by `useSessions`). */
export function setSessionTitle(taskId: string, title: string): void {
  sessionTitles.set(taskId, title);
}

export function getSessionTitle(taskId: string): string {
  return sessionTitles.get(taskId) ?? "";
}

let focusHandler: ((taskId: string) => void) | null = null;

/** Installed by `useSessions` so a background notification can focus its task. */
export function setFocusSessionHandler(fn: (taskId: string) => void): void {
  focusHandler = fn;
}

/** Switch the focused conversation to `taskId` (no-op when already focused). */
export function focusSession(taskId: string): void {
  focusHandler?.(taskId);
}
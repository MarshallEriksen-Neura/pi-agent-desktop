"use client";

/**
 * Turn scoping — the answer to "what did this turn change".
 *
 * The per-edit diffs already exist (see file-diffs, written by agent-bridge);
 * what was missing is a boundary to read them against. That boundary is the
 * turn: it opens on `agent_start` and is deliberately *not* closed on
 * `agent_end`, because reviewing what a turn did is something you do after it
 * finishes. The next turn's start is what retires the previous window.
 *
 * Aggregation is a sum of the turn's edits, not a net file-level diff. Two edits
 * to one file that add and then remove the same line count as `+1 −1` here
 * rather than cancelling out — the texts needed to compute a net diff are not
 * kept. Each edit itself still uses the real text delta (a disk before/after pair
 * or the tool's unified result patch), so an insert is counted the same way Git
 * counts it even if the editor's operation metrics also count its anchor rewrite.
 */

import { useMemo } from "react";
import { create } from "zustand";
import { useFileDiffs, type FileDiff } from "./file-diffs";

export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  /** at least one contributing edit was too large to diff exactly */
  approx?: boolean;
  /** the file's most recent edit in this turn — what its row opens */
  toolCallId: string;
  /** when the file was first touched this turn — the list's stable sort key */
  at: number;
  /** how many edits landed on this file this turn */
  edits: number;
}

export interface TurnChanges {
  files: TurnFileChange[];
  added: number;
  removed: number;
  approx?: boolean;
}

export const NO_CHANGES: TurnChanges = { files: [], added: 0, removed: 0 };

export interface TurnWindow {
  taskId: string;
  startedAt: number;
}

/**
 * Roll the turn's recorded diffs up per file.
 *
 * Attribution is on both axes and both are load-bearing. `startedAt` excludes
 * earlier turns; `taskId` excludes the *other* conversations, whose diffs share
 * this one map (it is keyed by pi's globally-unique toolCallId) — without it,
 * switching back to a task that ran an hour ago would show whatever the task you
 * just watched had edited.
 *
 * Files come back in the order the turn first touched them, so the list only ever
 * appends while work happens instead of reshuffling under the pointer.
 */
export function turnChanges(
  diffs: Record<string, FileDiff>,
  window: TurnWindow | null,
): TurnChanges {
  if (!window) return NO_CHANGES;
  /** `at` is the file's first touch (the sort key); `latestAt` picks the row's target. */
  type Acc = TurnFileChange & { latestAt: number };
  const byPath = new Map<string, Acc>();
  let added = 0;
  let removed = 0;
  let approx = false;

  for (const [toolCallId, diff] of Object.entries(diffs)) {
    if (diff.at < window.startedAt) continue;
    if (diff.taskId !== window.taskId) continue;
    added += diff.added;
    removed += diff.removed;
    if (diff.approx) approx = true;

    const current = byPath.get(diff.path);
    if (!current) {
      byPath.set(diff.path, {
        path: diff.path,
        added: diff.added,
        removed: diff.removed,
        ...(diff.approx ? { approx: true } : {}),
        toolCallId,
        at: diff.at,
        latestAt: diff.at,
        edits: 1,
      });
      continue;
    }
    current.added += diff.added;
    current.removed += diff.removed;
    current.edits += 1;
    if (diff.approx) current.approx = true;
    // the newest edit owns the row's diff; the first touch keeps its sort slot
    if (diff.at >= current.latestAt) {
      current.latestAt = diff.at;
      current.toolCallId = toolCallId;
    }
    if (diff.at < current.at) current.at = diff.at;
  }

  const files = [...byPath.values()]
    .sort((a, b) => a.at - b.at || a.path.localeCompare(b.path))
    .map(({ latestAt: _latestAt, ...file }) => file);
  return { files, added, removed, ...(approx ? { approx: true } : {}) };
}

interface TurnStore {
  /**
   * Turn start per task. Kept when the turn ends — the window is what "本轮改动"
   * reads against, and it has to survive the turn so the result can be reviewed.
   * The next `agent_start` on that task is what retires it.
   */
  starts: Record<string, number>;
  begin: (taskId: string) => void;
  clear: (taskId: string) => void;
}

export const useTurn = create<TurnStore>((set) => ({
  starts: {},
  begin: (taskId) =>
    set((s) => ({ starts: { ...s.starts, [taskId]: Date.now() } })),
  clear: (taskId) =>
    set((s) => {
      if (!(taskId in s.starts)) return s;
      const starts = { ...s.starts };
      delete starts[taskId];
      return { starts };
    }),
}));

/** This task's turn start, or null before its first turn. */
export function useTurnStart(taskId: string | null): number | null {
  return useTurn((s) => (taskId ? s.starts[taskId] ?? null : null));
}

/**
 * This task's turn window.
 *
 * Memoized rather than assembled inside the selector: a selector that builds an
 * object returns a new reference on every store read, which is what makes
 * useSyncExternalStore complain about an uncached snapshot and re-render on
 * changes that have nothing to do with this task.
 */
export function useTurnWindow(taskId: string | null): TurnWindow | null {
  const startedAt = useTurnStart(taskId);
  return useMemo(
    () => (taskId && startedAt !== null ? { taskId, startedAt } : null),
    [taskId, startedAt],
  );
}

/**
 * What this task's current turn changed. One source for both the header chip and
 * the panel, so the two cannot disagree about the totals.
 */
export function useTurnChanges(taskId: string | null): TurnChanges {
  const window = useTurnWindow(taskId);
  const diffs = useFileDiffs((s) => s.diffs);
  return useMemo(() => turnChanges(diffs, window), [diffs, window]);
}

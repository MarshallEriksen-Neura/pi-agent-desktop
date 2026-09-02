"use client";

/**
 * The before/after body of an agent edit — what the file inspector renders.
 *
 * The +/- badge on a transcript row already proves the numbers are in reach (see
 * diff-stat), but the *content* behind them was not: the bridge snapshots a file
 * before an edit tool runs and drops that snapshot the moment the tool ends, so
 * a row could report `+12 −3` and then have no way to say which twelve. This
 * module turns either a real pre/post pair or an editor-provided unified patch
 * into hunks and parks them where a panel opened seconds — or minutes — later
 * can still read them.
 *
 * Budgeted on purpose. A hunk list is text, not two integers, so unlike the stat
 * store this one caps what it keeps: a whole-file rewrite is cut to a readable
 * window and old entries are evicted. A panel that finds nothing falls back to
 * showing the file as it is now, which is the honest degradation.
 */

import { create } from "zustand";
import { diff } from "fast-myers-diff";
import { EXACT_DIFF_MAX_LINES, toLines, type DiffStat } from "./diff-stat";

export type DiffLineKind = " " | "+" | "-";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line in the old text; absent on an addition */
  oldLine?: number;
  /** 1-based line in the new text; absent on a removal */
  newLine?: number;
}

export interface Hunk {
  /** 1-based first old line this hunk covers */
  oldStart: number;
  /** 1-based first new line this hunk covers */
  newStart: number;
  /**
   * Unchanged lines skipped between the previous hunk and this one, so the panel
   * can offer "⋯ expand 14 lines ⋯" without recomputing anything.
   */
  gap: number;
  lines: DiffLine[];
}

/** Everything the inspector needs about one edit, minus where it came from. */
export interface DiffBody extends DiffStat {
  hunks: Hunk[];
  /** hunks were cut to stay inside the render budget */
  truncated?: boolean;
}

export interface FileDiff extends DiffBody {
  path: string;
  at: number;
  /**
   * The conversation whose turn produced this edit. Absent on entries recorded
   * before task attribution existed (and in unit tests that only exercise the
   * store) — the turn roll-up treats those as unattributed and leaves them out
   * rather than crediting them to whichever task is focused.
   */
  taskId?: string;
}

/** Unchanged lines kept on each side of a change — the unified-diff default. */
const CONTEXT = 3;
/**
 * Diff lines kept per edit. A rewrite of a 4k-line file is not something anyone
 * reads top to bottom in a 400px column; past this the panel says so instead of
 * pretending, and the editor is one click away for the full picture.
 */
const MAX_LINES = 400;
/**
 * Diffs retained, most recent first. diff-stat keeps every stat forever because
 * a stat is three numbers; a hunk list is not, so this one evicts. 200 covers
 * far more scrollback than anyone reviews by hand.
 */
const MAX_DIFFS = 200;

interface Region {
  sx: number;
  ex: number;
  sy: number;
  ey: number;
}

/**
 * Change regions between two line arrays, shifted back into whole-file indices.
 *
 * Both mid-slices start at the same offset because the trimmed prefix is common
 * to old and new, so one `start` corrects all four coordinates.
 */
function regionsOf(a: string[], b: string[], start: number): Region[] {
  const out: Region[] = [];
  for (const [sx, ex, sy, ey] of diff(a, b)) {
    out.push({ sx: sx + start, ex: ex + start, sy: sy + start, ey: ey + start });
  }
  return out;
}

/**
 * Regions close enough to share context, grouped into one hunk each.
 *
 * Two changes separated by less than twice the context would otherwise emit
 * overlapping context blocks — the same unchanged lines printed twice with a
 * meaningless "expand 0 lines" between them.
 */
function group(regions: Region[]): Region[][] {
  const groups: Region[][] = [];
  for (const r of regions) {
    const current = groups[groups.length - 1];
    const prev = current?.[current.length - 1];
    if (prev && r.sx - prev.ex <= CONTEXT * 2) current.push(r);
    else groups.push([r]);
  }
  return groups;
}

/** One group of regions → one hunk, with its surrounding context. */
function emit(
  a: string[],
  b: string[],
  regions: Region[],
  prevOldEnd: number,
): Hunk {
  const first = regions[0];
  const last = regions[regions.length - 1];
  const oldFrom = Math.max(0, first.sx - CONTEXT);
  const oldTo = Math.min(a.length, last.ex + CONTEXT);
  // the leading context is unchanged, so it sits the same distance above the
  // first change on both sides
  const newFrom = first.sy - (first.sx - oldFrom);

  const lines: DiffLine[] = [];
  let ai = oldFrom;
  let bi = newFrom;
  for (const r of regions) {
    while (ai < r.sx) {
      lines.push({ kind: " ", text: a[ai], oldLine: ai + 1, newLine: bi + 1 });
      ai++;
      bi++;
    }
    // removals before additions: a replacement reads as the old line struck out
    // and the new one under it, which is the order a reviewer expects
    for (let i = r.sx; i < r.ex; i++) {
      lines.push({ kind: "-", text: a[i], oldLine: i + 1 });
    }
    for (let j = r.sy; j < r.ey; j++) {
      lines.push({ kind: "+", text: b[j], newLine: j + 1 });
    }
    ai = r.ex;
    bi = r.ey;
  }
  while (ai < oldTo) {
    lines.push({ kind: " ", text: a[ai], oldLine: ai + 1, newLine: bi + 1 });
    ai++;
    bi++;
  }

  return {
    oldStart: oldFrom + 1,
    newStart: newFrom + 1,
    gap: oldFrom - prevOldEnd,
    lines,
  };
}

/**
 * Unified hunks for one edit, plus the same +/- totals diff-stat would report.
 *
 * The totals describe the whole change even when the hunks are truncated: the
 * numbers are cheap and exact, and clipping them to the rendered window would
 * make the panel disagree with the badge on the row that opened it.
 */
export function buildDiff(oldText: string, newText: string): DiffBody {
  if (oldText === newText) return { hunks: [], added: 0, removed: 0 };

  const a = toLines(oldText);
  const b = toLines(newText);

  // the same prefix/suffix trim diff-stat does — it is what keeps an exact diff
  // affordable on a large file, and keeps both modules answering alike
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const midA = endA + 1 - start;
  const midB = endB + 1 - start;

  let regions: Region[];
  let added: number;
  let removed: number;
  let approx: true | undefined;

  if (midA > EXACT_DIFF_MAX_LINES || midB > EXACT_DIFF_MAX_LINES) {
    // past the cap the change is reported as one block replacement, exactly as
    // the badge reports it — and the budget below trims it to a readable window
    regions = [{ sx: start, ex: endA + 1, sy: start, ey: endB + 1 }];
    removed = midA;
    added = midB;
    approx = true;
  } else {
    regions = regionsOf(a.slice(start, endA + 1), b.slice(start, endB + 1), start);
    added = 0;
    removed = 0;
    for (const r of regions) {
      removed += r.ex - r.sx;
      added += r.ey - r.sy;
    }
  }

  return { ...budget(a, b, regions), added, removed, approx };
}

/**
 * Hunks for every group, stopped at the line budget.
 *
 * A single hunk that blows the whole budget on its own is cut rather than
 * dropped: half of a rewrite is worth reading, and an empty panel next to a
 * `+3200` badge would look like a bug.
 */
function budget(a: string[], b: string[], regions: Region[]): {
  hunks: Hunk[];
  truncated?: boolean;
} {
  const hunks: Hunk[] = [];
  let spent = 0;
  let prevOldEnd = 0;
  let truncated: true | undefined;

  for (const g of group(regions)) {
    if (spent >= MAX_LINES) {
      truncated = true;
      break;
    }
    const hunk = emit(a, b, g, prevOldEnd);
    if (spent + hunk.lines.length > MAX_LINES) {
      hunk.lines = hunk.lines.slice(0, MAX_LINES - spent);
      truncated = true;
    }
    spent += hunk.lines.length;
    prevOldEnd =
      hunk.oldStart - 1 + hunk.lines.filter((l) => l.oldLine !== undefined).length;
    hunks.push(hunk);
    if (truncated) break;
  }

  return truncated ? { hunks, truncated } : { hunks };
}

/**
 * Recover a renderable diff from an edit tool's standard unified patch.
 *
 * This is the fallback for the unavoidable start-event race: when a file was not
 * already cached, the asynchronous pre-edit read can finish after a very fast tool
 * has written it, making the disk "before" and "after" texts identical. Hash-line
 * tools include an exact `details.patch`, so the turn roll-up does not need to go
 * empty merely because that snapshot lost the race.
 */
export function diffBodyFromResult(result: unknown): DiffBody | undefined {
  const root =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : undefined;
  const details =
    typeof root?.details === "object" && root.details !== null
      ? (root.details as Record<string, unknown>)
      : undefined;
  const patch = typeof details?.patch === "string" ? details.patch : undefined;
  if (!patch) return undefined;

  const hunks: Hunk[] = [];
  let added = 0;
  let removed = 0;
  let shown = 0;
  let truncated = false;
  let previousOldEnd = 0;
  let current: {
    oldLine: number;
    newLine: number;
    oldCount: number;
    newCount: number;
    usedOld: number;
    usedNew: number;
    hunk?: Hunk;
  } | undefined;

  const finish = (): boolean => {
    if (!current) return true;
    const valid =
      current.usedOld === current.oldCount && current.usedNew === current.newCount;
    previousOldEnd = Math.max(previousOldEnd, current.oldLine - 1);
    current = undefined;
    return valid;
  };

  for (const rawLine of patch.replace(/\r\n/g, "\n").split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (header) {
      if (!finish()) return undefined;
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      const hunk: Hunk | undefined =
        shown < MAX_LINES
          ? {
              oldStart: Math.max(1, oldStart),
              newStart: Math.max(1, newStart),
              gap: Math.max(0, oldStart - 1 - previousOldEnd),
              lines: [],
            }
          : undefined;
      if (hunk) hunks.push(hunk);
      current = {
        oldLine: oldStart,
        newLine: newStart,
        oldCount,
        newCount,
        usedOld: 0,
        usedNew: 0,
        hunk,
      };
      continue;
    }

    if (!current) continue;
    if (rawLine === "\\ No newline at end of file") continue;
    const kind = rawLine[0];
    if (kind !== " " && kind !== "+" && kind !== "-") {
      // A complete hunk accounts for exactly the ranges declared in its header.
      // Anything else before that point means the payload is partial or malformed.
      if (!finish()) return undefined;
      continue;
    }

    const line: DiffLine = { kind, text: rawLine.slice(1) };
    if (kind === " ") {
      line.oldLine = current.oldLine++;
      line.newLine = current.newLine++;
      current.usedOld++;
      current.usedNew++;
    } else if (kind === "-") {
      line.oldLine = current.oldLine++;
      current.usedOld++;
      removed++;
    } else {
      line.newLine = current.newLine++;
      current.usedNew++;
      added++;
    }

    if (shown < MAX_LINES && current.hunk) {
      current.hunk.lines.push(line);
      shown++;
    } else {
      truncated = true;
    }

    if (current.usedOld > current.oldCount || current.usedNew > current.newCount) {
      return undefined;
    }
  }

  if (!finish() || added + removed === 0) return undefined;
  return { hunks, added, removed, ...(truncated ? { truncated: true } : {}) };
}

interface FileDiffStore {
  /** keyed by pi's toolCallId, like the stat store, so one map serves every task */
  diffs: Record<string, FileDiff>;
  /** insertion order, oldest first — the eviction queue */
  order: string[];
  record: (
    toolCallId: string,
    path: string,
    body: DiffBody,
    taskId?: string,
  ) => void;
}

export const useFileDiffs = create<FileDiffStore>((set) => ({
  diffs: {},
  order: [],
  record: (toolCallId, path, body, taskId) =>
    set((s) => {
      const diffs = {
        ...s.diffs,
        [toolCallId]: {
          ...body,
          path,
          at: Date.now(),
          ...(taskId !== undefined ? { taskId } : {}),
        },
      };
      // copied even when the id is already present: `shift()` below would
      // otherwise mutate the array still held in state
      const order = s.order.includes(toolCallId)
        ? [...s.order]
        : [...s.order, toolCallId];
      while (order.length > MAX_DIFFS) {
        const evicted = order.shift();
        if (evicted !== undefined && evicted !== toolCallId) delete diffs[evicted];
      }
      return { diffs, order };
    }),
}));

/** The diff behind one tool call, if it is still retained. */
export function useFileDiff(toolCallId: string): FileDiff | undefined {
  return useFileDiffs((s) => s.diffs[toolCallId]);
}

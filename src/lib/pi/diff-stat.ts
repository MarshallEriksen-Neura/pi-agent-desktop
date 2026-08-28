"use client";

/**
 * Line-level +/- accounting for the agent's file edits.
 *
 * The numbers are a by-product of work the bridge already does: to highlight
 * changed lines in the editor it snapshots a file before an edit tool runs and
 * re-reads it after (see agent-bridge). Both sides of the diff are therefore
 * already in hand — this module turns them into the `+12 −3` a transcript row
 * shows, and parks the result where that row can find it.
 *
 * Accuracy is the whole point. A prefix/suffix trim alone is exact for ONE
 * contiguous edit but wildly over-reports scattered ones (a three-line change
 * spread across a 400-line file reads as ±400), so the counts come from a real
 * Myers diff. Wrong numbers are worse than no numbers.
 */

import { create } from "zustand";
import { diff } from "fast-myers-diff";

export interface DiffStat {
  added: number;
  removed: number;
  /**
   * The changed region was too large to diff exactly, so the counts describe it
   * as one block replacement. Rendered with a `~` rather than passed off as exact.
   */
  approx?: boolean;
}

/**
 * A stat plus when it landed.
 *
 * The timestamp is what keeps the badge's count-up honest about being an
 * *arrival* animation. Transcript rows are virtualized, so a badge remounts every
 * time its row scrolls back into view; without a sense of recency it would replay
 * the count-up on every pass and turn a one-off flourish into a nervous tic.
 */
export interface RecordedDiffStat extends DiffStat {
  at: number;
}

/**
 * Myers is O(ND): fully-rewritten content costs ~55ms at this many lines and
 * ~500ms at 6k, which is UI-thread time. Past the cap we report the region as a
 * block instead — for the whole-file rewrite that gets you here, that is what it
 * is anyway.
 */
const EXACT_DIFF_MAX_LINES = 2000;

/**
 * Text → lines, the way a diff tool counts them: a file ending in a newline has
 * N lines, not N plus an empty one, and empty text has none. Skipping this is
 * how a brand-new file ends up reporting a phantom `−1`.
 */
function toLines(text: string): string[] {
  if (text.length === 0) return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

export function diffStat(oldText: string, newText: string): DiffStat {
  if (oldText === newText) return { added: 0, removed: 0 };

  const a = toLines(oldText);
  const b = toLines(newText);

  // Trim the common head and tail first. This is what makes the exact diff
  // affordable at all: a one-line edit in a 50k-line file collapses to a 1×1
  // problem, and the cap below is then reached only by genuine rewrites.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length > EXACT_DIFF_MAX_LINES || midB.length > EXACT_DIFF_MAX_LINES) {
    return { added: midB.length, removed: midA.length, approx: true };
  }

  let added = 0;
  let removed = 0;
  for (const [sx, ex, sy, ey] of diff(midA, midB)) {
    removed += ex - sx;
    added += ey - sy;
  }
  return { added, removed };
}

interface DiffStatStore {
  /**
   * Keyed by pi's toolCallId, which is unique across tasks, so one store serves
   * every conversation. In-memory only: a transcript restored from history has
   * no snapshot to diff against, and those rows simply render without a badge.
   *
   * Deliberately uncapped. An entry is two numbers and a timestamp, and evicting
   * old ones would silently strip badges off rows the user can still scroll to.
   */
  stats: Record<string, RecordedDiffStat>;
  record: (toolCallId: string, stat: DiffStat) => void;
}

export const useDiffStats = create<DiffStatStore>((set) => ({
  stats: {},
  record: (toolCallId, stat) =>
    set((s) => ({
      stats: { ...s.stats, [toolCallId]: { ...stat, at: Date.now() } },
    })),
}));

/** The +/- accounting for one tool call, once it has landed. */
export function useToolDiffStat(toolCallId: string): RecordedDiffStat | undefined {
  return useDiffStats((s) => s.stats[toolCallId]);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** One before/after text pair an edit call spells out in its arguments. */
interface Hunk {
  from: string;
  to: string;
}

function argHunks(args: Record<string, unknown>): Hunk[] | undefined {
  const from = str(args.old_str) ?? str(args.oldText) ?? str(args.old_string);
  const to = str(args.new_str) ?? str(args.newText) ?? str(args.new_string);
  if (from !== undefined && to !== undefined) return [{ from, to }];

  if (Array.isArray(args.edits)) {
    const hunks: Hunk[] = [];
    for (const raw of args.edits) {
      const e = raw as Record<string, unknown> | null;
      const f = str(e?.old_str) ?? str(e?.oldText) ?? str(e?.old_string);
      const t = str(e?.new_str) ?? str(e?.newText) ?? str(e?.new_string);
      // one unreadable entry makes the total wrong, so report nothing rather
      // than a count that silently omits a hunk
      if (f === undefined || t === undefined) return undefined;
      hunks.push({ from: f, to: t });
    }
    if (hunks.length > 0) return hunks;
  }
  return undefined;
}

/** Read exact line counts reported by an edit tool result. */
export function diffStatFromResult(result: unknown): DiffStat | undefined {
  const root = typeof result === "object" && result !== null
    ? (result as Record<string, unknown>)
    : undefined;
  const details = typeof root?.details === "object" && root.details !== null
    ? (root.details as Record<string, unknown>)
    : undefined;
  const metrics = typeof details?.metrics === "object" && details.metrics !== null
    ? (details.metrics as Record<string, unknown>)
    : undefined;

  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
      ? value
      : undefined;
  const added = count(metrics?.added_lines ?? metrics?.addedLines);
  const removed = count(metrics?.removed_lines ?? metrics?.removedLines);

  // Require the pair. Treating a missing side as zero would turn a partial
  // third-party payload into a confident but potentially false count.
  if (added === undefined || removed === undefined) return undefined;
  return { added, removed };
}

/**
 * The stat implied by an edit tool's own arguments.
 * Reading the file back off disk is the more truthful source — it reports what
 * landed rather than what was asked for — but it needs a filesystem read to
 * succeed, and that read is the fragile part of the chain: it can lose its race
 * with the tool, be skipped in a mocked backend, or fail on a path the workspace
 * store resolved differently than the agent did. The arguments always arrive with
 * the call, so they cover every one of those cases.
 *
 * Both sources are exact, not estimates. A targeted replacement carries its own
 * before and after text, and a whole-file write carries the whole after text —
 * which is a complete diff as long as the before text is known (empty, for a file
 * the tool created). When it isn't, this returns undefined and the row stays
 * plain: the additions would be right and the removals invented.
 *
 * Hash-line `replace` is deliberately not handled from arguments. Its
 * `changes[]` entries give the new lines but identify the old ones only by
 * content hash (`hash_range_inclusive`), so the removed count is unknowable.
 * `diffStatFromResult()` consumes that tool's exact execution metrics instead;
 * disk read-back remains the fallback for editors that return no metrics.
 */
export function diffStatFromArgs(
  args: Record<string, unknown>,
  oldText: string | undefined,
): DiffStat | undefined {
  const hunks = argHunks(args);
  if (hunks) {
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      const s = diffStat(h.from, h.to);
      added += s.added;
      removed += s.removed;
    }
    return { added, removed };
  }

  const content =
    str(args.content) ?? str(args.contents) ?? str(args.text) ?? str(args.file_text);
  if (content !== undefined && oldText !== undefined) return diffStat(oldText, content);
  return undefined;
}

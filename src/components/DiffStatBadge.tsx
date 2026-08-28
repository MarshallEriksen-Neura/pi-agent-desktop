"use client";

/**
 * DiffStatBadge — the `▪▪▪▫▫ +12 −3` that lands on an edit row when the agent
 * finishes writing a file.
 *
 * The motion is one beat, not a loop: the row appears while the tool runs (icon
 * breathing), and the counts spring up from zero the moment the write lands. That
 * arrival is the whole effect — an edit row that used to sit inert now resolves,
 * so a turn reads as work completing rather than as a list of filenames.
 */

import { useEffect, useState } from "react";
import { animate, motion, useReducedMotion } from "motion/react";
import { useT } from "@/lib/i18n";
import type { DiffStat, RecordedDiffStat } from "@/lib/pi/diff-stat";

const BAR_SEGMENTS = 5;
const COUNT_DURATION = 0.45;
/** the removed count trails the added one, so the pair ticks instead of blinking */
const REMOVED_DELAY = 0.07;
/** fast out, long soft landing — the digits decelerate into place */
const COUNT_EASE = [0.16, 1, 0.3, 1] as const;
/**
 * How long after the write a badge still counts as *arriving*. Past it the badge
 * renders finished, which is what a row scrolled back into view should look like —
 * the animation belongs to the moment the edit landed, not to every glance at it.
 */
const ARRIVAL_WINDOW_MS = 1500;

/** How many of the bar's segments read as additions. */
function addedSegments({ added, removed }: DiffStat): number {
  const total = added + removed;
  if (total === 0) return 0;
  const raw = Math.round((added / total) * BAR_SEGMENTS);
  // a side that exists must own at least one segment, or the bar lies about
  // whether anything was added / removed at all
  if (added > 0 && raw === 0) return 1;
  if (removed > 0 && raw === BAR_SEGMENTS) return BAR_SEGMENTS - 1;
  return raw;
}

/**
 * Counts from 0 up to `target` once, on arrival.
 *
 * This re-renders per frame, which is the right trade for a leaf that draws two
 * numbers: it keeps the value in plain React state instead of threading a
 * MotionValue through the row's `trailing` slot.
 */
function useCountUp(target: number, delay: number, animated: boolean): number {
  const [shown, setShown] = useState(animated ? 0 : target);

  useEffect(() => {
    if (!animated) {
      setShown(target);
      return;
    }
    const controls = animate(0, target, {
      duration: COUNT_DURATION,
      delay,
      ease: COUNT_EASE,
      onUpdate: (v) => setShown(Math.round(v)),
    });
    return () => controls.stop();
  }, [target, delay, animated]);

  return shown;
}

export function DiffStatBadge({ stat }: { stat: RecordedDiffStat }) {
  const t = useT();
  const reduced = useReducedMotion();
  const animated = !reduced && Date.now() - stat.at < ARRIVAL_WINDOW_MS;
  const added = useCountUp(stat.added, 0, animated);
  const removed = useCountUp(stat.removed, REMOVED_DELAY, animated);
  const greens = addedSegments(stat);

  const label = t(stat.approx ? "diff.statApprox" : "diff.stat", {
    added: stat.added,
    removed: stat.removed,
  });

  return (
    <motion.span
      role="img"
      aria-label={label}
      title={label}
      initial={animated ? { opacity: 0, x: 3 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 460, damping: 34 }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        // digits must not reflow while they count
        fontVariantNumeric: "tabular-nums",
        fontWeight: 600,
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 1.5,
          // texture, not a second focal point — the numbers carry the meaning
          opacity: 0.8,
        }}
      >
        {Array.from({ length: BAR_SEGMENTS }).map((_, i) => (
          <motion.span
            key={i}
            initial={animated ? { opacity: 0, scaleY: 0.35 } : false}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={{
              type: "spring",
              stiffness: 520,
              damping: 30,
              delay: animated ? i * 0.035 : 0,
            }}
            style={{
              width: 3,
              height: 8,
              borderRadius: 1,
              background: i < greens ? "var(--success)" : "var(--danger)",
            }}
          />
        ))}
      </span>
      {stat.approx && <span style={{ color: "var(--text-tertiary)" }}>~</span>}
      {stat.added > 0 && <span style={{ color: "var(--success)" }}>+{added}</span>}
      {/* U+2212, so the minus sits at the same optical weight as the plus */}
      {stat.removed > 0 && <span style={{ color: "var(--danger)" }}>−{removed}</span>}
    </motion.span>
  );
}

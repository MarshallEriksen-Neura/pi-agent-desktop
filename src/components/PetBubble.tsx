"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { PetState } from "@/lib/pet/types";

/**
 * The pet's speech bubble — 宣纸 (rice paper) under an iOS bubble's geometry.
 *
 * Two design languages, one object:
 *
 * - **iOS** supplies the *structure*: continuous-curvature corners (the arms of
 *   each corner run further along the edge than a circular arc would, with the
 *   Bézier handles pulled toward the corner — that is what kills the visible
 *   curvature "jump" of a plain `border-radius`), a tail bound to the source of
 *   the message, layered elevation, and a spring that starts at the pet's head.
 * - **水墨** supplies the *material*: warm paper with visible fibre, ink that
 *   soaks outward instead of casting a hard shadow, an outline that feathers the
 *   way a brush edge does on 生宣 rather than running geometrically straight,
 *   and a 朱砂 seal — stamped only when there is something to acknowledge.
 *
 * The outline, paper and tail are a *single* path, so the tail is part of the
 * same brush stroke instead of a triangle glued to a rounded rect.
 */

/** Tail footprint — the stroke lifts off the paper toward the pet's head. */
const TAIL_W = 19;
const TAIL_H = 10;
/** Corner radius before the continuous-curvature arms extend it. */
const CORNER = 13;

/**
 * State → seal ink. The seal is the traditional 落款印: it appears when the
 * work has something to report, and stays absent while the pet is idle (留白).
 */
const SEAL_INK: Record<PetState, string | null> = {
  idle: null,
  running: "var(--pet-seal-running)",
  waiting: "var(--pet-seal-waiting)",
  review: "var(--pet-seal-review)",
  failed: "var(--pet-seal-failed)",
};

/** Deterministic ±0.5 noise — same size in, same paper out, so nothing twitches
 *  between renders while two differently sized bubbles still differ. */
function wobbler(seed: number) {
  let s = Math.abs(Math.round(seed)) % 2147483647;
  if (s <= 0) s += 2147483646;
  return (amplitude: number) => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647 - 0.5) * amplitude;
  };
}

/**
 * Outline of paper + tail as one closed path, traversed clockwise from the top
 * edge.  `w`/`h` are the text box; the tail hangs below `h`.
 *
 * Every straight edge is a quadratic that bows by a fraction of a pixel and
 * every corner arm varies slightly: a brush line wanders, a `border-radius`
 * never does. Doing this in the *geometry* keeps the line crisp — an SVG
 * displacement filter would smear a 1px stroke into a torn, faded edge.
 */
function bubblePath(w: number, h: number): string {
  const wob = wobbler(w * 31 + h * 7);
  // Keep the corners from eating the tail on a very short bubble.
  const maxArm = Math.max(4, Math.min(w / 2 - TAIL_W / 2 - 2, h / 2));
  const base = Math.min(CORNER * 1.32, maxArm);
  const arm = () => Math.max(3, base + wob(1.6));
  const aTL = arm();
  const aTR = arm();
  const aBR = arm();
  const aBL = arm();
  // Handles pulled toward the corner — that plus the long arms above is what
  // gives iOS continuous curvature instead of a visible arc.
  const kTL = aTL * 0.34;
  const kTR = aTR * 0.34;
  const kBR = aBR * 0.34;
  const kBL = aBL * 0.34;
  const bowTop = wob(1.4);
  const bowRight = wob(1.4);
  const bowLeft = wob(1.4);
  const bowBottomR = wob(1.1);
  const bowBottomL = wob(1.1);
  const cx = w / 2;
  const tailIn = cx + TAIL_W / 2;
  const tailOut = cx - TAIL_W / 2;
  const tipX = cx - 3.5 + wob(1);
  const tipY = h + TAIL_H + wob(0.8);
  const mid = (p: number, q: number) => (p + q) / 2;

  return [
    `M ${aTL} 0`,
    `Q ${mid(aTL, w - aTR)} ${-bowTop * 2} ${w - aTR} 0`,
    `C ${w - kTR} 0 ${w} ${kTR} ${w} ${aTR}`,
    `Q ${w + bowRight * 2} ${mid(aTR, h - aBR)} ${w} ${h - aBR}`,
    `C ${w} ${h - kBR} ${w - kBR} ${h} ${w - aBR} ${h}`,
    `Q ${mid(tailIn, w - aBR)} ${h + bowBottomR * 2} ${tailIn} ${h}`,
    // Asymmetric on purpose: the stroke flows out of the bottom edge on one
    // side and is lifted off in a point on the other — a 点, not an isosceles
    // triangle bolted to a rounded rect.
    `C ${tailIn - 6.5} ${h + 0.4} ${tipX + 3.2} ${tipY - 4.2} ${tipX} ${tipY}`,
    `C ${tipX - 2.2} ${tipY - 1.4} ${tailOut + 2.2} ${h + 3.6} ${tailOut} ${h}`,
    `Q ${mid(aBL, tailOut)} ${h + bowBottomL * 2} ${aBL} ${h}`,
    `C ${kBL} ${h} 0 ${h - kBL} 0 ${h - aBL}`,
    `Q ${-bowLeft * 2} ${mid(aTL, h - aBL)} 0 ${aTL}`,
    `C 0 ${kTL} ${kTL} 0 ${aTL} 0`,
    "Z",
  ].join(" ");
}

interface PetBubbleProps {
  text: string;
  state: PetState;
}

export function PetBubble({ text, state }: PetBubbleProps) {
  // SVG defs are referenced by id, so they have to be unique per instance —
  // useId's colons are not safe inside url(#…), hence the strip.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const reduce = useReducedMotion();

  // The path needs real pixel dimensions (stretching one viewBox would distort
  // the corners and the tail), so the text box is measured and drawn around.
  // useLayoutEffect + the initial measure keep it to a single paint.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      // offsetWidth/Height ignore CSS transforms (e.g. motion's scale animation),
      // so the SVG path is always drawn at the true layout size.
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setSize((prev) =>
        Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5
          ? prev
          : { w, h }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  const seal = SEAL_INK[state];
  const d = size.w > 0 ? bubblePath(size.w, size.h) : "";

  return (
    <motion.div
      className="pet-bubble"
      // Ink landing on paper: it arrives blurred and spreads into focus, and it
      // grows from the tail (the pet's head) the way an iOS popover grows from
      // whatever spawned it.
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.86, y: 6, filter: "blur(7px)" }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 2, filter: "blur(5px)" }}
      transition={
        reduce
          ? { duration: 0.12 }
          : {
              type: "spring",
              stiffness: 420,
              damping: 26,
              mass: 0.7,
              // Diffusion is a wash, not a bounce — tween it separately.
              filter: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.18 },
            }
      }
    >
      {d && (
        <svg
          className="pet-bubble__paper"
          width={size.w}
          height={size.h + TAIL_H}
          viewBox={`0 0 ${size.w} ${size.h + TAIL_H}`}
          aria-hidden
        >
          <defs>
            {/* 宣纸: warm at the top where the light falls, cooler at the fold */}
            <linearGradient id={`${uid}-paper`} x1="0" y1="0" x2="0.3" y2="1">
              <stop offset="0%" stopColor="var(--pet-paper-top)" />
              <stop offset="100%" stopColor="var(--pet-paper-bottom)" />
            </linearGradient>
            {/* ink pooling in one corner — depth without a second surface */}
            <radialGradient id={`${uid}-pool`} cx="0.1" cy="0.02" r="0.95">
              <stop offset="0%" stopColor="var(--pet-ink)" stopOpacity="0.16" />
              <stop offset="60%" stopColor="var(--pet-ink)" stopOpacity="0" />
            </radialGradient>
            {/* paper fibre */}
            <filter id={`${uid}-fibre`} x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <pattern id={`${uid}-grain`} width="64" height="64" patternUnits="userSpaceOnUse">
              <rect width="64" height="64" filter={`url(#${uid}-fibre)`} />
            </pattern>
            {/* keeps the damp halo inside the sheet instead of ringing it */}
            <clipPath id={`${uid}-clip`}>
              <path d={d} />
            </clipPath>
          </defs>

          {/* Elevation, ink-wash style: a soft cast below plus ink bleeding
              through the sheet, instead of an iOS box-shadow. */}
          <path d={d} className="pet-bubble__cast" />
          <path d={d} className="pet-bubble__bleed" />

          <path d={d} fill={`url(#${uid}-paper)`} />
          <path d={d} fill={`url(#${uid}-pool)`} />
          <path d={d} fill={`url(#${uid}-grain)`} className="pet-bubble__grain" />
          <path d={d} className="pet-bubble__halo" clipPath={`url(#${uid}-clip)`} />
          {/* one stretch of the outline carries more pressure, the way a brush
              loads and releases; pathLength=100 makes the dash a percentage */}
          <path d={d} className="pet-bubble__stress" pathLength={100} />
          <path d={d} className="pet-bubble__line" />
        </svg>
      )}

      <div ref={contentRef} className="pet-bubble__content">
        {seal && (
          <span
            className={`pet-bubble__seal${state === "running" ? " is-live" : ""}`}
            style={{ background: seal }}
            aria-hidden
          />
        )}
        <span className="pet-bubble__label" role="status">
          {text}
        </span>
      </div>
    </motion.div>
  );
}

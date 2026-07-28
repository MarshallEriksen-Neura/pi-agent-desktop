"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";

/**
 * PiLoader — a "Pi is thinking" loader that marries the math-curve-loaders
 * aesthetic (a comet of particles flowing along a parametric curve, with a
 * breathing pulse) to Pi's own brand: the particles trace the hand-drawn π
 * glyph instead of a rose/hypotrochoid. Pure SVG + requestAnimationFrame,
 * no dependencies, theme-aware (reads --agent-thinking / --accent via CSS vars
 * so it adapts to light & dark automatically).
 *
 * Each stroke of the π carries its own flowing comet; the three comets are
 * phase-offset so the glyph shimmers continuously rather than drawing once.
 */

// The π glyph, lifted from PiMark (viewBox 0 0 1024 1024) so the loader shares
// one source of truth for the brand shape.
const STROKES = [
  "M236 414 C284 352 372 356 512 354 C640 352 724 350 790 362", // top bar
  "M412 362 C402 470 392 572 368 662 C360 692 348 706 330 712", // left leg
  "M636 360 C630 470 628 580 646 654 C658 700 700 718 736 690 C748 680 754 668 756 654", // right leg
];

const VIEW = 1024;
const PARTICLES = 16; // comet length per stroke
const TRAIL_SPAN = 0.55; // fraction of a stroke the comet covers
const DURATION_MS = 2200; // time for a comet to travel one stroke
const BREATH_MS = 4200; // breathing-pulse period

const spacing = TRAIL_SPAN / (PARTICLES - 1);

export function PiLoader({
  size = 84,
  style,
}: {
  size?: number;
  style?: React.CSSProperties;
}) {
  const uid = useId().replace(/[:]/g, "");
  const gradId = `piLoaderGrad-${uid}`;

  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const groupRef = useRef<SVGGElement | null>(null);
  const particleRefs = useRef<SVGCircleElement[][]>(STROKES.map(() => []));
  const lengths = useRef<number[]>([]);

  useLayoutEffect(() => {
    lengths.current = pathRefs.current.map((p) => (p ? p.getTotalLength() : 0));
  }, []);

  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Reduced motion: lay particles out statically along each stroke so the
    // π reads as a calm dotted mark (the caption conveys the "loading" state).
    if (prefersReduced) {
      STROKES.forEach((_, s) => {
        const len = lengths.current[s];
        const path = pathRefs.current[s];
        if (!len || !path) return;
        for (let k = 0; k < PARTICLES; k++) {
          const node = particleRefs.current[s]?.[k];
          if (!node) continue;
          const pt = path.getPointAtLength((k / (PARTICLES - 1)) * len);
          node.setAttribute("cx", String(pt.x));
          node.setAttribute("cy", String(pt.y));
          node.setAttribute("r", "18");
          node.setAttribute("opacity", (0.18 + 0.5 * (1 - k / (PARTICLES - 1))).toFixed(3));
        }
      });
      return;
    }

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const time = now - start;
      const p = (time % DURATION_MS) / DURATION_MS;

      // Breathing: a gentle scale so the glyph feels alive without spinning
      // the π upside-down (it must stay legible as the brand mark).
      const breath = 0.5 + 0.5 * Math.sin((time / BREATH_MS) * Math.PI * 2);
      const scale = 0.97 + breath * 0.045;
      if (groupRef.current) {
        groupRef.current.setAttribute(
          "transform",
          `translate(${VIEW / 2} ${VIEW / 2}) scale(${scale}) translate(${-VIEW / 2} ${-VIEW / 2})`
        );
      }

      STROKES.forEach((_, s) => {
        const len = lengths.current[s];
        const path = pathRefs.current[s];
        if (!len || !path) return;
        const head = (p + s * 0.18) % 1; // phase-offset comet per stroke
        // Fade the comet in/out at the stroke ends so the wrap is seamless.
        const edgeFade = Math.sin(Math.max(0, Math.min(1, head)) * Math.PI);
        for (let k = 0; k < PARTICLES; k++) {
          const node = particleRefs.current[s]?.[k];
          if (!node) continue;
          const pos = head - k * spacing;
          if (pos < 0) {
            node.setAttribute("opacity", "0");
            continue;
          }
          const pt = path.getPointAtLength(pos * len);
          const fade = Math.pow(1 - k / (PARTICLES - 1), 0.6); // bright head → faint tail
          node.setAttribute("cx", String(pt.x));
          node.setAttribute("cy", String(pt.y));
          node.setAttribute("r", String(16 + fade * 30));
          node.setAttribute("opacity", (edgeFade * (0.12 + fade * 0.88)).toFixed(3));
        }
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      role="img"
      aria-label="Pi"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--agent-thinking)" }} />
          <stop offset="100%" style={{ stopColor: "var(--accent)" }} />
        </linearGradient>
      </defs>

      <g ref={groupRef}>
        {STROKES.map((d, s) => (
          <g key={s}>
            {/* faint track — the full π, dimmed, so the shape is always legible */}
            <path
              d={d}
              fill="none"
              style={{ stroke: "var(--accent)", strokeOpacity: 0.12 }}
              strokeWidth={18}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* invisible geometry path used only for getPointAtLength */}
            <path
              ref={(el) => {
                pathRefs.current[s] = el;
              }}
              d={d}
              fill="none"
              stroke="none"
            />
            {/* flowing comet particles */}
            {Array.from({ length: PARTICLES }).map((_, k) => (
              <circle
                key={k}
                ref={(el) => {
                  if (el) particleRefs.current[s][k] = el;
                }}
                r={16}
                style={{ fill: `url(#${gradId})` }}
                opacity={0}
              />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}

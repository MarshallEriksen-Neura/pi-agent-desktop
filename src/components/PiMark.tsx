import type { CSSProperties } from "react";

/** Shared π glyph paths — single source of truth for the brand mark. */
const GLYPH = (
  <g
    fill="none"
    stroke="currentColor"
    strokeWidth={84}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M236 414 C284 352 372 356 512 354 C640 352 724 350 790 362" />
    <path d="M412 362 C402 470 392 572 368 662 C360 692 348 706 330 712" />
    <path d="M636 360 C630 470 628 580 646 654 C658 700 700 718 736 690 C748 680 754 668 756 654" />
  </g>
);

/**
 * Global brand mark: the hand-drawn π.
 *
 * - Default: monochrome glyph inheriting `currentColor` — for nav rails,
 *   status bars, and any inline small-size use.
 * - `withBackground`: warm-paper rounded tile matching the app icon.
 */
export function PiMark({
  size = 20,
  withBackground = false,
  style,
  title = "Pi",
}: {
  size?: number;
  withBackground?: boolean;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label={title}
      style={style}
    >
      {withBackground && (
        <rect width={1024} height={1024} rx={230} fill="#eadfc9" />
      )}
      <g color={withBackground ? "#2b241d" : undefined}>{GLYPH}</g>
    </svg>
  );
}

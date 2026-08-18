"use client";

/**
 * Shuimò (水墨) ink-wash design tokens for the MCP page.
 * Fixed palette — the ink-wash canvas stays warm rice paper in any theme.
 * See .omx/plans/design-mcp-integration.md + Stitch design (Shuimo Ink Wash).
 */

export const INK = {
  /** primary text — deep warm black */
  ink900: "#262420",
  /** secondary text */
  ink700: "#3A3630",
  /** tertiary text / subtitles */
  ink500: "#6B655C",
  /** disabled / placeholders */
  ink300: "#9B948A",
  /** hairlines / faint glyphs */
  ink100: "#C9C2B7",
} as const;

export const PAPER = {
  /** page canvas gradient top */
  top: "#F7F4EC",
  /** page canvas gradient bottom */
  bottom: "#EFE9DD",
  /** cards & elevated surfaces */
  elevated: "#FBF9F3",
  /** sunken surfaces — banners, input fills, icon tiles */
  sunken: "#E9E3D5",
} as const;

export const SEAL = {
  /** the ONLY saturated accent — used like a stamp */
  red: "#B23A2F",
  hover: "#962D24",
  /** seal-red at 10% — selected fills, pill button fills */
  muted: "rgba(178, 58, 47, 0.10)",
  /** text on seal red */
  onSeal: "#F7F4EC",
} as const;

/** 0.5px warm hairline (ink at 14% opacity) */
export const HAIRLINE = "rgba(58, 54, 48, 0.14)";

/** modal backdrop — warm ink at 25% */
export const BACKDROP = "rgba(38, 36, 32, 0.25)";

/** serif voice for titles (EB Garamond family — project ships Cormorant Garamond) */
export const SERIF = "var(--font-cormorant), Georgia, 'Noto Serif SC', 'Songti SC', 'STSong', serif";

/** sans voice for all UI chrome */
export const SANS = "var(--font-ui)";

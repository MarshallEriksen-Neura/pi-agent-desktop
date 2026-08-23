"use client";

/**
 * Shuimò (水墨) ink-wash design tokens for the MCP page.
 *
 * Every value forwards to a CSS variable so the palette follows the app theme:
 * 宣纸 (warm rice paper, dark ink) in light, 墨夜 (night paper, paper-white ink) in
 * dark. The literals live in globals.css under `:root` / `:root[data-theme=dark]`
 * — see the "MCP page — Shuimò ink wash" block there for the two papers and why
 * the seal splits into ink and fill.
 *
 * These are strings destined for inline styles, so `var()` is safe. Keep them out
 * of Motion `animate` props and SVG presentation attributes (`fill="…"`), neither
 * of which resolves custom properties.
 *
 * See .omx/plans/design-mcp-integration.md + Stitch design (Shuimo Ink Wash).
 */

export const INK = {
  /** primary text */
  ink900: "var(--mcp-ink-900)",
  /** secondary text */
  ink700: "var(--mcp-ink-700)",
  /** tertiary text / subtitles */
  ink500: "var(--mcp-ink-500)",
  /** disabled / placeholders */
  ink300: "var(--mcp-ink-300)",
  /** hairlines / faint glyphs / switch-off track */
  ink100: "var(--mcp-ink-100)",
} as const;

export const PAPER = {
  /** page canvas gradient top */
  top: "var(--mcp-paper-top)",
  /** page canvas gradient bottom */
  bottom: "var(--mcp-paper-bottom)",
  /** cards & elevated surfaces */
  elevated: "var(--mcp-paper-elevated)",
  /** sunken surfaces — banners, input fills, icon tiles */
  sunken: "var(--mcp-paper-sunken)",
} as const;

export const SEAL = {
  /**
   * Seal red as *ink* — error text, alert icons, the caret. Brightens in dark so
   * it stays legible against night paper.
   */
  red: "var(--mcp-seal)",
  /**
   * Seal red as a *ground* — primary buttons, which carry `onSeal` text. Stays
   * deep in both themes; a fill bright enough to read as ink on dark would drop
   * that label below 4.5:1.
   */
  fill: "var(--mcp-seal-fill)",
  /** hover for `fill` — darker on paper, lighter on night */
  fillHover: "var(--mcp-seal-fill-hover)",
  /** seal red at low alpha — selected fills, pill button fills */
  muted: "var(--mcp-seal-muted)",
  /** text on a seal-red ground — paper white in both themes (a stamped glyph) */
  onSeal: "var(--mcp-seal-on)",
} as const;

/** 0.5px warm hairline */
export const HAIRLINE = "var(--mcp-hairline)";

/** modal backdrop */
export const BACKDROP = "var(--mcp-backdrop)";

/** drop shadow under the ink-switch knob */
export const KNOB_SHADOW = "var(--mcp-knob-shadow)";

/** aged-gold caution note — the one warm signal that is not the seal */
export const AMBER = "var(--mcp-amber)";

/** serif voice for titles (EB Garamond family — project ships Cormorant Garamond) */
export const SERIF = "var(--font-cormorant), Georgia, 'Noto Serif SC', 'Songti SC', 'STSong', serif";

/** sans voice for all UI chrome */
export const SANS = "var(--font-ui)";

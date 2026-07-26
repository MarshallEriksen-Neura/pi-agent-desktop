"use client";

import { create } from "zustand";

/* ============================================================================
   User-customizable appearance — app-local (not part of pi's settings.json).
   Overrides the design tokens in globals.css by writing inline CSS custom
   properties onto <html>, so a user choice wins in BOTH light & dark themes.
   ========================================================================== */

const STORAGE_KEY = "pi-desktop.appearance";

export interface Appearance {
  /** accent / tint color (hex) — null = theme default (iOS blue) */
  accent: string | null;
  /** base background color (hex) — null = theme default */
  background: string | null;
  /** primary text color (hex) — null = theme default */
  textColor: string | null;
  /** UI text scale — 1 = 100% */
  fontScale: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  accent: null,
  background: null,
  textColor: null,
  fontScale: 1,
};

/* iOS system palette for the accent swatches */
export const ACCENT_PRESETS = [
  "#007aff", // blue
  "#5856d6", // indigo
  "#af52de", // purple
  "#ff2d55", // pink
  "#ff3b30", // red
  "#ff9500", // orange
  "#34c759", // green
  "#30b0c7", // teal
] as const;

/* backgrounds — dark tints first (default theme is dark), then light papers */
export const BG_PRESETS = [
  "#1c1c1e", // graphite
  "#0b1220", // midnight blue
  "#101a14", // deep green
  "#181022", // plum
  "#17110b", // warm brown
  "#ffffff", // white
  "#faf6ef", // paper
  "#eef3f8", // ice
] as const;

/* text tints — the store applies opacity tiers on top of these */
export const TEXT_PRESETS = [
  "#ffffff", // pure white
  "#e6e1d8", // warm ivory
  "#ffd9a0", // amber
  "#a8d8ff", // ice blue
  "#b9f0c9", // mint
  "#000000", // pure black (for light backgrounds)
] as const;

export const FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/* ── color math ─────────────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** blend `hex` toward `toward` by `amount` (0..1) */
function mix(hex: string, toward: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  return rgbToHex(
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount
  );
}

/** perceived luminance 0..1 */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/* ── applying overrides ─────────────────────────────────────────────────── */

/** every var we may override — cleared when the matching setting is default */
const ACCENT_VARS = [
  "--accent",
  "--accent-hover",
  "--accent-muted",
  "--focus-ring",
  "--primary", // Appica UI bridge
  "--ring",
];
const BG_VARS = [
  "--bg-base",
  "--bg-elevated",
  "--bg-sunken",
  "--bg-overlay",
  "--material-thin",
  "--material-regular",
  "--material-thick",
  "--background", // Appica UI bridge
  "--muted",
];
const TEXT_VARS = [
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--foreground", // Appica UI bridge
  "--muted-foreground",
];

function applyAppearance(a: Appearance) {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  const put = (k: string, v: string) => style.setProperty(k, v);
  const clear = (keys: string[]) => keys.forEach((k) => style.removeProperty(k));

  if (a.accent) {
    const dark = luminance(a.accent) < 0.5;
    put("--accent", a.accent);
    put("--accent-hover", mix(a.accent, dark ? "#ffffff" : "#000000", 0.12));
    put("--accent-muted", withAlpha(a.accent, 0.15));
    put("--focus-ring", withAlpha(a.accent, 0.4));
    put("--primary", a.accent);
    put("--ring", withAlpha(a.accent, 0.4));
  } else {
    clear(ACCENT_VARS);
  }

  if (a.background) {
    const dark = luminance(a.background) < 0.45;
    // dark surfaces elevate by getting lighter; light ones by getting grayer
    const elevated = mix(a.background, dark ? "#ffffff" : "#000000", dark ? 0.09 : 0.05);
    const sunken = mix(a.background, dark ? "#ffffff" : "#000000", dark ? 0.03 : 0.08);
    put("--bg-base", a.background);
    put("--bg-elevated", elevated);
    put("--bg-sunken", sunken);
    put("--bg-overlay", withAlpha(elevated, 0.72));
    put("--material-thin", withAlpha(elevated, 0.6));
    put("--material-regular", withAlpha(elevated, 0.72));
    put("--material-thick", withAlpha(elevated, 0.85));
    put("--background", a.background);
    put("--muted", elevated);
  } else {
    clear(BG_VARS);
  }

  if (a.textColor) {
    put("--text-primary", withAlpha(a.textColor, 0.95));
    put("--text-secondary", withAlpha(a.textColor, 0.58));
    put("--text-tertiary", withAlpha(a.textColor, 0.34));
    put("--foreground", withAlpha(a.textColor, 0.95));
    put("--muted-foreground", withAlpha(a.textColor, 0.58));
  } else {
    clear(TEXT_VARS);
  }

  // text/UI scale — zoom scales px-based type cleanly in the Tauri webview
  if (a.fontScale && a.fontScale !== 1) put("zoom", String(a.fontScale));
  else style.removeProperty("zoom");
}

/* ── store ──────────────────────────────────────────────────────────────── */

function persist(a: Appearance) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch {
    // storage unavailable (private mode) — keep the choice in-memory only
  }
}

interface AppearanceState extends Appearance {
  set: (patch: Partial<Appearance>) => void;
  reset: () => void;
  /** whether anything deviates from the defaults */
  customized: () => boolean;
  /** restore the saved appearance — call once on mount */
  init: () => void;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  ...DEFAULT_APPEARANCE,

  set: (patch) => {
    const { accent, background, textColor, fontScale } = { ...get(), ...patch };
    const next: Appearance = { accent, background, textColor, fontScale };
    persist(next);
    applyAppearance(next);
    set(next);
  },

  reset: () => {
    persist(DEFAULT_APPEARANCE);
    applyAppearance(DEFAULT_APPEARANCE);
    set(DEFAULT_APPEARANCE);
  },

  customized: () => {
    const s = get();
    return (
      s.accent !== null ||
      s.background !== null ||
      s.textColor !== null ||
      s.fontScale !== 1
    );
  },

  init: () => {
    let saved: Appearance | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Appearance>;
        saved = {
          accent: typeof parsed.accent === "string" ? parsed.accent : null,
          background:
            typeof parsed.background === "string" ? parsed.background : null,
          textColor:
            typeof parsed.textColor === "string" ? parsed.textColor : null,
          fontScale:
            typeof parsed.fontScale === "number" && parsed.fontScale > 0
              ? parsed.fontScale
              : 1,
        };
      }
    } catch {
      // corrupted or unavailable storage — fall back to defaults
    }
    if (saved) {
      applyAppearance(saved);
      set(saved);
    }
  },
}));

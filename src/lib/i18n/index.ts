"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { en } from "./en";
import { zh } from "./zh";

export type Locale = "en" | "zh";
export type MsgKey = keyof typeof en;
/** Accepts known keys (autocompleted) plus dynamic ones like `status.${s}`. */
export type TFunc = (
  key: MsgKey | (string & {}),
  params?: Record<string, string | number>
) => string;

const DICTS: Record<Locale, Record<string, string>> = { en, zh };
const STORAGE_KEY = "pi-desktop.locale";

function resolve(locale: Locale, key: string): string {
  const hit = DICTS[locale][key] ?? DICTS.en[key];
  if (hit !== undefined) return hit;
  // unknown dynamic key (e.g. an unexpected pi status) — fall back to the raw tail
  const dot = key.lastIndexOf(".");
  return dot >= 0 ? key.slice(dot + 1) : key;
}

export function makeT(locale: Locale): TFunc {
  return (key, params) => {
    let msg = resolve(locale, key);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        msg = msg.split(`{${k}}`).join(String(v));
      }
    }
    return msg;
  };
}

function applyHtmlLang(locale: Locale) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }
}

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  toggleLocale: () => void;
  /** Restore the saved locale (or detect from the system) — call once on mount. */
  initLocale: () => void;
}

export const useI18n = create<I18nState>((set, get) => ({
  locale: "en",
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // storage unavailable (private mode) — keep the choice in-memory only
    }
    applyHtmlLang(locale);
    set({ locale });
  },
  toggleLocale: () => get().setLocale(get().locale === "zh" ? "en" : "zh"),
  initLocale: () => {
    let locale: Locale | null = null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "en" || saved === "zh") locale = saved;
    } catch {
      // ignore — fall through to system detection
    }
    if (!locale && typeof navigator !== "undefined") {
      locale = navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    if (locale) {
      applyHtmlLang(locale);
      set({ locale });
    }
  },
}));

/** Reactive translator — the component re-renders when the locale changes. */
export function useT(): TFunc {
  const locale = useI18n((s) => s.locale);
  return useMemo(() => makeT(locale), [locale]);
}

/** Non-reactive translator for code outside React (stores, event handlers). */
export function t(
  key: MsgKey | (string & {}),
  params?: Record<string, string | number>
): string {
  return makeT(useI18n.getState().locale)(key, params);
}

/**
 * Minimal i18n — flat dot-notation keys, zh is the primary locale (mobile
 * client targets Chinese users first), en is the fallback. Mirrors the desktop
 * i18n module structure but with its own key namespace.
 */
import { zh } from "./zh";
import { en } from "./en";

export type Locale = "zh" | "en";

const dicts: Record<Locale, Record<string, string>> = { zh, en };

let currentLocale: Locale = "zh";

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Translate a key with optional interpolation: `t("pairing.countdown", { s: 30 })`
 * replaces `{s}` in the template.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dicts[currentLocale] ?? dicts.zh;
  let value = dict[key] ?? dicts.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return value;
}

export function useT() {
  return t;
}

export function useI18n() {
  return { locale: currentLocale, setLocale, t };
}

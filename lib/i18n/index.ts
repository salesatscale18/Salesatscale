/**
 * Minimal i18n: flat message keys, `{name}` placeholders, English fallback.
 *
 * The platform UI is English-only for the MVP but every string goes through a
 * key, so more languages need no redesign. Buyer-facing strings (`buyer.*`)
 * must exist in every buyer language; tests/unit/i18n.test.ts enforces it.
 */
import en from "./messages/en.json";
import he from "./messages/he.json";

export const LOCALES = ["en", "he"] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof typeof en;

const RTL: ReadonlySet<Locale> = new Set(["he"]);

export const messages: Record<Locale, Partial<Record<MessageKey, string>>> = { en, he };

export function t(key: MessageKey, vars?: Record<string, string | number>, locale: Locale = "en"): string {
  const template = messages[locale][key] ?? en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function translator(locale: Locale) {
  return (key: MessageKey, vars?: Record<string, string | number>) => t(key, vars, locale);
}

export function dir(locale: Locale): "ltr" | "rtl" {
  return RTL.has(locale) ? "rtl" : "ltr";
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

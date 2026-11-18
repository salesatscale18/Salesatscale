/**
 * Neutral units for catalog items (mvp-plan 3.13). Pure; unit-tested.
 *
 * An item's `unit` is one of UNIT_KEYS, or "custom" with names per language in
 * `unit_custom`. Items made before this list existed hold free text (e.g.
 * "seat"); unitLabel shows that text as it is.
 */
import type { UnitCustom } from "@/db/schema";

export const UNIT_KEYS = ["item", "user", "site", "device", "licence", "hour", "day", "month", "kg", "package"] as const;
export type UnitKey = (typeof UNIT_KEYS)[number];
export const CUSTOM_UNIT = "custom";

type Forms = { one: string; other: string };

/** Singular and plural per language. English is the fallback for other languages. */
export const UNIT_LABELS: Record<UnitKey, Record<"en" | "he", Forms>> = {
  item: { en: { one: "item", other: "items" }, he: { one: "פריט", other: "פריטים" } },
  user: { en: { one: "user", other: "users" }, he: { one: "משתמש", other: "משתמשים" } },
  site: { en: { one: "site", other: "sites" }, he: { one: "אתר", other: "אתרים" } },
  device: { en: { one: "device", other: "devices" }, he: { one: "מכשיר", other: "מכשירים" } },
  licence: { en: { one: "licence", other: "licences" }, he: { one: "רישיון", other: "רישיונות" } },
  hour: { en: { one: "hour", other: "hours" }, he: { one: "שעה", other: "שעות" } },
  day: { en: { one: "day", other: "days" }, he: { one: "יום", other: "ימים" } },
  month: { en: { one: "month", other: "months" }, he: { one: "חודש", other: "חודשים" } },
  kg: { en: { one: "kg", other: "kg" }, he: { one: "ק״ג", other: "ק״ג" } },
  package: { en: { one: "package", other: "packages" }, he: { one: "חבילה", other: "חבילות" } },
};

/** Pick-list labels for the item editor (canvas: ProductEditor, "Charged per"). */
export const UNIT_OPTIONS: { key: UnitKey | typeof CUSTOM_UNIT; label: string }[] = [
  { key: "item", label: "item" },
  { key: "user", label: "user / seat" },
  { key: "site", label: "site / location" },
  { key: "device", label: "device" },
  { key: "licence", label: "licence" },
  { key: "hour", label: "hour" },
  { key: "day", label: "day" },
  { key: "month", label: "month" },
  { key: "kg", label: "kg" },
  { key: "package", label: "package" },
  { key: CUSTOM_UNIT, label: "Custom unit…" },
];

export function isUnitKey(v: string): v is UnitKey {
  return (UNIT_KEYS as readonly string[]).includes(v);
}

const pick = (forms: Forms, qty: number) => (qty === 1 ? forms.one : forms.other);

/**
 * The unit's name for a quantity in a language: "site" for 1, "sites" for 2.
 * Custom units use their own names (the language asked for, else English, else
 * any). Unknown keys are legacy free text and are shown unchanged.
 */
export function unitLabel(unitKey: string, unitCustom: UnitCustom | null | undefined, lang: string, qty: number): string {
  const builtIn = (key: UnitKey) => pick(lang === "he" ? UNIT_LABELS[key].he : UNIT_LABELS[key].en, qty);
  if (unitKey === CUSTOM_UNIT) {
    const forms = unitCustom?.[lang] ?? unitCustom?.en ?? (unitCustom ? Object.values(unitCustom)[0] : undefined);
    return forms ? pick(forms, qty) : builtIn("item");
  }
  return isUnitKey(unitKey) ? builtIn(unitKey) : unitKey;
}

/** "2 sites", "1 site". */
export function qtyWithUnit(qty: number, unitKey: string, unitCustom: UnitCustom | null | undefined, lang: string): string {
  return `${qty.toLocaleString(lang === "he" ? "he-IL" : "en-US")} ${unitLabel(unitKey, unitCustom, lang, qty)}`;
}

/**
 * Validates custom unit names: each given language needs both forms, 1–30
 * characters. Returns null when invalid or empty.
 */
export function parseUnitCustom(raw: unknown): UnitCustom | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: UnitCustom = {};
  for (const [lang, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z]{2}$/.test(lang) || !v || typeof v !== "object") return null;
    const f = v as Record<string, unknown>;
    const one = typeof f.one === "string" ? f.one.trim() : "";
    const other = typeof f.other === "string" ? f.other.trim() : "";
    if (!one || !other || one.length > 30 || other.length > 30) return null;
    out[lang] = { one, other };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Validation for catalog edits (pure; unit-tested). */
import type { ItemKind, UnitCustom, VolumeTier } from "@/db/schema";
import { parseMajorToMinor } from "@/lib/accounts/rules";
import { CUSTOM_UNIT, isUnitKey, parseUnitCustom } from "@/lib/pricing/units";

/**
 * What saveDraftItem writes. Catalog items hold no price (mvp-plan 3.13):
 * the price fields are the old catalog columns, kept optional so older
 * callers still work. New items get neutral values for them (see
 * lib/catalog/service.ts).
 */
export type CatalogItemInput = {
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  active: boolean;
  availabilityNote: string | null;
  kind?: ItemKind | null;
  unitCustom?: UnitCustom | null;
  /** Legacy price columns, no longer edited. */
  chargeType?: "one_time" | "recurring";
  period?: string | null;
  priceMinor?: number | null;
  volumeTiers?: VolumeTier[];
  customPricingFromQty?: number | null;
};

/** The item editor (canvas: ProductEditor): no price fields. */
export type CatalogItemEdit = Required<Pick<CatalogItemInput, "sku" | "name" | "description" | "unit" | "active" | "availabilityNote">> & {
  kind: ItemKind;
  unitCustom: UnitCustom | null;
};

export type ItemEditErrors = Partial<Record<"sku" | "name" | "kind" | "unit" | "unitCustom", string>>;

export type CatalogItemErrors = Partial<Record<"sku" | "name" | "unit" | "price" | "tiers" | "customPricingFromQty", string>>;

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * Tiers come as text, one per line: "10: 550" means from 10 units the unit
 * price is 550 (major units).
 */
export function parseTiers(text: string, currency: string): VolumeTier[] | null {
  const tiers: VolumeTier[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)\s*\+?\s*[:=]\s*(.+)$/);
    if (!m) return null;
    const minQty = Number(m[1]);
    const priceMinor = parseMajorToMinor(m[2], currency);
    if (!Number.isSafeInteger(minQty) || minQty < 2 || priceMinor === null) return null;
    tiers.push({ minQty, priceMinor });
  }
  const qtys = tiers.map((t) => t.minQty);
  if (new Set(qtys).size !== qtys.length) return null;
  return tiers.sort((a, b) => a.minQty - b.minQty);
}

/**
 * Tier rules (canvas: Catalog · Price tiers editor). Each tier's price is lower
 * than the one before (the base price first), and every tier starts below the
 * custom-pricing quantity. Duplicates are rejected by parseTiers.
 */
export function tierProblem(priceMinor: number | null, tiers: VolumeTier[], customFrom: number | null): string | null {
  let prev = priceMinor;
  for (const tier of [...tiers].sort((a, b) => a.minQty - b.minQty)) {
    if (prev !== null && tier.priceMinor >= prev) return `The price from ${tier.minQty} must be lower than the tier before.`;
    if (customFrom !== null && tier.minQty >= customFrom) return `The tier from ${tier.minQty} starts at or above custom pricing (${customFrom}+).`;
    prev = tier.priceMinor;
  }
  return null;
}

export function parseCatalogItem(raw: Record<string, unknown>, currency: string): { ok: true; value: CatalogItemInput } | { ok: false; errors: CatalogItemErrors } {
  const errors: CatalogItemErrors = {};
  const sku = s(raw.sku).toUpperCase();
  if (!SKU.test(sku)) errors.sku = "Use 1–40 letters, digits, dots, dashes or underscores.";
  const name = s(raw.name);
  if (!name) errors.name = "Enter the product name.";
  const unit = s(raw.unit).toLowerCase();
  if (!unit || unit.length > 30) errors.unit = "Say what one unit is, for example sensor or site.";
  const chargeType = raw.chargeType === "recurring" ? "recurring" : "one_time";
  const priceText = s(raw.price);
  let priceMinor: number | null = null;
  if (priceText) {
    priceMinor = parseMajorToMinor(priceText, currency);
    if (priceMinor === null) errors.price = "Enter the price as a number, or leave it empty if it is priced by hand.";
  }
  const tiers = parseTiers(s(raw.tiers), currency);
  if (tiers === null) errors.tiers = "Each tier needs a quantity of 2 or more, used once, and a price.";
  else if (tiers.length > 0 && priceMinor === null) errors.tiers = "Set a list price before adding volume tiers.";
  const fromText = s(raw.customPricingFromQty);
  let customPricingFromQty: number | null = null;
  if (fromText) {
    customPricingFromQty = /^\d+$/.test(fromText) ? Number(fromText) : NaN;
    if (!Number.isSafeInteger(customPricingFromQty) || customPricingFromQty < 1) errors.customPricingFromQty = "Enter a whole number, or leave it empty.";
  }
  if (!errors.tiers && !errors.customPricingFromQty && tiers) {
    const problem = tierProblem(priceMinor, tiers, customPricingFromQty);
    if (problem) errors.tiers = problem;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      sku,
      name: name.slice(0, 120),
      description: s(raw.description).slice(0, 500) || null,
      chargeType,
      period: chargeType === "recurring" ? "month" : null,
      unit,
      priceMinor,
      volumeTiers: tiers ?? [],
      customPricingFromQty,
      active: raw.active === undefined ? true : raw.active === true || raw.active === "on" || raw.active === "yes",
      availabilityNote: s(raw.availabilityNote).slice(0, 120) || null,
    },
  };
}

/**
 * Parses the item editor form. `unit` is a key from UNIT_OPTIONS or
 * "custom"; a custom unit needs a singular and a plural for English and for
 * each selling language, sent as `unitOne_<lang>` and `unitOther_<lang>`.
 */
export function parseItemEdit(raw: Record<string, unknown>, languages: readonly string[]): { ok: true; value: CatalogItemEdit } | { ok: false; errors: ItemEditErrors } {
  const errors: ItemEditErrors = {};
  const sku = s(raw.sku).toUpperCase();
  if (!SKU.test(sku)) errors.sku = "Use 1–40 letters, digits, dots, dashes or underscores.";
  const name = s(raw.name);
  if (!name) errors.name = "Enter the name.";
  const kind = raw.kind === "product" || raw.kind === "service" ? raw.kind : null;
  if (!kind) errors.kind = "Choose Product or Service.";
  const unit = s(raw.unit);
  let unitCustom: UnitCustom | null = null;
  if (unit === CUSTOM_UNIT) {
    const langs = unitLanguages(languages);
    const forms = Object.fromEntries(langs.map((l) => [l, { one: s(raw[`unitOne_${l}`]), other: s(raw[`unitOther_${l}`]) }]));
    unitCustom = parseUnitCustom(forms);
    if (!unitCustom) errors.unitCustom = "Enter the singular and the plural, up to 30 characters each, for every language.";
  } else if (!isUnitKey(unit)) errors.unit = "Choose a unit from the list.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      sku,
      name: name.slice(0, 120),
      description: s(raw.description).slice(0, 500) || null,
      kind: kind!,
      unit,
      unitCustom,
      active: raw.active === undefined ? true : raw.active === true || raw.active === "on" || raw.active === "yes",
      availabilityNote: s(raw.availabilityNote).slice(0, 120) || null,
    },
  };
}

/** Languages a custom unit needs names in: English first, then the selling languages. */
export function unitLanguages(languages: readonly string[]): string[] {
  return [...new Set(["en", ...languages.filter((l) => /^[a-z]{2}$/.test(l))])];
}

/** Tax rate text like "18" or "17.5" (%) → basis points. */
export function parseTaxRate(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

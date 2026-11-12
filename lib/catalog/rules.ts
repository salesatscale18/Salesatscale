/** Validation for catalog edits (pure; unit-tested). */
import type { VolumeTier } from "@/db/schema";
import { parseMajorToMinor } from "@/lib/accounts/rules";

export type CatalogItemInput = {
  sku: string;
  name: string;
  description: string | null;
  chargeType: "one_time" | "recurring";
  period: string | null;
  unit: string;
  priceMinor: number | null;
  volumeTiers: VolumeTier[];
  customPricingFromQty: number | null;
  active: boolean;
  availabilityNote: string | null;
};

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
  if (tiers === null) errors.tiers = 'One tier per line, like "10: 550" (from 10 units, 550 each).';
  else if (tiers.length > 0 && priceMinor === null) errors.tiers = "Set a list price before adding volume tiers.";
  const fromText = s(raw.customPricingFromQty);
  let customPricingFromQty: number | null = null;
  if (fromText) {
    customPricingFromQty = /^\d+$/.test(fromText) ? Number(fromText) : NaN;
    if (!Number.isSafeInteger(customPricingFromQty) || customPricingFromQty < 1) errors.customPricingFromQty = "Enter a whole number, or leave it empty.";
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

/** Tax rate text like "18" or "17.5" (%) → basis points. */
export function parseTaxRate(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/**
 * Form parsing for the price list screens (pure; unit-tested). Money is typed
 * in major units of the list's currency and stored in minor units.
 */
import type { PriceListEntry, VolumeTier } from "@/db/schema";
import { parseMajorToMinor } from "@/lib/accounts/rules";
import { parseTaxRate, parseTiers } from "@/lib/catalog/rules";
import { ROUNDINGS, type Rounding } from "@/lib/pricing/adjust";
import { isCurrency, isIsoDate, type CopyOptions, type EntryInput, type PriceListMetaInput } from "@/lib/pricing/price-lists";

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const on = (v: unknown) => v === "on" || v === "yes" || v === true;

export type EntryFormErrors = Partial<Record<"oneTimePrice" | "oneTimeTiers" | "recurringPrice" | "recurringTiers" | "recurringPeriod" | "customPricingFromQty", string>>;

export type EntryForm =
  | { ok: true; sold: false; sku: string }
  | { ok: true; sold: true; entry: EntryInput }
  | { ok: false; errors: EntryFormErrors };

const MONEY_ERROR = "Enter the price as a number, or leave it empty to add it later.";
const TIERS_ERROR = "One tier per line, like 10: 550. Quantities of 2 or more, each used once.";

/**
 * One row of the price list editor. "Sold here: no" removes the entry. A
 * charged part with an empty price is kept as "Price missing", which blocks
 * publishing but not saving.
 */
export function parseEntryForm(raw: Record<string, unknown>, currency: string): EntryForm {
  const sku = s(raw.sku).toUpperCase();
  if (raw.sold === "no") return { ok: true, sold: false, sku };
  const errors: EntryFormErrors = {};
  const money = (key: "oneTimePrice" | "recurringPrice", charged: boolean): number | null => {
    const text = s(raw[key]);
    if (!charged || !text) return null;
    const v = parseMajorToMinor(text, currency);
    if (v === null) errors[key] = MONEY_ERROR;
    return v;
  };
  const tiers = (key: "oneTimeTiers" | "recurringTiers", charged: boolean): VolumeTier[] => {
    if (!charged) return [];
    const v = parseTiers(s(raw[key]), currency);
    if (v === null) errors[key] = TIERS_ERROR;
    return v ?? [];
  };
  const oneTimeCharged = on(raw.oneTimeCharged);
  const recurringCharged = on(raw.recurringCharged);
  const oneTimeMinor = money("oneTimePrice", oneTimeCharged);
  const recurringMinor = money("recurringPrice", recurringCharged);
  const oneTimeTiers = tiers("oneTimeTiers", oneTimeCharged);
  const recurringTiers = tiers("recurringTiers", recurringCharged);
  const period = s(raw.recurringPeriod) || "month";
  if (period !== "month" && period !== "year") errors.recurringPeriod = "Choose monthly or yearly.";
  const fromText = s(raw.customPricingFromQty);
  let customPricingFromQty: number | null = null;
  if (fromText) {
    customPricingFromQty = /^\d+$/.test(fromText) ? Number(fromText) : NaN;
    if (!Number.isSafeInteger(customPricingFromQty) || customPricingFromQty < 1) errors.customPricingFromQty = "Enter a whole number, or leave it empty.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    sold: true,
    entry: {
      sku,
      oneTimeCharged,
      oneTimeMinor,
      oneTimeTiers,
      recurringCharged,
      recurringMinor,
      recurringPeriod: period as "month" | "year",
      recurringTiers,
      customPricingFromQty,
    },
  };
}

export type MetaFormErrors = Partial<Record<"name" | "currency" | "taxRate" | "validFrom", string>>;

/** Name, VAT handling, tax rate, valid from; and the currency when `withCurrency`. */
export function parseMetaForm(raw: Record<string, unknown>, withCurrency: boolean): { ok: true; value: PriceListMetaInput } | { ok: false; errors: MetaFormErrors } {
  const errors: MetaFormErrors = {};
  const name = s(raw.name);
  if (!name || name.length > 80) errors.name = "Enter a name of up to 80 characters.";
  const currency = s(raw.currency).toUpperCase();
  if (withCurrency && !isCurrency(currency)) errors.currency = "Choose a currency.";
  const taxRateBp = parseTaxRate(s(raw.taxRate) || "0");
  if (taxRateBp === null) errors.taxRate = "Enter a rate like 18 or 17.5.";
  const validFrom = s(raw.validFrom) || null;
  if (validFrom !== null && !isIsoDate(validFrom)) errors.validFrom = "Enter the date as YYYY-MM-DD.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, currency, pricesIncludeTax: on(raw.pricesIncludeTax), taxRateBp: taxRateBp!, validFrom } };
}

export type CopyFormErrors = MetaFormErrors & Partial<Record<"source" | "adjust" | "rounding", string>>;

/** "Copy and adjust": source version, new name and currency, percent or factor, rounding, VAT. */
export function parseCopyForm(raw: Record<string, unknown>): { ok: true; sourceId: string; options: CopyOptions } | { ok: false; errors: CopyFormErrors } {
  const meta = parseMetaForm(raw, true);
  const errors: CopyFormErrors = meta.ok ? {} : { ...meta.errors };
  const sourceId = s(raw.source);
  if (!sourceId) errors.source = "Choose the price list to copy.";
  const mode = raw.mode === "factor" ? "factor" : "percent";
  const amount = s(raw.amount);
  if (!amount) errors.adjust = mode === "factor" ? "Enter a factor, like 0.25." : "Enter a percentage, like -10 or 7.5. Use 0 to copy as is.";
  const rounding = s(raw.rounding) as Rounding;
  if (!ROUNDINGS.includes(rounding)) errors.rounding = "Choose how to round.";
  if (!meta.ok || Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    sourceId,
    options: {
      name: meta.value.name,
      currency: meta.value.currency,
      ...(mode === "factor" ? { factor: amount } : { percent: amount }),
      rounding,
      pricesIncludeTax: meta.value.pricesIncludeTax,
      taxRateBp: meta.value.taxRateBp,
      validFrom: meta.value.validFrom,
    },
  };
}

const major = (minor: number, currency: string) => {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return (minor / 10 ** digits).toFixed(digits);
};

/** The entry form's starting values (major units, tiers as "10: 550" lines). */
export function entryFormDefaults(e: PriceListEntry | null, currency: string) {
  const tiers = (t: VolumeTier[]) => t.map((x) => `${x.minQty}: ${major(x.priceMinor, currency)}`).join("\n");
  return {
    sold: e !== null,
    oneTimeCharged: e?.oneTimeCharged ?? true,
    oneTimePrice: e?.oneTimeMinor != null ? major(e.oneTimeMinor, currency) : "",
    oneTimeTiers: e ? tiers(e.oneTimeTiers) : "",
    recurringCharged: e?.recurringCharged ?? false,
    recurringPrice: e?.recurringMinor != null ? major(e.recurringMinor, currency) : "",
    recurringPeriod: e?.recurringPeriod ?? "month",
    recurringTiers: e ? tiers(e.recurringTiers) : "",
    customPricingFromQty: e?.customPricingFromQty?.toString() ?? "",
  };
}
export type EntryFormDefaults = ReturnType<typeof entryFormDefaults>;

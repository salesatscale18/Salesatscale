/**
 * A person's unit prices from the quote editor ("price:<SKU>:<one_time|recurring>"
 * fields, in the price list's currency, major units). Checked on the server:
 * 0 or more (0 is allowed: a free line), at most MAX_CUSTOM_PRICE_MAJOR, and
 * no more decimals than the currency has. The result is keyed per charge
 * ("SKU:one_time" / "SKU:recurring"), as createQuoteVersion and previewQuote
 * take a person's prices.
 */
import { parseMajorToMinor } from "@/lib/accounts/rules";
import { currencyDigits } from "./price-field";

/** The highest unit price a person may type (10 million in the currency's major unit). */
export const MAX_CUSTOM_PRICE_MAJOR = 10_000_000;
/** "price:<SKU>:<charge>": SKU as the catalog allows it. */
const PRICE_KEY = /^price:([A-Za-z0-9][A-Za-z0-9._-]{0,39}):(one_time|recurring)$/;
const MAX_FIELDS = 200;


export type CustomPricesResult = { ok: true; customs: Record<string, number> } | { ok: false; sku: string };

export function parseCustomPrices(entries: Iterable<[string, FormDataEntryValue]>, currency: string): CustomPricesResult {
  const customs: Record<string, number> = {};
  const max = MAX_CUSTOM_PRICE_MAJOR * 10 ** currencyDigits(currency);
  let n = 0;
  for (const [k, v] of entries) {
    if (!k.startsWith("price:")) continue;
    const m = k.match(PRICE_KEY);
    if (!m || ++n > MAX_FIELDS) return { ok: false, sku: m?.[1] ?? k.slice(6, 46) };
    const raw = typeof v === "string" ? v.trim() : "";
    // An empty field is no price of the person's: the list price applies.
    if (!raw) continue;
    const minor = parseMajorToMinor(raw, currency);
    if (minor === null || !Number.isSafeInteger(minor) || minor < 0 || minor > max) return { ok: false, sku: m[1] };
    customs[`${m[1]}:${m[2]}`] = minor;
  }
  return { ok: true, customs };
}


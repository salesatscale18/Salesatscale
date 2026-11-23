/** Money in the quote editor's price fields (client-safe: no server imports). */

/** Decimals of a currency's minor unit (ILS, USD: 2; JPY: 0). */
export const currencyDigits = (currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** A minor amount as the editor's field shows it ("250.00"), in the currency's decimals. */
export function minorToField(minor: number, currency: string): string {
  const d = currencyDigits(currency);
  return d === 0 ? String(minor) : (minor / 10 ** d).toFixed(d);
}

/** A field's text in minor units ("250" / "250.00" → 25000), or null when it is not a valid amount in this currency. */
export function fieldToMinor(text: string, currency: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const d = currencyDigits(currency);
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > d) return null;
  return Number(whole) * 10 ** d + Number(frac.padEnd(d, "0") || 0);
}

/** The key of a person's price for one charge of a SKU, as the form field names it ("price:SKU:charge"). */
export const priceField = (sku: string, charge: "one_time" | "recurring") => `price:${sku}:${charge}`;

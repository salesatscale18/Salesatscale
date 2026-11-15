/**
 * Price tier rules (canvas: PriceTiers, PriceEntry). Pure and safe for the
 * browser: the price list tier editor runs these checks as you type, and the
 * server runs the very same functions on save (parseEntryForm) and on publish
 * (tierProblem → entryProblems), so the two can never disagree.
 *
 * A price block is a base price (from 1) plus tiers "from quantity N, unit
 * price P". Rules:
 * - each tier starts at a whole quantity of 2 or more;
 * - no two tiers start at the same quantity;
 * - no tier starts at or above the custom-pricing quantity;
 * - each tier needs a price, lower than the tier before (the base first);
 * - tiers need a base price.
 */
import type { VolumeTier } from "@/db/schema";
import { t } from "@/lib/i18n";

/** Minor-unit digits of a currency (ILS 2, JPY 0). */
export function currencyDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * "1,250.5" → 125050 (minor units); null when it is not a plain positive
 * number with at most the currency's decimals. Same rule as
 * parseMajorToMinor in lib/accounts/rules.ts (which is server-only).
 */
export function minorFromText(value: string, currency: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const digits = currencyDigits(currency);
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > digits) return null;
  const v = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || 0);
  return Number.isSafeInteger(v) && v <= 2_147_483_647 ? v : null;
}

/** "20" → 20; null for empty, zero, decimals or anything else. */
export function wholeQty(value: string): number | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export type TierRowError =
  | { kind: "qty"; qty: number | null }
  | { kind: "duplicate"; qty: number }
  | { kind: "custom"; qty: number; custom: number }
  | { kind: "price"; qty: number }
  | { kind: "lower"; qty: number; prevPrice: number; prevFrom: number };

export type NumericTierRow<K> = { key: K; qty: number | null; price: number | null };

/**
 * The rule check on numbers (prices in minor units). Rows are sorted by
 * quantity (rows without a quantity last); each row gets at most one error,
 * in this order: quantity, duplicate, custom pricing, price, not lower.
 */
export function tierRowErrors<K>(basePrice: number | null, rows: NumericTierRow<K>[], customFrom: number | null): { sorted: NumericTierRow<K>[]; errors: Map<K, TierRowError> } {
  const sorted = [...rows].sort((a, b) => (a.qty ?? Infinity) - (b.qty ?? Infinity));
  const errors = new Map<K, TierRowError>();
  let prev = basePrice;
  let prevFrom = 1;
  const seen = new Set<number>();
  for (const r of sorted) {
    const q = r.qty;
    if (q === null || !Number.isSafeInteger(q) || q < 2) errors.set(r.key, { kind: "qty", qty: q });
    else if (seen.has(q)) errors.set(r.key, { kind: "duplicate", qty: q });
    else if (customFrom !== null && q >= customFrom) errors.set(r.key, { kind: "custom", qty: q, custom: customFrom });
    else if (r.price === null) errors.set(r.key, { kind: "price", qty: q });
    else if (prev !== null && r.price >= prev) errors.set(r.key, { kind: "lower", qty: q, prevPrice: prev, prevFrom });
    if (q !== null) seen.add(q);
    if (r.price !== null) {
      prev = r.price;
      prevFrom = q ?? prevFrom;
    }
  }
  return { sorted, errors };
}

/** What the editor shows under a row (catalog.tiers.* keys). */
export function tierErrorText(e: TierRowError, currency: string): string {
  switch (e.kind) {
    case "qty": return t("catalog.tiers.err_qty");
    case "duplicate": return t("catalog.tiers.err_duplicate", { qty: e.qty });
    case "custom": return t("catalog.tiers.err_custom", { qty: e.qty, custom: e.custom });
    case "price": return t("catalog.tiers.err_price");
    case "lower": return t("catalog.tiers.err_lower", { price: moneyText(e.prevPrice, currency), from: e.prevFrom });
  }
}

export type TierRowText<K> = { key: K; qty: string; price: string };

export type PriceBlockCheck<K> = {
  /** The base price in minor units; null when empty or not a number. */
  baseMinor: number | null;
  /** "invalid": the base is not a number; "needed": tiers without a base price. */
  baseError: "invalid" | "needed" | null;
  /** Rows sorted by quantity, each with its error (null when fine). */
  rows: (TierRowText<K> & { qtyN: number | null; priceMinor: number | null; error: TierRowError | null })[];
  /** The tiers, sorted; only meaningful when errorCount is 0. */
  tiers: VolumeTier[];
  errorCount: number;
};

/** Checks one price block (one-time or recurring) as typed, in major units. */
export function checkPriceBlock<K>(base: string, rows: TierRowText<K>[], customFrom: number | null, currency: string): PriceBlockCheck<K> {
  const baseText = base.trim();
  const baseMinor = baseText ? minorFromText(baseText, currency) : null;
  const numeric = rows.map((r) => ({ key: r.key, qty: wholeQty(r.qty), price: r.price.trim() ? minorFromText(r.price, currency) : null }));
  const { sorted, errors } = tierRowErrors(baseMinor, numeric, customFrom);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const baseError = baseText && baseMinor === null ? "invalid" : rows.length > 0 && baseMinor === null ? "needed" : null;
  return {
    baseMinor,
    baseError,
    rows: sorted.map((n) => ({ ...byKey.get(n.key)!, qtyN: n.qty, priceMinor: n.price, error: errors.get(n.key) ?? null })),
    tiers: sorted.filter((n) => n.qty !== null && n.price !== null).map((n) => ({ minQty: n.qty!, priceMinor: n.price! })),
    errorCount: errors.size + (baseError ? 1 : 0),
  };
}

/**
 * The tiers as the hidden form field carries them: one "qty: price" per
 * line (the format the server has always read). Lines that do not split
 * are kept, so the server reports them instead of dropping them.
 */
export function tierLines(text: string): TierRowText<number>[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, key) => {
      const m = line.match(/^([^:=]*)[:=](.*)$/);
      return m ? { key, qty: m[1].trim().replace(/\+$/, "").trim(), price: m[2].trim() } : { key, qty: line, price: "" };
    });
}

export function serializeTierRows(rows: { qty: string; price: string }[]): string {
  return rows.map((r) => `${r.qty.trim()}: ${r.price.trim()}`).join("\n");
}

/** ₪590, ₪12.50: whole amounts without decimals (the summary line). */
export function moneyText(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const whole = minor % 10 ** digits === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

/**
 * "1–9: ₪590 · 10–19: ₪550 · 20+: custom pricing"; recurring prices get
 * "/month" or "/year". Rows without a quantity or price are left out.
 */
export function tierSummary(baseMinor: number | null, tiers: VolumeTier[], customFrom: number | null, currency: string, period: "month" | "year" | null = null): string {
  const price = (m: number | null) => {
    if (m === null) return "—";
    const text = moneyText(m, currency);
    return period ? t(period === "year" ? "catalog.tiers.per_year" : "catalog.tiers.per_month", { price: text }) : text;
  };
  const steps = [{ from: 1, price: baseMinor }, ...[...tiers].sort((a, b) => a.minQty - b.minQty).map((x) => ({ from: x.minQty, price: x.priceMinor as number | null }))].filter(
    (s) => customFrom === null || s.from < customFrom,
  );
  const parts = steps.map((s, i) => {
    const end = i + 1 < steps.length ? steps[i + 1].from - 1 : customFrom !== null ? customFrom - 1 : null;
    const range = end === null ? `${s.from}+` : end > s.from ? `${s.from}–${end}` : `${s.from}`;
    return `${range}: ${price(s.price)}`;
  });
  if (customFrom !== null) parts.push(`${customFrom}+: ${t("catalog.tiers.custom_short")}`);
  return parts.join(" · ");
}

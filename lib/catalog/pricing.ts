/**
 * The quote engine (implementation plan P3.2). Pure and integer-only: every
 * amount is in minor units, prices come only from the catalog (or from a
 * person pricing a custom line), and the agent can never set a price.
 */
import type { ApprovalReason, VolumeTier } from "@/db/schema";

export type PricingItem = {
  id: string;
  sku: string;
  name: string;
  chargeType: "one_time" | "recurring";
  period: string | null;
  unit: string;
  priceMinor: number | null;
  volumeTiers: VolumeTier[];
  customPricingFromQty: number | null;
  active: boolean;
};

export type QuoteRequestLine = {
  sku: string;
  qty: number;
  /** Set only by a person pricing a custom line (approval). Never by the agent. */
  customUnitPriceMinor?: number;
};

export type PricedLine = {
  catalogItemId: string;
  sku: string;
  name: string;
  chargeType: "one_time" | "recurring";
  period: string | null;
  unit: string;
  qty: number;
  unitPriceMinor: number | null;
  priceSource: "list" | "tier" | "custom";
  lineTotalMinor: number | null;
};

export type Totals = { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number };

export type PricingError =
  | { kind: "unknown_sku"; sku: string }
  | { kind: "inactive"; sku: string }
  | { kind: "bad_qty"; sku: string }
  | { kind: "duplicate_sku"; sku: string }
  | { kind: "no_lines" }
  | { kind: "bad_discount" }
  | { kind: "bad_custom_price"; sku: string }
  | { kind: "mixed_periods" };

export type PricingResult =
  | { ok: false; errors: PricingError[] }
  | {
      ok: true;
      lines: PricedLine[];
      oneTime: Totals;
      recurring: Totals;
      recurringPeriod: string | null;
      approvalReasons: ApprovalReason[];
      /** False while any line has no price; totals then cover only priced lines. */
      complete: boolean;
    };

export const MAX_QTY = 100_000;

/** Round-half-up of n/d for non-negative integers, without floating point drift. */
export function roundDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n < 0 || d <= 0) throw new Error(`roundDiv(${n}, ${d})`);
  return Math.floor((2 * n + d) / (2 * d));
}

/** Unit price for a quantity: the highest volume tier reached, else the list price. */
export function unitPriceFor(item: Pick<PricingItem, "priceMinor" | "volumeTiers">, qty: number): { priceMinor: number | null; source: "list" | "tier" } {
  if (item.priceMinor === null) return { priceMinor: null, source: "list" };
  const tier = [...item.volumeTiers].filter((t) => qty >= t.minQty).sort((a, b) => b.minQty - a.minQty)[0];
  return tier ? { priceMinor: tier.priceMinor, source: "tier" } : { priceMinor: item.priceMinor, source: "list" };
}

export function computeTotals(subtotalMinor: number, discountBp: number, pricesIncludeTax: boolean, taxRateBp: number): Totals {
  const discountMinor = roundDiv(subtotalMinor * discountBp, 10_000);
  const net = subtotalMinor - discountMinor;
  if (pricesIncludeTax) {
    const taxMinor = net - roundDiv(net * 10_000, 10_000 + taxRateBp);
    return { subtotalMinor, discountMinor, taxMinor, totalMinor: net };
  }
  const taxMinor = roundDiv(net * taxRateBp, 10_000);
  return { subtotalMinor, discountMinor, taxMinor, totalMinor: net + taxMinor };
}

export function priceQuote(input: {
  items: PricingItem[];
  lines: QuoteRequestLine[];
  discountBp: number;
  maxDiscountBp: number;
  pricesIncludeTax: boolean;
  taxRateBp: number;
}): PricingResult {
  const errors: PricingError[] = [];
  if (input.lines.length === 0) errors.push({ kind: "no_lines" });
  if (!Number.isInteger(input.discountBp) || input.discountBp < 0 || input.discountBp > 10_000) errors.push({ kind: "bad_discount" });
  const bySku = new Map(input.items.map((i) => [i.sku, i]));
  const seen = new Set<string>();
  const approvalReasons: ApprovalReason[] = [];
  const lines: PricedLine[] = [];

  for (const l of input.lines) {
    const item = bySku.get(l.sku);
    if (!item) { errors.push({ kind: "unknown_sku", sku: l.sku }); continue; }
    if (!item.active) { errors.push({ kind: "inactive", sku: l.sku }); continue; }
    if (seen.has(l.sku)) { errors.push({ kind: "duplicate_sku", sku: l.sku }); continue; }
    seen.add(l.sku);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) { errors.push({ kind: "bad_qty", sku: l.sku }); continue; }
    if (l.customUnitPriceMinor !== undefined && (!Number.isSafeInteger(l.customUnitPriceMinor) || l.customUnitPriceMinor < 0)) {
      errors.push({ kind: "bad_custom_price", sku: l.sku });
      continue;
    }

    let unitPriceMinor: number | null;
    let priceSource: PricedLine["priceSource"];
    if (l.customUnitPriceMinor !== undefined) {
      unitPriceMinor = l.customUnitPriceMinor;
      priceSource = "custom";
    } else {
      const p = unitPriceFor(item, l.qty);
      unitPriceMinor = p.priceMinor;
      priceSource = p.source;
      if (p.priceMinor === null) approvalReasons.push({ kind: "price_missing", sku: item.sku });
      else if (item.customPricingFromQty !== null && l.qty >= item.customPricingFromQty) {
        approvalReasons.push({ kind: "custom_pricing_qty", sku: item.sku, qty: l.qty, from: item.customPricingFromQty });
      }
    }
    lines.push({
      catalogItemId: item.id,
      sku: item.sku,
      name: item.name,
      chargeType: item.chargeType,
      period: item.chargeType === "recurring" ? item.period ?? "month" : null,
      unit: item.unit,
      qty: l.qty,
      unitPriceMinor,
      priceSource,
      lineTotalMinor: unitPriceMinor === null ? null : unitPriceMinor * l.qty,
    });
  }

  const periods = new Set(lines.filter((l) => l.chargeType === "recurring").map((l) => l.period));
  if (periods.size > 1) errors.push({ kind: "mixed_periods" });
  if (errors.length > 0) return { ok: false, errors };

  if (input.discountBp > input.maxDiscountBp) {
    approvalReasons.push({ kind: "discount_over_limit", requestedBp: input.discountBp, limitBp: input.maxDiscountBp });
  }
  const sum = (kind: PricedLine["chargeType"]) =>
    lines.filter((l) => l.chargeType === kind).reduce((acc, l) => acc + (l.lineTotalMinor ?? 0), 0);
  return {
    ok: true,
    lines,
    oneTime: computeTotals(sum("one_time"), input.discountBp, input.pricesIncludeTax, input.taxRateBp),
    recurring: computeTotals(sum("recurring"), input.discountBp, input.pricesIncludeTax, input.taxRateBp),
    recurringPeriod: [...periods][0] ?? null,
    approvalReasons,
    complete: lines.every((l) => l.unitPriceMinor !== null),
  };
}

/** Plain-language text for an approval reason. */
export function approvalReasonText(r: ApprovalReason): string {
  if (r.kind === "price_missing") return `${r.sku} has no price in the catalog.`;
  if (r.kind === "custom_pricing_qty") return `${r.qty} × ${r.sku} is at or above the custom-pricing quantity (${r.from}).`;
  return `Discount ${(r.requestedBp / 100).toFixed(1)}% is above the ${(r.limitBp / 100).toFixed(1)}% limit.`;
}

export function pricingErrorText(e: PricingError): string {
  switch (e.kind) {
    case "unknown_sku": return `${e.sku} is not in the published catalog.`;
    case "inactive": return `${e.sku} is not available.`;
    case "bad_qty": return `Quantity for ${e.sku} must be a whole number from 1 to ${MAX_QTY.toLocaleString("en-US")}.`;
    case "duplicate_sku": return `${e.sku} appears twice. Use one line with the total quantity.`;
    case "no_lines": return "Add at least one product.";
    case "bad_discount": return "Discount must be between 0% and 100%.";
    case "bad_custom_price": return `The price for ${e.sku} must be zero or more.`;
    case "mixed_periods": return "Recurring lines must share one billing period.";
  }
}

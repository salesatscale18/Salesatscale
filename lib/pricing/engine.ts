/**
 * Pricing engine v2 (mvp-plan 3.13): catalog items carry no price; prices come
 * from a price list. Pure and integer-only, like lib/catalog/pricing.ts, whose
 * integer helpers it reuses.
 *
 * Each requested item becomes up to two lines, one per charge: one-time and
 * recurring (per month or per year). Per charge, a price list entry gives a
 * list price with optional volume tiers, "Price missing" (charged, no price),
 * or "not charged". A SKU without an entry is not sold in that list.
 *
 * The quote discount applies to one-time charges only. Recurring charges are
 * never discounted by it.
 */
import type { ApprovalReason, PriceListEntry, RecurringPeriod, UnitCustom } from "@/db/schema";
import { computeTotals, MAX_QTY, unitPriceFor, type Totals } from "@/lib/catalog/pricing";
import { applyAutoAdd, type AutoAddRule } from "./auto-add";

export type Charge = "one_time" | "recurring";

export type EngineItem = {
  id?: string;
  sku: string;
  name: string;
  unit: string;
  unitCustom?: UnitCustom | null;
  /** Null on older items: treated as product. */
  kind: "product" | "service" | null;
  active: boolean;
};

export type EngineEntry = Pick<
  PriceListEntry,
  | "sku"
  | "oneTimeCharged"
  | "oneTimeMinor"
  | "oneTimeTiers"
  | "recurringCharged"
  | "recurringMinor"
  | "recurringPeriod"
  | "recurringTiers"
  | "customPricingFromQty"
>;

export type EnginePriceList = { id?: string; version?: number; currency: string; pricesIncludeTax: boolean; taxRateBp: number };

export type EngineRequestLine = {
  sku: string;
  qty: number;
  /** Set only by a person pricing the line (approval), per charge. Never by the agent. */
  customOneTimeMinor?: number;
  customRecurringMinor?: number;
};

export type EngineLine = {
  catalogItemId: string | null;
  sku: string;
  name: string;
  kind: "product" | "service";
  unit: string;
  unitCustom: UnitCustom | null;
  qty: number;
  charge: Charge;
  /** "month" | "year" for recurring lines; null for one-time. */
  period: RecurringPeriod | null;
  unitPriceMinor: number | null;
  /** "not_charged": the entry charges nothing for this item (shown as included, total 0). */
  priceSource: "list" | "tier" | "custom" | "not_charged";
  lineTotalMinor: number | null;
  /** Added by an "Add automatically with" rule. */
  autoAdded: boolean;
  /** False for auto-added lines the buyer cannot remove. */
  removable: boolean;
};

export type EngineError =
  | { kind: "unknown_sku"; sku: string }
  | { kind: "inactive"; sku: string }
  | { kind: "not_sold"; sku: string }
  | { kind: "bad_qty"; sku: string }
  | { kind: "duplicate_sku"; sku: string }
  | { kind: "no_lines" }
  | { kind: "bad_discount" }
  | { kind: "bad_custom_price"; sku: string }
  | { kind: "mixed_periods" };

/** An approval reason, plus which charge it is about when it is about one. */
export type EngineApprovalReason = ApprovalReason & { charge?: Charge };

export type EngineResult =
  | { ok: false; errors: EngineError[] }
  | {
      ok: true;
      currency: string;
      pricesIncludeTax: boolean;
      taxRateBp: number;
      lines: EngineLine[];
      oneTime: Totals;
      recurring: Totals;
      recurringPeriod: RecurringPeriod | null;
      approvalReasons: EngineApprovalReason[];
      /** False while any charged line has no price; totals then cover only priced lines. */
      complete: boolean;
      /** SKUs added by auto-add rules (those not sold in this price list are left out). */
      autoAdded: string[];
      /** SKUs the buyer asked to remove that cannot be removed. */
      keptDespiteRemoval: string[];
    };

export type EngineInput = {
  items: EngineItem[];
  entries: EngineEntry[];
  priceList: EnginePriceList;
  lines: EngineRequestLine[];
  /** Number of sites, when known (auto-add per site). */
  sites?: number;
  discountBp: number;
  maxDiscountBp: number;
  autoAdd?: AutoAddRule[];
  /** SKUs the buyer removed from an earlier version of the quote. */
  removedByBuyer?: string[];
};

const validCustom = (v: number | undefined) => v === undefined || (Number.isSafeInteger(v) && v >= 0);

export function priceWithList(input: EngineInput): EngineResult {
  const errors: EngineError[] = [];
  if (input.lines.length === 0) errors.push({ kind: "no_lines" });
  if (!Number.isInteger(input.discountBp) || input.discountBp < 0 || input.discountBp > 10_000) errors.push({ kind: "bad_discount" });

  const auto = applyAutoAdd(input.autoAdd ?? [], input.lines, input.sites, input.removedByBuyer ?? []);
  const autoBySku = new Map(auto.autoAdded.map((a) => [a.sku, a]));
  const itemBySku = new Map(input.items.map((i) => [i.sku, i]));
  const entryBySku = new Map(input.entries.map((e) => [e.sku, e]));
  const seen = new Set<string>();
  const approvalReasons: EngineApprovalReason[] = [];
  const lines: EngineLine[] = [];

  const skipped = new Set<string>();
  for (const l of auto.lines as EngineRequestLine[]) {
    const item = itemBySku.get(l.sku);
    // An auto-add SKU that is not sold here (not in this price list, inactive or
    // gone from the catalog) is simply not added.
    if (autoBySku.has(l.sku) && (!item || !item.active || !entryBySku.has(l.sku))) { skipped.add(l.sku); continue; }
    if (!item) { errors.push({ kind: "unknown_sku", sku: l.sku }); continue; }
    if (!item.active) { errors.push({ kind: "inactive", sku: l.sku }); continue; }
    if (seen.has(l.sku)) { errors.push({ kind: "duplicate_sku", sku: l.sku }); continue; }
    seen.add(l.sku);
    const entry = entryBySku.get(l.sku);
    if (!entry) { errors.push({ kind: "not_sold", sku: l.sku }); continue; }
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) { errors.push({ kind: "bad_qty", sku: l.sku }); continue; }
    if (!validCustom(l.customOneTimeMinor) || !validCustom(l.customRecurringMinor)) { errors.push({ kind: "bad_custom_price", sku: l.sku }); continue; }

    const added = autoBySku.get(l.sku);
    const base = {
      catalogItemId: item.id ?? null,
      sku: item.sku,
      name: item.name,
      kind: item.kind ?? "product",
      unit: item.unit,
      unitCustom: item.unitCustom ?? null,
      qty: l.qty,
      autoAdded: added !== undefined,
      removable: added ? added.removable : true,
    } as const;

    const parts: { charge: Charge; charged: boolean; price: number | null; tiers: EngineEntry["oneTimeTiers"]; custom?: number }[] = [
      { charge: "one_time", charged: entry.oneTimeCharged, price: entry.oneTimeMinor, tiers: entry.oneTimeTiers, custom: l.customOneTimeMinor },
      { charge: "recurring", charged: entry.recurringCharged, price: entry.recurringMinor, tiers: entry.recurringTiers, custom: l.customRecurringMinor },
    ];
    const charged = parts.filter((p) => p.charged);
    if (charged.length === 0) {
      // Sold, but nothing is charged for it: one included line.
      lines.push({ ...base, charge: "one_time", period: null, unitPriceMinor: 0, priceSource: "not_charged", lineTotalMinor: 0 });
      continue;
    }
    let customQtyFlagged = false;
    for (const p of charged) {
      let unitPriceMinor: number | null;
      let priceSource: EngineLine["priceSource"];
      if (p.custom !== undefined) {
        unitPriceMinor = p.custom;
        priceSource = "custom";
      } else {
        const u = unitPriceFor({ priceMinor: p.price, volumeTiers: p.tiers }, l.qty);
        unitPriceMinor = u.priceMinor;
        priceSource = u.source;
        if (u.priceMinor === null) approvalReasons.push({ kind: "price_missing", sku: item.sku, charge: p.charge });
        else if (entry.customPricingFromQty !== null && l.qty >= entry.customPricingFromQty && !customQtyFlagged) {
          approvalReasons.push({ kind: "custom_pricing_qty", sku: item.sku, qty: l.qty, from: entry.customPricingFromQty });
          customQtyFlagged = true;
        }
      }
      lines.push({
        ...base,
        charge: p.charge,
        period: p.charge === "recurring" ? (entry.recurringPeriod ?? "month") : null,
        unitPriceMinor,
        priceSource,
        lineTotalMinor: unitPriceMinor === null ? null : unitPriceMinor * l.qty,
      });
    }
  }

  const periods = new Set(lines.filter((l) => l.charge === "recurring").map((l) => l.period));
  if (periods.size > 1) errors.push({ kind: "mixed_periods" });
  if (errors.length > 0) return { ok: false, errors };

  if (input.discountBp > input.maxDiscountBp) {
    approvalReasons.push({ kind: "discount_over_limit", requestedBp: input.discountBp, limitBp: input.maxDiscountBp });
  }
  const { pricesIncludeTax, taxRateBp, currency } = input.priceList;
  const sum = (charge: Charge) => lines.filter((l) => l.charge === charge).reduce((acc, l) => acc + (l.lineTotalMinor ?? 0), 0);
  return {
    ok: true,
    currency,
    pricesIncludeTax,
    taxRateBp,
    lines,
    oneTime: computeTotals(sum("one_time"), input.discountBp, pricesIncludeTax, taxRateBp),
    recurring: computeTotals(sum("recurring"), 0, pricesIncludeTax, taxRateBp),
    recurringPeriod: ([...periods][0] as RecurringPeriod | undefined) ?? null,
    approvalReasons,
    complete: lines.every((l) => l.unitPriceMinor !== null),
    autoAdded: auto.autoAdded.map((a) => a.sku).filter((s) => !skipped.has(s)),
    keptDespiteRemoval: auto.keptDespiteRemoval.filter((s) => !skipped.has(s)),
  };
}

/** Plain-language text for an approval reason. */
export function engineApprovalText(r: EngineApprovalReason): string {
  if (r.kind === "price_missing") {
    const part = r.charge === "recurring" ? "recurring price" : r.charge === "one_time" ? "one-time price" : "price";
    return `${r.sku} has no ${part} in the price list.`;
  }
  if (r.kind === "custom_pricing_qty") return `${r.qty} × ${r.sku} is at or above the custom-pricing quantity (${r.from}).`;
  return `Discount ${(r.requestedBp / 100).toFixed(1)}% is above the ${(r.limitBp / 100).toFixed(1)}% limit.`;
}

export function engineErrorText(e: EngineError): string {
  switch (e.kind) {
    case "unknown_sku": return `${e.sku} is not in the catalog.`;
    case "inactive": return `${e.sku} is not available.`;
    case "not_sold": return `${e.sku} is not sold in this price list.`;
    case "bad_qty": return `Quantity for ${e.sku} must be a whole number from 1 to ${MAX_QTY.toLocaleString("en-US")}.`;
    case "duplicate_sku": return `${e.sku} appears twice. Use one line with the total quantity.`;
    case "no_lines": return "Add at least one item.";
    case "bad_discount": return "Discount must be between 0% and 100%.";
    case "bad_custom_price": return `The price for ${e.sku} must be zero or more.`;
    case "mixed_periods": return "Recurring prices must share one billing period.";
  }
}

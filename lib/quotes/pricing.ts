/**
 * Where a quote's prices come from (mvp-plan 3.13): lead → market → the
 * market's price list (lineage) → its live version. The catalog says what is
 * sold (names, units, kinds, rules); the price list says for how much. A SKU
 * without an entry is not sold in that market.
 */
import type { Db } from "@/db/types";
import type { Market, PriceList, PriceListEntry } from "@/db/schema";
import { publishedCatalog } from "@/lib/catalog/service";
import { resolveMarket } from "@/lib/markets/service";
import { autoAddRules } from "@/lib/catalog/fit";
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import type { EngineItem, EnginePriceList } from "@/lib/pricing/engine";
import { livePriceList } from "@/lib/pricing/price-lists";

export type PublishedCatalog = NonNullable<Awaited<ReturnType<typeof publishedCatalog>>>;
export type LivePriceList = { list: PriceList; entries: PriceListEntry[] };

/** Everything pricing for one lead needs. Read once; the agent keeps it for a turn. */
export type PricingContext = {
  market: Market;
  /** Null when no catalog is published yet. */
  catalog: PublishedCatalog | null;
  /** Null when the market has no price list, or it has no live version ("no_price_list"). */
  priceList: LivePriceList | null;
};

/** The market (null = home), the published catalog and the market's live price list. */
export async function pricingContext(
  db: Db, accountId: string, marketId: string | null | undefined, pre?: { catalog?: PublishedCatalog | null },
): Promise<PricingContext> {
  // A preloaded catalog (or a preloaded "none published", null) is used when it is this account's.
  const given = pre?.catalog;
  const catalogP = given === null || (given && given.version.accountId === accountId) ? Promise.resolve(given) : publishedCatalog(db, accountId);
  const [market, catalog] = await Promise.all([resolveMarket(db, accountId, marketId), catalogP]);
  const priceList = market.priceListLineageId ? await livePriceList(db, accountId, market.priceListLineageId) : null;
  return { market, catalog, priceList };
}

/**
 * True when a context someone loaded earlier is this account's and belongs to
 * this market (null = the home market). Anything else is ignored and read again.
 */
export function contextFits(ctx: PricingContext | undefined, accountId: string, marketId: string | null | undefined): ctx is PricingContext {
  if (!ctx || ctx.market.accountId !== accountId) return false;
  if (marketId ? ctx.market.id !== marketId : !ctx.market.isHome) return false;
  if (ctx.catalog && ctx.catalog.version.accountId !== accountId) return false;
  if (ctx.priceList && (ctx.priceList.list.accountId !== accountId || ctx.priceList.list.lineageId !== ctx.market.priceListLineageId)) return false;
  return true;
}

/**
 * The catalog's "Add automatically with" rules. Lane C's publishedCatalog()
 * returns them as `autoAdd` (and keeps them out of `rules`); without that
 * field they are read from `rules`. Never both, so a rule is applied once.
 */
export function catalogAutoAdd(catalog: PublishedCatalog): AutoAddRule[] {
  const given = (catalog as PublishedCatalog & { autoAdd?: AutoAddRule[] }).autoAdd;
  return given ?? autoAddRules(catalog.rules);
}

export function engineItems(catalog: PublishedCatalog): EngineItem[] {
  return catalog.items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, unit: i.unit, unitCustom: i.unitCustom ?? null, kind: i.kind ?? null, active: i.active }));
}

export function enginePriceList(list: PriceList): EnginePriceList {
  return { id: list.id, version: list.version, currency: list.currency, pricesIncludeTax: list.pricesIncludeTax, taxRateBp: list.taxRateBp };
}

export type Charge = "one_time" | "recurring";

/**
 * Custom prices a person set, keyed "SKU:one_time" / "SKU:recurring". A bare
 * "SKU" key (older callers) means the item's only charge, or its one-time charge
 * when it has both.
 */
export function customsFor(
  customs: Record<string, number> | undefined, sku: string, entry: Pick<PriceListEntry, "oneTimeCharged" | "recurringCharged"> | undefined,
): { customOneTimeMinor?: number; customRecurringMinor?: number } {
  if (!customs) return {};
  const out: { customOneTimeMinor?: number; customRecurringMinor?: number } = {};
  const one = customs[`${sku}:one_time`];
  const rec = customs[`${sku}:recurring`];
  if (one !== undefined) out.customOneTimeMinor = one;
  if (rec !== undefined) out.customRecurringMinor = rec;
  const bare = customs[sku];
  if (bare !== undefined && entry) {
    if (entry.oneTimeCharged && out.customOneTimeMinor === undefined) out.customOneTimeMinor = bare;
    else if (!entry.oneTimeCharged && entry.recurringCharged && out.customRecurringMinor === undefined) out.customRecurringMinor = bare;
  }
  return out;
}

/** One request line per SKU, from stored quote lines (one per charge). */
export function requestLinesOf(lines: { sku: string; qty: number }[]): { sku: string; qty: number }[] {
  const out = new Map<string, number>();
  for (const l of lines) if (!out.has(l.sku)) out.set(l.sku, l.qty);
  return [...out].map(([sku, qty]) => ({ sku, qty }));
}

/** Prices a person set on earlier lines, keyed per charge, so a re-price keeps them. */
export function customPricesOf(lines: { sku: string; chargeType: string; unitPriceMinor: number | null; priceSource: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) if (l.priceSource === "custom" && l.unitPriceMinor !== null) out[`${l.sku}:${l.chargeType}`] = l.unitPriceMinor;
  return out;
}

/**
 * The buyer's removals that take effect (stored on the version as
 * removed_auto_add): SKUs that only removable "Add automatically with" rules
 * add. A SKU any rule adds as required is never removed, and a SKU the request
 * itself holds is on the quote, so it is not a removal. A removal stays stored
 * while its product is off the quote, so it holds if the product comes back.
 */
export function effectiveRemovals(rules: AutoAddRule[], requested: readonly string[] | undefined, lineSkus: readonly string[]): string[] {
  if (!requested?.length) return [];
  const removable = new Map<string, boolean>();
  for (const r of rules) removable.set(r.sku, (removable.get(r.sku) ?? true) && r.removable);
  const onQuote = new Set(lineSkus);
  const out: string[] = [];
  for (const sku of requested) {
    if (typeof sku !== "string" || out.includes(sku) || onQuote.has(sku) || removable.get(sku) !== true) continue;
    out.push(sku);
    if (out.length >= 50) break;
  }
  return out;
}

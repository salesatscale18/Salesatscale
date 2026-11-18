/**
 * Display helpers for the Price lists screens (setup list-page redesign):
 * how many catalog items a list prices, the tier chip, the VAT line, filters
 * and sorting. Pure; unit-tested in tests/unit/price-list-view.test.ts.
 */
import type { PriceList, PriceListEntry, RecurringPeriod, VolumeTier } from "@/db/schema";
import { formatMoney } from "@/lib/domain/money";
import { t } from "@/lib/i18n";
import type { SortAccessors } from "@/lib/list-kit";
import { partState, type PriceListSummary } from "./price-lists";

/** Priced: the list has the item and every charged part has a price ("Not charged" counts as priced). */
export function entryPriced(e: PriceListEntry | null | undefined): boolean {
  if (!e) return false;
  return partState(e, "one_time") !== "price_missing" && partState(e, "recurring") !== "price_missing";
}

/** "4 of 5": catalog items the list prices, of all catalog items. */
export function itemsPriced(skus: string[], entries: PriceListEntry[]): { priced: number; total: number; missing: number } {
  const bySku = new Map(entries.map((e) => [e.sku, e]));
  const unique = [...new Set(skus)];
  const priced = unique.filter((s) => entryPriced(bySku.get(s))).length;
  return { priced, total: unique.length, missing: unique.length - priced };
}

const tierText = (tier: VolumeTier, currency: string, period: RecurringPeriod | null) =>
  t("price_lists.tier_chip", { qty: tier.minQty, price: formatMoney(tier.priceMinor, currency, period ? { period } : {}) });

/**
 * The tier chip of a prices row: the first tier ("From 10: ₪550.00"), the
 * recurring one with its period, and "+2" when there are more. Null without tiers.
 */
export function tierChip(e: PriceListEntry | null | undefined, currency: string): string | null {
  if (!e) return null;
  const one = e.oneTimeCharged ? [...e.oneTimeTiers].sort((a, b) => a.minQty - b.minQty) : [];
  const rec = e.recurringCharged ? [...e.recurringTiers].sort((a, b) => a.minQty - b.minQty) : [];
  const first = one[0] ? tierText(one[0], currency, null) : rec[0] ? tierText(rec[0], currency, e.recurringPeriod ?? "month") : null;
  if (!first) return null;
  const more = one.length + rec.length - 1;
  return more > 0 ? t("price_lists.tier_chip_more", { first, more }) : first;
}

export const hasTiers = (e: PriceListEntry | null | undefined) => !!e && ((e.oneTimeCharged && e.oneTimeTiers.length > 0) || (e.recurringCharged && e.recurringTiers.length > 0));
export const hasRecurring = (e: PriceListEntry | null | undefined) => !!e && e.recurringCharged;

/** "18%" and "Prices include VAT" / "Prices without VAT". */
export function vatParts(l: Pick<PriceList, "pricesIncludeTax" | "taxRateBp">): { rate: string; mode: string } {
  return { rate: `${l.taxRateBp / 100}%`, mode: t(l.pricesIncludeTax ? "price_lists.vat_included" : "price_lists.vat_excluded") };
}

/** When the list last changed: its draft was started, or its live version was published. */
export function listUpdatedAt(s: Pick<PriceListSummary, "live" | "draft">): Date {
  const dates = [s.draft?.createdAt, s.live?.publishedAt ?? s.live?.createdAt].filter((d): d is Date => d instanceof Date);
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

// ---------------------------------------------------------------------------
// Price lists list
// ---------------------------------------------------------------------------

export type PriceListRow = { summary: PriceListSummary; priced: { priced: number; total: number; missing: number }; updated: Date };

export const PRICE_LIST_STATUSES = ["live", "draft"] as const;

/** Search by name or currency; status "live" (has a live version) or "draft" (has a draft). */
export function filterPriceLists(rows: PriceListRow[], f: { q?: string; status?: string }): PriceListRow[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status === "live" && !r.summary.live) return false;
    if (f.status === "draft" && !r.summary.draft) return false;
    return !q || r.summary.shown.name.toLowerCase().includes(q) || r.summary.shown.currency.toLowerCase().includes(q);
  });
}

export const PRICE_LIST_SORTS = ["name", "currency", "priced", "updated"] as const;
export type PriceListSort = (typeof PRICE_LIST_SORTS)[number];

export const priceListSortAccessors: SortAccessors<PriceListRow, PriceListSort> = {
  name: (r) => r.summary.shown.name,
  currency: (r) => r.summary.shown.currency,
  priced: (r) => (r.priced.total ? r.priced.priced / r.priced.total : null),
  updated: (r) => r.updated,
};

// ---------------------------------------------------------------------------
// One price list: the prices table
// ---------------------------------------------------------------------------

export type PriceRow = {
  sku: string;
  name: string | null;
  kind: string | null;
  entry: PriceListEntry | null;
};

export const PRICE_ROW_SHOWS = ["missing", "tiers", "recurring"] as const;
export type PriceRowShow = (typeof PRICE_ROW_SHOWS)[number];

export function priceRowMatches(r: PriceRow, show: string | undefined): boolean {
  if (show === "missing") return !entryPriced(r.entry);
  if (show === "tiers") return hasTiers(r.entry);
  if (show === "recurring") return hasRecurring(r.entry);
  return true;
}

/** Search by name or code, then the chip (All / Missing price / With tiers / Recurring). */
export function filterPriceRows<R extends PriceRow>(rows: R[], f: { q?: string; show?: string }): R[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter((r) => priceRowMatches(r, f.show) && (!q || r.sku.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q)));
}

/** Counts for the chips. */
export function priceRowCounts(rows: PriceRow[]): Record<"all" | PriceRowShow, number> {
  return {
    all: rows.length,
    missing: rows.filter((r) => priceRowMatches(r, "missing")).length,
    tiers: rows.filter((r) => priceRowMatches(r, "tiers")).length,
    recurring: rows.filter((r) => priceRowMatches(r, "recurring")).length,
  };
}

export const PRICE_ROW_SORTS = ["item", "kind", "one_time", "recurring"] as const;
export type PriceRowSort = (typeof PRICE_ROW_SORTS)[number];

/** Sort keys for the prices table; rows without that price go last. */
export const priceRowSortAccessors: SortAccessors<PriceRow, PriceRowSort> = {
  item: (r) => r.name ?? r.sku,
  kind: (r) => r.kind,
  one_time: (r) => (r.entry?.oneTimeCharged ? r.entry.oneTimeMinor : null),
  recurring: (r) => (r.entry?.recurringCharged ? r.entry.recurringMinor : null),
};

/** "Israel", "Israel and Cyprus", "Israel, Cyprus and Greece". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return t("common.list_and", { first: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

/**
 * Why Delete was refused, in plain words, naming the blocker: every market
 * that sells from the list, or the quotes priced from it. Null for any other reason.
 */
export function deleteRefusalText(reason: string | null | undefined, markets: string[]): string | null {
  if (reason === "in_use") {
    if (markets.length === 0) return t("price_lists.delete.in_use_unknown");
    return t(markets.length === 1 ? "price_lists.delete.in_use" : "price_lists.delete.in_use_many", { markets: joinNames(markets) });
  }
  if (reason === "quoted") return t("price_lists.delete.quoted");
  return null;
}

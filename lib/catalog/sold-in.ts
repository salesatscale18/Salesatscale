/**
 * Catalog "Sold in" column (W2): the markets whose price list prices an item.
 *
 * The rule is the quote rule (lib/quotes/pricing.ts): a market sells from the
 * live version of its price list, and a SKU without an entry there is not sold
 * in that market (not a price of 0). A market without a price list, or whose
 * list has no live version, sells nothing.
 */
import type { Db } from "@/db/types";
import type { Market } from "@/db/schema";
import { livePriceList } from "@/lib/pricing/price-lists";

/** One market and the SKUs its live price list has an entry for. */
export type MarketSkus = { id: string; name: string; skus: ReadonlySet<string> };

/** Each market (in the given order, home first) with the SKUs it sells; one read per price list. */
export async function marketSkus(db: Db, accountId: string, markets: readonly Pick<Market, "id" | "name" | "priceListLineageId">[]): Promise<MarketSkus[]> {
  const lineages = [...new Set(markets.map((m) => m.priceListLineageId).filter((x): x is string => !!x))];
  const lists = new Map(await Promise.all(lineages.map(async (l) => [l, await livePriceList(db, accountId, l)] as const)));
  return markets.map((m) => {
    const live = m.priceListLineageId ? lists.get(m.priceListLineageId) : null;
    return { id: m.id, name: m.name, skus: new Set(live?.entries.map((e) => e.sku) ?? []) };
  });
}

/** The names of the markets that sell this SKU, in market order. */
export function soldIn(sku: string, markets: readonly MarketSkus[]): string[] {
  return markets.filter((m) => m.skus.has(sku)).map((m) => m.name);
}

/**
 * The cell text: "Israel", "Israel, UK", and with more than two "Israel, UK +2".
 * Null when no market sells it (the page shows "Not sold yet" in the warning tone).
 */
export function soldInText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

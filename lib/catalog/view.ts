/**
 * Display helpers for the Catalog list page (setup list-page redesign): the
 * price an item has in the chosen price list, its status, short rule chips,
 * filtering and sorting. Pure; unit-tested in tests/unit/catalog-view.test.ts.
 */
import type { CatalogItem, PriceListEntry } from "@/db/schema";
import { t } from "@/lib/i18n";
import type { SortAccessors } from "@/lib/list-kit";
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import { partState } from "@/lib/pricing/price-lists";
import { unitLabel } from "@/lib/pricing/units";
import type { FitRule } from "./fit";

/** "wireless fridge sensor" → "Wireless fridge sensor" (as on the quote card). */
export const capFirst = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

/**
 * The icon in front of a rule (rules card and item sheet): "plus" adds an
 * item, "link-2" a "needs" rule (as on the board; "check" means Active),
 * "info" advice, "check" a limit.
 */
export function ruleIcon(kind: FitRule["kind"] | AutoAddRule["kind"]): "plus" | "info" | "link-2" | "check" {
  if (kind === "auto_add") return "plus";
  if (kind === "advice") return "info";
  if (kind === "requires") return "link-2";
  return "check";
}

/**
 * An item's price in one price list:
 * - not_priced: the list has no entry for it (not sold there);
 * - price_missing: a charged part has no price yet;
 * - not_charged: neither part is charged;
 * - priced: every charged part has a price.
 */
export type ItemPriceState = "not_priced" | "price_missing" | "not_charged" | "priced";

export function itemPriceState(entry: PriceListEntry | null): ItemPriceState {
  if (!entry) return "not_priced";
  const one = partState(entry, "one_time");
  const rec = partState(entry, "recurring");
  if (one === "price_missing" || rec === "price_missing") return "price_missing";
  if (one === "not_charged" && rec === "not_charged") return "not_charged";
  return "priced";
}

/** The status column: Inactive wins; an active item without a price in the chosen list is "Price missing". */
export type CatalogRowStatus = "active" | "inactive" | "price_missing";

export function itemStatus(active: boolean, price: ItemPriceState | null): CatalogRowStatus {
  if (!active) return "inactive";
  return price === "not_priced" || price === "price_missing" ? "price_missing" : "active";
}

type NameOf = (sku: string) => string | null | undefined;
const nameFor = (sku: string, nameOf: NameOf) => nameOf(sku)?.trim() || sku;
const names = (skus: string[], nameOf: NameOf) => skus.map((s) => nameFor(s, nameOf)).join(t("catalog.rule_chip.or"));

/**
 * Short rule chips for an item row ("Needs Site gateway", "Adds Installation",
 * "Up to 30 per Account", "Advice"), names only: the codes are in the Rules card.
 */
export function itemRuleChips(sku: string, rules: FitRule[], nameOf: NameOf): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (r.kind === "requires" && r.sku === sku) out.push(t("catalog.rule_chip.needs", { items: names(r.oneOf, nameOf) }));
    else if (r.kind === "max_per" && r.sku === sku) out.push(t("catalog.rule_chip.max_per", { max: r.max, items: names(r.perOneOf, nameOf) }));
    else if (r.kind === "auto_add" && r.whenAnyOf.includes(sku)) out.push(t("catalog.rule_chip.adds", { item: nameFor(r.sku, nameOf) }));
    else if (r.kind === "advice" && r.sku === sku) out.push(t("catalog.rule_chip.advice"));
  }
  return [...new Set(out)];
}

/** Every item code a rule names. */
export function ruleSkus(r: FitRule | AutoAddRule): string[] {
  if (r.kind === "requires") return [r.sku, ...r.oneOf];
  if (r.kind === "max_per") return [r.sku, ...r.perOneOf];
  if (r.kind === "auto_add") return [r.sku, ...r.whenAnyOf];
  return r.sku ? [r.sku] : [];
}

/** The rules that name this item (the sheet's "Rules with this item"). */
export function rulesMentioning<R extends { rule: FitRule | AutoAddRule }>(sku: string, rules: R[]): R[] {
  return rules.filter((r) => ruleSkus(r.rule).includes(sku));
}

export type CatalogRow = {
  item: CatalogItem;
  /** The item's entry in the chosen price list (null: not sold there, or no list). */
  entry: PriceListEntry | null;
  /** Null when there is no price list to show prices from. */
  price: ItemPriceState | null;
  status: CatalogRowStatus;
  chips: string[];
};

export function catalogRows(items: CatalogItem[], entries: PriceListEntry[] | null, rules: FitRule[]): CatalogRow[] {
  const bySku = new Map((entries ?? []).map((e) => [e.sku, e]));
  const names = new Map(items.map((i) => [i.sku, i.name]));
  return items.map((item) => {
    const entry = bySku.get(item.sku) ?? null;
    const price = entries ? itemPriceState(entry) : null;
    return { item, entry, price, status: itemStatus(item.active, price), chips: itemRuleChips(item.sku, rules, (s) => names.get(s)) };
  });
}

export const CATALOG_KINDS = ["product", "service"] as const;
export const CATALOG_STATUSES = ["active", "inactive", "price_missing"] as const;
export type CatalogFilter = { q?: string; kind?: string; status?: string };

/** Search (name, chat name or code), kind chip and status filter. */
export function filterCatalogRows(rows: CatalogRow[], f: CatalogFilter): CatalogRow[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind && (r.item.kind ?? "product") !== f.kind) return false;
    if (f.status && r.status !== f.status) return false;
    if (!q) return true;
    return [r.item.name, r.item.sku, r.item.plainName ?? ""].some((s) => s.toLowerCase().includes(q));
  });
}

export const CATALOG_SORTS = ["name", "code", "kind", "charged", "price", "status"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

const STATUS_ORDER: Record<CatalogRowStatus, number> = { price_missing: 0, active: 1, inactive: 2 };

/** Sort keys for sortRows. Price sorts by the one-time price, then the recurring one; unpriced rows go last. */
export const catalogSortAccessors: SortAccessors<CatalogRow, CatalogSort> = {
  name: (r) => r.item.name,
  code: (r) => r.item.sku,
  kind: (r) => r.item.kind ?? "product",
  charged: (r) => unitLabel(r.item.unit, r.item.unitCustom, "en", 1),
  price: (r) => (r.price === "priced" || r.price === "not_charged" ? (r.entry?.oneTimeMinor ?? 0) * 1e6 + (r.entry?.recurringMinor ?? 0) : null),
  status: (r) => STATUS_ORDER[r.status],
};

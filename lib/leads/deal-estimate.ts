/**
 * Deal size estimate (owner approved, 22 Nov): for a lead without a quote, an
 * estimate from the deal-state fields the agent already saved (number of
 * sites, a count of units, the products of interest) priced with the lead
 * market's price list, through the same helpers create_quote and check_fit
 * use (lib/catalog/fit.ts checkFit, lib/pricing/engine.ts priceWithList with
 * the catalog's "Add automatically with" rules). No model call, nothing stored.
 *
 * Display only (UX, MVP): shown muted as "≈ ₪3,500 est.", never in green and
 * never added into any total, sum or KPI. With too little data: no estimate.
 *
 * How deal fields map to products (`estimateDeal`, pure):
 * - Sites: a field named for sites (site, location, branch, store, outlet,
 *   venue) whose value starts with a whole number.
 * - Products of interest: a field named for products or interest; the items
 *   its text names (SKU, name or chat name) are the only ones estimated.
 * - A count per item: a field whose name shares a word with the item's unit
 *   (users / seats, devices, licences, a custom unit's name), its SKU, or a
 *   word of its name or chat name ("Number of sensors" → the sensor), with a
 *   value that starts with a whole number.
 * - Items charged per site: the site count. Without a products field this is
 *   used only when exactly one product is charged per site (else it is
 *   ambiguous which one).
 * - Then the fit rules' fixes add what the quoted items require (one gateway
 *   per site), and the auto-add rules add their lines (installation per site).
 * Order-form fields (company details) are never read. A price still missing
 * in the price list, or a set the engine refuses, gives no estimate.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { dealStates, type DealFieldValue, type PlaybookField, type RecurringPeriod } from "@/db/schema";
import { checkFit, type FitRule } from "@/lib/catalog/fit";
import { MAX_QTY } from "@/lib/catalog/pricing";
import { publishedCatalog } from "@/lib/catalog/service";
import { currentPlaybook } from "@/lib/agent/service";
import { isReservedFieldKey } from "@/lib/agent/core/facts";
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import { priceWithList, type EngineEntry, type EngineItem, type EnginePriceList } from "@/lib/pricing/engine";
import { catalogAutoAdd, engineItems, enginePriceList, pricingContext, type PublishedCatalog } from "@/lib/quotes/pricing";

export type DealEstimate = {
  currency: string;
  /** The one-time total, on the same basis as a quote's one-time total. */
  oneTimeMinor: number;
  recurringMinor: number;
  recurringPeriod: RecurringPeriod | null;
};

export type EstimateItem = EngineItem & { plainName?: string | null; unitCustom?: Record<string, { one: string; other: string }> | null };

export type EstimateInput = {
  /** The playbook's deal fields (labels and stages); fields missing here are read by key only. */
  fields: Pick<PlaybookField, "key" | "label" | "stage">[];
  values: Record<string, Pick<DealFieldValue, "value">>;
  items: EstimateItem[];
  rules: FitRule[];
  autoAdd: AutoAddRule[];
  priceList: { list: EnginePriceList; entries: EngineEntry[] } | null;
};

const SITE_WORDS = new Set(["site", "location", "branch", "store", "outlet", "venue"]);
const INTEREST_WORDS = new Set(["product", "interest", "interested", "solution"]);
const UNIT_WORDS: Record<string, string[]> = {
  user: ["user", "seat"], device: ["device"], licence: ["licence", "license"],
};
/** Words too general to tie a field to an item. */
const STOP = new Set([
  "wireless", "site", "with", "from", "plan", "basic", "standard", "premium", "monthly", "annual", "yearly", "service", "pack", "package",
  "the", "and", "for", "per", "number", "count", "total", "item", "unit", "your", "their", "they", "today", "current", "how", "many", "much",
]);

const singular = (w: string) => (w.length > 4 && w.endsWith("es") && /(ches|shes|sses|xes)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string | null | undefined) => (s ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(singular);

/**
 * A count: a value that is a whole number, with at most two words after it
 * ("4", "about 15", "12 fridges", "1,200", "15-20" → 15); null for anything
 * else, such as "2 times a day on paper".
 */
export function countOf(raw: string | null | undefined): number | null {
  const v = String(raw ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const m = /^\s*(?:about|around|approx(?:imately)?\.?|roughly|~)?\s*(\d{1,6})(?:\s*[-–]\s*\d{1,6})?(?:\s+\p{L}+){0,2}\s*[.!]?\s*$/iu.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= MAX_QTY ? n : null;
}

function itemWords(i: EstimateItem): Set<string> {
  const out = new Set<string>();
  for (const w of [...words(i.name), ...words(i.plainName)]) if (w.length >= 4 && !STOP.has(w)) out.add(w);
  for (const w of words(i.sku)) if (w.length >= 3 && !/^\d+$/.test(w)) out.add(w);
  for (const w of UNIT_WORDS[i.unit] ?? []) out.add(w);
  if (i.unit === "custom" && i.unitCustom) for (const f of Object.values(i.unitCustom)) for (const w of [...words(f.one), ...words(f.other)]) if (!STOP.has(w)) out.add(w);
  return out;
}

const mentions = (text: string, phrase: string | null | undefined) => {
  const p = (phrase ?? "").trim().toLowerCase();
  return p.length >= 2 && text.includes(p);
};

/** The estimate for one lead, or null when the deal fields say too little (pure). */
export function estimateDeal(i: EstimateInput): DealEstimate | null {
  if (!i.priceList) return null;
  const meta = new Map(i.fields.map((f) => [f.key, f]));
  const keys = new Set([...i.fields.map((f) => f.key), ...Object.keys(i.values)]);
  const fields = [...keys]
    .filter((k) => !isReservedFieldKey(k) && meta.get(k)?.stage !== "before_order_form")
    .map((k) => ({ key: k, words: new Set([...words(k.replace(/_/g, " ")), ...words(meta.get(k)?.label)]), value: String(i.values[k]?.value ?? "").trim() }))
    .filter((f) => f.value);
  if (fields.length === 0) return null;

  const sold = new Set(i.priceList.entries.map((e) => e.sku));
  const autoTargets = new Set(i.autoAdd.map((r) => r.sku));
  const usable = i.items.filter((it) => it.active && sold.has(it.sku));
  const usableBySku = new Map(usable.map((it) => [it.sku, it]));

  const siteField = fields.find((f) => [...f.words].some((w) => SITE_WORDS.has(w)) && countOf(f.value) !== null);
  const sites = siteField ? countOf(siteField.value)! : undefined;

  const interest = new Set<string>();
  for (const f of fields) {
    if (![...f.words].some((w) => INTEREST_WORDS.has(w))) continue;
    const text = f.value.toLowerCase();
    for (const it of usable) if (mentions(text, it.sku) || mentions(text, it.name) || mentions(text, it.plainName)) interest.add(it.sku);
  }

  const lines = new Map<string, number>();
  const perSiteProducts = usable.filter((it) => it.unit === "site" && (it.kind ?? "product") === "product" && !autoTargets.has(it.sku));
  for (const it of usable) {
    if (autoTargets.has(it.sku)) continue;
    if (interest.size && !interest.has(it.sku)) continue;
    const own = itemWords(it);
    const counted = fields.find((f) => f !== siteField && [...f.words].some((w) => own.has(w)) && countOf(f.value) !== null);
    if (counted) { lines.set(it.sku, countOf(counted.value)!); continue; }
    if (it.unit === "site" && sites !== undefined) {
      const clear = interest.has(it.sku) || (!interest.size && perSiteProducts.length === 1 && perSiteProducts[0].sku === it.sku);
      if (clear) lines.set(it.sku, sites);
    }
  }
  if (lines.size === 0) return null;

  // What the quoted items require (check_fit's one-click fixes: one gateway per site, and so on).
  for (let round = 0; round < 4; round++) {
    const fit = checkFit(i.rules, [...lines].map(([sku, qty]) => ({ sku, qty })), sites);
    const fixes = fit.fixes.filter((f): f is NonNullable<typeof f> => !!f && usableBySku.has(f.sku) && !autoTargets.has(f.sku));
    if (fixes.length === 0) break;
    for (const f of fixes) lines.set(f.sku, Math.min(MAX_QTY, (lines.get(f.sku) ?? 0) + f.add));
  }

  const r = priceWithList({
    items: i.items, entries: i.priceList.entries, priceList: i.priceList.list,
    lines: [...lines].map(([sku, qty]) => ({ sku, qty })), sites, discountBp: 0, maxDiscountBp: 10_000, autoAdd: i.autoAdd,
  });
  if (!r.ok || !r.complete) return null;
  if (r.oneTime.totalMinor <= 0 && r.recurring.totalMinor <= 0) return null;
  return { currency: r.currency, oneTimeMinor: r.oneTime.totalMinor, recurringMinor: r.recurring.totalMinor, recurringPeriod: r.recurringPeriod };
}

/** Catalog items as the estimator needs them. */
function estimateItems(catalog: PublishedCatalog): EstimateItem[] {
  const plain = new Map(catalog.items.map((c) => [c.sku, c]));
  return engineItems(catalog).map((e) => {
    const c = plain.get(e.sku) as { plainName?: string | null; unitCustom?: EstimateItem["unitCustom"] } | undefined;
    return { ...e, plainName: c?.plainName ?? null, unitCustom: c?.unitCustom ?? null };
  });
}

/**
 * Estimates for the given leads (those without a quote), in a fixed number of
 * reads: the playbook, the published catalog, the leads' deal states, and one
 * pricing context per market. Every read is scoped by account id. Leads with
 * too little data are left out of the map.
 */
export async function dealEstimates(db: Db, accountId: string, leads: readonly { id: string; marketId: string | null }[]): Promise<Map<string, DealEstimate>> {
  const out = new Map<string, DealEstimate>();
  if (leads.length === 0) return out;
  const ids = [...new Set(leads.map((l) => l.id))];
  const [playbook, catalog, states] = await Promise.all([
    currentPlaybook(db, accountId),
    publishedCatalog(db, accountId),
    db.select({ leadId: dealStates.leadId, fields: dealStates.fields }).from(dealStates).where(and(eq(dealStates.accountId, accountId), inArray(dealStates.leadId, ids))),
  ]);
  if (!catalog) return out;
  const valuesOf = new Map(states.map((s) => [s.leadId, s.fields ?? {}]));
  const withData = leads.filter((l) => Object.keys(valuesOf.get(l.id) ?? {}).length > 0);
  if (withData.length === 0) return out;
  const marketIds = [...new Set(withData.map((l) => l.marketId ?? ""))];
  const contexts = new Map(await Promise.all(marketIds.map(async (m) => [m, await pricingContext(db, accountId, m || null, { catalog })] as const)));
  const items = estimateItems(catalog);
  const autoAdd = catalogAutoAdd(catalog);
  for (const l of withData) {
    const ctx = contexts.get(l.marketId ?? "");
    const pl = ctx?.priceList;
    const est = estimateDeal({
      fields: playbook?.fields ?? [], values: valuesOf.get(l.id) ?? {}, items, rules: catalog.rules, autoAdd,
      priceList: pl ? { list: enginePriceList(pl.list), entries: pl.entries } : null,
    });
    if (est) out.set(l.id, est);
  }
  return out;
}

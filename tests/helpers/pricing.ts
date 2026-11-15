/**
 * Test seeding for price-list pricing (mvp-plan 3.13): a published catalog
 * (items hold no price) and a live price list assigned to a market.
 */
import { randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import { catalogItems, catalogVersions, fitRules, type RecurringPeriod, type UnitCustom, type VolumeTier } from "@/db/schema";
import { ensureHomeMarket, setMarketPriceList } from "@/lib/markets/service";
import { createPriceList, publish, removeEntry, setEntry, type EntryInput } from "@/lib/pricing/price-lists";
import type { TestDb } from "./db";

export type SeedItem = { sku: string; name: string; unit?: string; kind?: "product" | "service"; unitCustom?: UnitCustom | null; active?: boolean };

/** Publishes a catalog version with these items and rules (raw jsonb), archiving the previous one. */
export async function seedCatalog(db: TestDb, accountId: string, items: SeedItem[], rules: Record<string, unknown>[] = []) {
  const [{ top }] = await db.select({ top: max(catalogVersions.version) }).from(catalogVersions).where(eq(catalogVersions.accountId, accountId));
  await db.update(catalogVersions).set({ status: "archived" }).where(and(eq(catalogVersions.accountId, accountId), eq(catalogVersions.status, "published")));
  const id = randomUUID();
  await db.insert(catalogVersions).values({ id, accountId, version: (top ?? 0) + 1, status: "published", publishedAt: new Date() });
  for (const [i, it] of items.entries()) {
    await db.insert(catalogItems).values({
      id: randomUUID(), accountId, catalogVersionId: id, sku: it.sku, name: it.name, unit: it.unit ?? "item", kind: it.kind ?? "product",
      unitCustom: it.unitCustom ?? null, active: it.active ?? true, chargeType: "one_time", sortOrder: i,
    });
  }
  for (const [i, rule] of rules.entries()) await db.insert(fitRules).values({ id: randomUUID(), accountId, catalogVersionId: id, rule, sortOrder: i });
  return id;
}

/** A price list entry in short form. Amounts in minor units; omit a charge for "not charged". */
export type SeedEntry = {
  sku: string;
  oneTime?: number | null;
  recurring?: number | null;
  period?: RecurringPeriod;
  oneTimeTiers?: VolumeTier[];
  recurringTiers?: VolumeTier[];
  customFrom?: number | null;
};

const entryInput = (e: SeedEntry): EntryInput => ({
  sku: e.sku,
  oneTimeCharged: e.oneTime !== undefined,
  oneTimeMinor: e.oneTime ?? null,
  oneTimeTiers: e.oneTimeTiers ?? [],
  recurringCharged: e.recurring !== undefined,
  recurringMinor: e.recurring ?? null,
  recurringPeriod: e.recurring !== undefined ? e.period ?? "month" : null,
  recurringTiers: e.recurringTiers ?? [],
  customPricingFromQty: e.customFrom ?? null,
});

export type SeedPricingOptions = { name?: string; currency?: string; pricesIncludeTax?: boolean; taxRateBp?: number; marketId?: string; userId?: string | null };

/**
 * Creates and publishes a price list with these entries and assigns it to a
 * market (the home market by default). Returns the lineage id and live version.
 */
export async function seedPricing(db: TestDb, accountId: string, entries: SeedEntry[], opts: SeedPricingOptions = {}) {
  const actor = { userId: opts.userId ?? null, actingAs: false };
  const created = await createPriceList(db, actor, accountId, {
    name: opts.name ?? "Price list", currency: opts.currency ?? "ILS", pricesIncludeTax: opts.pricesIncludeTax ?? true, taxRateBp: opts.taxRateBp ?? 1800,
  });
  if (!created.ok) throw new Error(created.error);
  const lineageId = created.list.lineageId;
  for (const e of entries) {
    const r = await setEntry(db, actor, accountId, lineageId, entryInput(e));
    if (!r.ok) throw new Error(`${e.sku}: ${r.error}`);
  }
  const published = await publish(db, actor, accountId, lineageId);
  if (!published.ok) throw new Error(JSON.stringify(published));
  const marketId = opts.marketId ?? (await ensureHomeMarket(db, accountId))!.id;
  const set = await setMarketPriceList(db, actor, accountId, marketId, lineageId);
  if (!set.ok) throw new Error(JSON.stringify(set.errors));
  return { lineageId, list: published.list, marketId };
}

/** Publishes a new version of a price list: entries are set (or, with `remove`, removed) on a new draft. */
export async function republishPricing(db: TestDb, accountId: string, lineageId: string, entries: SeedEntry[], remove: string[] = []) {
  const actor = { userId: null, actingAs: false };
  for (const e of entries) {
    const r = await setEntry(db, actor, accountId, lineageId, entryInput(e));
    if (!r.ok) throw new Error(`${e.sku}: ${r.error}`);
  }
  for (const sku of remove) await removeEntry(db, actor, accountId, lineageId, sku);
  const published = await publish(db, actor, accountId, lineageId);
  if (!published.ok) throw new Error(JSON.stringify(published));
  return published.list;
}

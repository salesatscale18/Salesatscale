/**
 * Versioned catalog (implementation plan P3.1, P3.4). One draft and one
 * published version per account; publishing archives the old one. Every
 * function is scoped by account id.
 */
import { tierProblem } from "./rules";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, max } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { catalogItems, catalogVersions, fitRules, type CatalogItem, type CatalogVersion } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { parseFitRule, type FitRule } from "./fit";
import type { CatalogItemInput } from "./rules";

async function versionByStatus(db: Db, accountId: string, status: "draft" | "published") {
  const [v] = await db.select().from(catalogVersions).where(and(eq(catalogVersions.accountId, accountId), eq(catalogVersions.status, status)));
  return v ?? null;
}

export async function itemsOf(db: Db, accountId: string, versionId: string) {
  return db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.accountId, accountId), eq(catalogItems.catalogVersionId, versionId)))
    .orderBy(asc(catalogItems.sortOrder), asc(catalogItems.sku));
}

export async function rulesOf(db: Db, accountId: string, versionId: string) {
  const rows = await db
    .select()
    .from(fitRules)
    .where(and(eq(fitRules.accountId, accountId), eq(fitRules.catalogVersionId, versionId)))
    .orderBy(asc(fitRules.sortOrder));
  return rows.flatMap((r) => {
    const rule = parseFitRule(r.rule);
    return rule ? [{ id: r.id, rule }] : [];
  });
}

/** The published catalog the quote engine prices from, or null if none is published. */
export async function publishedCatalog(db: Db, accountId: string) {
  const version = await versionByStatus(db, accountId, "published");
  if (!version) return null;
  const [items, rules] = await Promise.all([itemsOf(db, accountId, version.id), rulesOf(db, accountId, version.id)]);
  return { version, items, rules: rules.map((r) => r.rule) };
}

/** Returns the draft, creating it (as a copy of the published version) when needed. */
export async function ensureDraft(db: Db, accountId: string): Promise<CatalogVersion> {
  const existing = await versionByStatus(db, accountId, "draft");
  if (existing) return existing;
  const published = await versionByStatus(db, accountId, "published");
  const [{ top }] = await db.select({ top: max(catalogVersions.version) }).from(catalogVersions).where(eq(catalogVersions.accountId, accountId));
  const id = randomUUID();
  const [items, rules] = published ? await Promise.all([itemsOf(db, accountId, published.id), rulesOf(db, accountId, published.id)]) : [[], []];
  try {
    await atomic(db, (q) => [
      q.insert(catalogVersions).values({
        id,
        accountId,
        version: (top ?? 0) + 1,
        status: "draft",
        pricesIncludeTax: published?.pricesIncludeTax ?? true,
        taxRateBp: published?.taxRateBp ?? 0,
      }),
      ...items.map((i) => q.insert(catalogItems).values({ ...i, id: randomUUID(), catalogVersionId: id })),
      ...rules.map((r, n) => q.insert(fitRules).values({ id: randomUUID(), accountId, catalogVersionId: id, rule: r.rule, sortOrder: n })),
    ]);
  } catch (e) {
    // Two requests created the draft at once: use the one that won.
    const winner = await versionByStatus(db, accountId, "draft");
    if (winner) return winner;
    throw e;
  }
  return (await versionByStatus(db, accountId, "draft"))!;
}

export type CatalogState = {
  published: CatalogVersion | null;
  draft: CatalogVersion | null;
  /** What the editor shows: the draft if there is one, else the published version. */
  items: CatalogItem[];
  rules: { id: string; rule: FitRule }[];
  /** Number of items added, changed or removed in the draft. */
  draftChanges: number;
};

const itemKey = (i: CatalogItem) =>
  JSON.stringify([i.name, i.description, i.chargeType, i.period, i.unit, i.priceMinor, i.volumeTiers, i.customPricingFromQty, i.active, i.availabilityNote]);

export async function catalogState(db: Db, accountId: string): Promise<CatalogState> {
  const [published, draft] = await Promise.all([versionByStatus(db, accountId, "published"), versionByStatus(db, accountId, "draft")]);
  const shown = draft ?? published;
  if (!shown) return { published: null, draft: null, items: [], rules: [], draftChanges: 0 };
  const [items, rules] = await Promise.all([itemsOf(db, accountId, shown.id), rulesOf(db, accountId, shown.id)]);
  let draftChanges = 0;
  if (draft) {
    const [pubItems, pubRules] = published ? await Promise.all([itemsOf(db, accountId, published.id), rulesOf(db, accountId, published.id)]) : [[], []];
    const pub = new Map(pubItems.map((i) => [i.sku, itemKey(i)]));
    const cur = new Map(items.map((i) => [i.sku, itemKey(i)]));
    for (const [sku, k] of cur) if (pub.get(sku) !== k) draftChanges++;
    for (const sku of pub.keys()) if (!cur.has(sku)) draftChanges++;
    const ruleSet = (rs: { rule: FitRule }[]) => rs.map((r) => JSON.stringify(r.rule)).sort().join("|");
    if (ruleSet(rules) !== ruleSet(pubRules)) draftChanges++;
    if (published && (published.taxRateBp !== draft.taxRateBp || published.pricesIncludeTax !== draft.pricesIncludeTax)) draftChanges++;
  }
  return { published, draft, items, rules, draftChanges };
}

export type ItemSaveResult = { ok: true; item: CatalogItem } | { ok: false; reason: "sku_taken" | "not_found" };

/** Adds or updates an item in the draft. `itemId` must be a draft item of this account. */
export async function saveDraftItem(db: Db, accountId: string, input: CatalogItemInput, itemId?: string): Promise<ItemSaveResult> {
  const draft = await ensureDraft(db, accountId);
  const items = await itemsOf(db, accountId, draft.id);
  const clash = items.find((i) => i.sku === input.sku && i.id !== itemId);
  if (clash) return { ok: false, reason: "sku_taken" };
  if (itemId) {
    const [row] = await db
      .update(catalogItems)
      .set(input)
      .where(and(eq(catalogItems.id, itemId), eq(catalogItems.accountId, accountId), eq(catalogItems.catalogVersionId, draft.id)))
      .returning();
    return row ? { ok: true, item: row } : { ok: false, reason: "not_found" };
  }
  const [row] = await db
    .insert(catalogItems)
    .values({ ...input, id: randomUUID(), accountId, catalogVersionId: draft.id, sortOrder: items.length })
    .returning();
  return { ok: true, item: row };
}

/**
 * Editing a published item means editing its copy in the draft. Resolves an
 * item id from the shown version to the matching draft item (same SKU).
 */
export async function draftItemIdFor(db: Db, accountId: string, itemId: string): Promise<string | null> {
  const [item] = await db.select().from(catalogItems).where(and(eq(catalogItems.id, itemId), eq(catalogItems.accountId, accountId)));
  if (!item) return null;
  const draft = await ensureDraft(db, accountId);
  if (item.catalogVersionId === draft.id) return item.id;
  const [copy] = await db
    .select({ id: catalogItems.id })
    .from(catalogItems)
    .where(and(eq(catalogItems.catalogVersionId, draft.id), eq(catalogItems.sku, item.sku)));
  return copy?.id ?? null;
}

export async function removeDraftItem(db: Db, accountId: string, itemId: string) {
  const id = await draftItemIdFor(db, accountId, itemId);
  if (!id) return false;
  await db.delete(catalogItems).where(and(eq(catalogItems.id, id), eq(catalogItems.accountId, accountId)));
  return true;
}

export async function addDraftRule(db: Db, accountId: string, rule: FitRule) {
  const draft = await ensureDraft(db, accountId);
  const existing = await rulesOf(db, accountId, draft.id);
  await db.insert(fitRules).values({ id: randomUUID(), accountId, catalogVersionId: draft.id, rule, sortOrder: existing.length });
}

/** Removes a rule; a published rule is removed from the draft copy (matched by content). */
export async function removeDraftRule(db: Db, accountId: string, ruleId: string) {
  const [row] = await db.select().from(fitRules).where(and(eq(fitRules.id, ruleId), eq(fitRules.accountId, accountId)));
  if (!row) return false;
  const draft = await ensureDraft(db, accountId);
  const target =
    row.catalogVersionId === draft.id
      ? row.id
      : (await rulesOf(db, accountId, draft.id)).find((r) => JSON.stringify(r.rule) === JSON.stringify(parseFitRule(row.rule)))?.id;
  if (!target) return false;
  await db.delete(fitRules).where(and(eq(fitRules.id, target), eq(fitRules.accountId, accountId)));
  return true;
}

export async function saveDraftSettings(db: Db, accountId: string, settings: { pricesIncludeTax: boolean; taxRateBp: number }) {
  const draft = await ensureDraft(db, accountId);
  await db.update(catalogVersions).set(settings).where(and(eq(catalogVersions.id, draft.id), eq(catalogVersions.accountId, accountId)));
}

export type PublishResult = { ok: true; version: number } | { ok: false; reason: "no_draft" | "no_active_items" | "invalid_tiers"; skus?: string[] };

/** Publishes the draft: the old published version is archived in the same transaction. */
export async function publishDraft(db: Db, actor: Actor, accountId: string, now = new Date()): Promise<PublishResult> {
  const draft = await versionByStatus(db, accountId, "draft");
  if (!draft) return { ok: false, reason: "no_draft" };
  const items = await itemsOf(db, accountId, draft.id);
  if (!items.some((i) => i.active)) return { ok: false, reason: "no_active_items" };
  const bad = items.filter((i) => tierProblem(i.priceMinor, i.volumeTiers, i.customPricingFromQty)).map((i) => i.sku);
  if (bad.length) return { ok: false, reason: "invalid_tiers", skus: bad };
  await atomic(db, (q) => [
    q.update(catalogVersions).set({ status: "archived" }).where(and(eq(catalogVersions.accountId, accountId), eq(catalogVersions.status, "published"))),
    q.update(catalogVersions)
      .set({ status: "published", publishedAt: now, publishedByUserId: actor.userId })
      .where(and(eq(catalogVersions.id, draft.id), eq(catalogVersions.status, "draft"))),
  ]);
  await writeAudit(db, actor, { accountId, action: "catalog.published", targetType: "catalog_version", targetId: draft.id, details: { version: draft.version, items: items.length } });
  return { ok: true, version: draft.version };
}

/** Throws away the draft (back to the published version). */
export async function discardDraft(db: Db, accountId: string) {
  await db.delete(catalogVersions).where(and(eq(catalogVersions.accountId, accountId), eq(catalogVersions.status, "draft")));
}

export async function catalogVersionsList(db: Db, accountId: string) {
  return db.select().from(catalogVersions).where(eq(catalogVersions.accountId, accountId)).orderBy(desc(catalogVersions.version));
}

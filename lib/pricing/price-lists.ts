/**
 * Versioned price lists (mvp-plan 3.13). A price list is a lineage of
 * versions: at most one draft and one live version at a time (unique partial
 * indexes), and publishing archives the previous live version. Every function
 * is scoped by account id; every write is audited.
 *
 * Entry semantics: a SKU without an entry is "Not sold" in the list. Per part
 * (one-time, recurring), charged=false means the part is not charged, and
 * charged=true with no price means "Price missing", which blocks publishing.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, max, ne } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { markets, priceListEntries, priceLists, quoteVersions, type PriceList, type PriceListEntry, type RecurringPeriod, type VolumeTier } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { tierProblem } from "@/lib/catalog/rules";
import { adjustMinor, adjustmentRatio, minorDigits, ROUNDINGS, type Rounding } from "./adjust";

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

export type PriceListMetaInput = {
  name: string;
  currency: string;
  pricesIncludeTax: boolean;
  taxRateBp: number;
  /** YYYY-MM-DD, or null. */
  validFrom?: string | null;
};

export type EntryInput = {
  sku: string;
  oneTimeCharged: boolean;
  oneTimeMinor: number | null;
  oneTimeTiers?: VolumeTier[];
  recurringCharged: boolean;
  recurringMinor: number | null;
  /** Defaults to "month" when the recurring part is charged. */
  recurringPeriod?: RecurringPeriod | null;
  recurringTiers?: VolumeTier[];
  customPricingFromQty?: number | null;
};

type NormalEntry = Omit<PriceListEntry, "id" | "accountId" | "priceListId">;

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MAX_MINOR = 2_147_483_647;
const isMinor = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_MINOR;

export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function isCurrency(v: string): boolean {
  if (!/^[A-Z]{3}$/.test(v)) return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: v });
    return true;
  } catch {
    return false;
  }
}

export function metaProblem(m: Partial<PriceListMetaInput>): string | null {
  if (m.name !== undefined && (!m.name.trim() || m.name.trim().length > 80)) return "Enter a name of up to 80 characters.";
  if (m.currency !== undefined && !isCurrency(m.currency)) return "Choose a currency.";
  if (m.taxRateBp !== undefined && (!Number.isInteger(m.taxRateBp) || m.taxRateBp < 0 || m.taxRateBp > 10_000)) return "Tax rate must be between 0% and 100%.";
  if (m.validFrom !== undefined && m.validFrom !== null && !isIsoDate(m.validFrom)) return "Enter the date as YYYY-MM-DD.";
  return null;
}

function validTiers(tiers: unknown): tiers is VolumeTier[] {
  if (!Array.isArray(tiers)) return false;
  const qtys = new Set<number>();
  for (const t of tiers) {
    if (!t || typeof t !== "object") return false;
    const { minQty, priceMinor } = t as VolumeTier;
    if (!Number.isSafeInteger(minQty) || minQty < 2 || qtys.has(minQty) || !isMinor(priceMinor)) return false;
    qtys.add(minQty);
  }
  return true;
}

/**
 * Checks an entry's shape and normalizes it: a part that is not charged keeps
 * no price and no tiers. Tier order rules are checked on publish.
 */
export function normalizeEntry(e: EntryInput): { ok: true; value: NormalEntry } | { ok: false; error: string } {
  const sku = typeof e.sku === "string" ? e.sku.trim().toUpperCase() : "";
  if (!SKU.test(sku)) return { ok: false, error: "Use 1–40 letters, digits, dots, dashes or underscores for the SKU." };
  const oneTimeTiers = e.oneTimeTiers ?? [];
  const recurringTiers = e.recurringTiers ?? [];
  if (e.oneTimeMinor !== null && !isMinor(e.oneTimeMinor)) return { ok: false, error: "The one-time price must be zero or more." };
  if (e.recurringMinor !== null && !isMinor(e.recurringMinor)) return { ok: false, error: "The recurring price must be zero or more." };
  if (!validTiers(oneTimeTiers) || !validTiers(recurringTiers)) return { ok: false, error: "Each tier needs a quantity of 2 or more, used once, and a price." };
  const from = e.customPricingFromQty ?? null;
  if (from !== null && (!Number.isSafeInteger(from) || from < 1)) return { ok: false, error: "Custom pricing starts at a whole number of 1 or more." };
  const period = e.recurringPeriod ?? "month";
  if (period !== "month" && period !== "year") return { ok: false, error: "Recurring prices are per month or per year." };
  const sort = (t: VolumeTier[]) => [...t].sort((a, b) => a.minQty - b.minQty);
  return {
    ok: true,
    value: {
      sku,
      oneTimeCharged: e.oneTimeCharged,
      oneTimeMinor: e.oneTimeCharged ? e.oneTimeMinor : null,
      oneTimeTiers: e.oneTimeCharged ? sort(oneTimeTiers) : [],
      recurringCharged: e.recurringCharged,
      recurringMinor: e.recurringCharged ? e.recurringMinor : null,
      recurringPeriod: e.recurringCharged ? period : null,
      recurringTiers: e.recurringCharged ? sort(recurringTiers) : [],
      customPricingFromQty: from,
    },
  };
}

export type EntryProblem = { sku: string; charge: "one_time" | "recurring"; kind: "price_missing" | "tiers"; message: string };

/** What blocks publishing an entry: missing prices, and tiers that break the catalog tier rule. */
export function entryProblems(e: NormalEntry): EntryProblem[] {
  const out: EntryProblem[] = [];
  const parts = [
    { charge: "one_time" as const, charged: e.oneTimeCharged, price: e.oneTimeMinor, tiers: e.oneTimeTiers, label: "one-time" },
    { charge: "recurring" as const, charged: e.recurringCharged, price: e.recurringMinor, tiers: e.recurringTiers, label: "recurring" },
  ];
  for (const p of parts) {
    if (!p.charged) continue;
    if (p.price === null) {
      out.push({ sku: e.sku, charge: p.charge, kind: "price_missing", message: `${e.sku}: the ${p.label} price is missing.` });
      continue;
    }
    const problem = tierProblem(p.price, p.tiers, e.customPricingFromQty);
    if (problem) out.push({ sku: e.sku, charge: p.charge, kind: "tiers", message: `${e.sku} (${p.label}): ${problem}` });
  }
  return out;
}

/** Display state of one part of an entry (canvas: PriceLists). */
export function partState(e: Pick<PriceListEntry, "oneTimeCharged" | "oneTimeMinor" | "recurringCharged" | "recurringMinor"> | null, charge: "one_time" | "recurring"): "not_sold" | "not_charged" | "price_missing" | "priced" {
  if (!e) return "not_sold";
  const charged = charge === "one_time" ? e.oneTimeCharged : e.recurringCharged;
  const price = charge === "one_time" ? e.oneTimeMinor : e.recurringMinor;
  if (!charged) return "not_charged";
  return price === null ? "price_missing" : "priced";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function versionOf(db: Db, accountId: string, lineageId: string, status: "draft" | "live") {
  const [v] = await db
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId), eq(priceLists.status, status)));
  return v ?? null;
}

export async function entriesOf(db: Db, accountId: string, priceListId: string): Promise<PriceListEntry[]> {
  return db
    .select()
    .from(priceListEntries)
    .where(and(eq(priceListEntries.accountId, accountId), eq(priceListEntries.priceListId, priceListId)))
    .orderBy(asc(priceListEntries.sku));
}

/** One version by id (any status), with its entries. Quotes use this for the version they froze. */
export async function priceListVersion(db: Db, accountId: string, priceListId: string) {
  const [list] = await db.select().from(priceLists).where(and(eq(priceLists.id, priceListId), eq(priceLists.accountId, accountId)));
  if (!list) return null;
  return { list, entries: await entriesOf(db, accountId, list.id) };
}

/** The live version of a price list, with its entries; null if it has never been published. */
export async function livePriceList(db: Db, accountId: string, lineageId: string) {
  const list = await versionOf(db, accountId, lineageId, "live");
  if (!list) return null;
  return { list, entries: await entriesOf(db, accountId, list.id) };
}

export type PriceListSummary = {
  lineageId: string;
  /** The draft if there is one, else the live version: what the editor shows. */
  shown: PriceList;
  live: PriceList | null;
  draft: PriceList | null;
  entryCount: number;
  missingPrices: number;
  /** Markets that sell from this price list. */
  usedBy: { id: string; name: string }[];
};

/** Every price list of the account that has a draft or a live version. */
export async function listPriceLists(db: Db, accountId: string): Promise<PriceListSummary[]> {
  const rows = await db
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.accountId, accountId), ne(priceLists.status, "archived")))
    .orderBy(asc(priceLists.createdAt));
  if (rows.length === 0) return [];
  const byLineage = new Map<string, { live: PriceList | null; draft: PriceList | null }>();
  for (const r of rows) {
    const e = byLineage.get(r.lineageId) ?? { live: null, draft: null };
    if (r.status === "live") e.live = r;
    else e.draft = r;
    byLineage.set(r.lineageId, e);
  }
  const shownIds = [...byLineage.values()].map((v) => (v.draft ?? v.live)!.id);
  const [entries, ms] = await Promise.all([
    db.select().from(priceListEntries).where(and(eq(priceListEntries.accountId, accountId), inArray(priceListEntries.priceListId, shownIds))),
    db.select({ id: markets.id, name: markets.name, lineageId: markets.priceListLineageId }).from(markets).where(eq(markets.accountId, accountId)).orderBy(desc(markets.isHome), asc(markets.createdAt)),
  ]);
  return [...byLineage.entries()].map(([lineageId, v]) => {
    const shown = (v.draft ?? v.live)!;
    const mine = entries.filter((e) => e.priceListId === shown.id);
    return {
      lineageId,
      shown,
      live: v.live,
      draft: v.draft,
      entryCount: mine.length,
      missingPrices: mine.reduce((n, e) => n + entryProblems(e).filter((p) => p.kind === "price_missing").length, 0),
      usedBy: ms.filter((m) => m.lineageId === lineageId).map((m) => ({ id: m.id, name: m.name })),
    };
  });
}

export type OtherListPrice = { lineageId: string; list: PriceList; entry: PriceListEntry | null };

/**
 * One SKU in the account's other price lists (canvas: PriceEntry, "This item
 * in your other price lists"): each list as its editor shows it (the draft if
 * there is one, else the live version) with the SKU's entry, or null when it
 * is not sold there. Read only; shown for consistency.
 */
export async function itemInOtherLists(db: Db, accountId: string, sku: string, exceptLineageId: string): Promise<OtherListPrice[]> {
  const lists = (await listPriceLists(db, accountId)).filter((l) => l.lineageId !== exceptLineageId);
  if (lists.length === 0) return [];
  const key = sku.trim().toUpperCase();
  const entries = await db
    .select()
    .from(priceListEntries)
    .where(and(eq(priceListEntries.accountId, accountId), eq(priceListEntries.sku, key), inArray(priceListEntries.priceListId, lists.map((l) => l.shown.id))));
  return lists.map((l) => ({ lineageId: l.lineageId, list: l.shown, entry: entries.find((e) => e.priceListId === l.shown.id) ?? null }));
}

/** Every version of one price list, newest first. */
export async function priceListVersions(db: Db, accountId: string, lineageId: string) {
  return db
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId)))
    .orderBy(desc(priceLists.version));
}

export async function lineageExists(db: Db, accountId: string, lineageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId)))
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type CreateResult = { ok: true; list: PriceList } | { ok: false; error: string };

/** Creates a new price list as draft version 1. */
export async function createPriceList(db: Db, actor: Actor, accountId: string, input: PriceListMetaInput): Promise<CreateResult> {
  const problem = metaProblem(input);
  if (problem) return { ok: false, error: problem };
  const [list] = await db
    .insert(priceLists)
    .values({
      id: randomUUID(),
      accountId,
      lineageId: randomUUID(),
      name: input.name.trim(),
      currency: input.currency,
      pricesIncludeTax: input.pricesIncludeTax,
      taxRateBp: input.taxRateBp,
      validFrom: input.validFrom ?? null,
      version: 1,
      status: "draft",
    })
    .returning();
  await writeAudit(db, actor, { accountId, action: "price_list.created", targetType: "price_list", targetId: list.lineageId, details: { name: list.name, currency: list.currency } });
  return { ok: true, list };
}

/**
 * Returns the lineage's draft, creating it as a copy of the live version
 * (settings and entries) when there is none. Null when the lineage is not
 * this account's.
 */
export async function ensureDraft(db: Db, actor: Actor | null, accountId: string, lineageId: string): Promise<PriceList | null> {
  const existing = await versionOf(db, accountId, lineageId, "draft");
  if (existing) return existing;
  const live = await versionOf(db, accountId, lineageId, "live");
  if (!live) return null;
  const [{ top }] = await db.select({ top: max(priceLists.version) }).from(priceLists).where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId)));
  const entries = await entriesOf(db, accountId, live.id);
  const id = randomUUID();
  try {
    await atomic(db, (q) => [
      q.insert(priceLists).values({
        id,
        accountId,
        lineageId,
        name: live.name,
        currency: live.currency,
        pricesIncludeTax: live.pricesIncludeTax,
        taxRateBp: live.taxRateBp,
        validFrom: live.validFrom,
        version: (top ?? 0) + 1,
        status: "draft",
        copiedFromId: live.id,
      }),
      ...entries.map((e) => q.insert(priceListEntries).values({ ...e, id: randomUUID(), priceListId: id })),
    ]);
  } catch (e) {
    // Two requests started the draft at once: use the one that won.
    const winner = await versionOf(db, accountId, lineageId, "draft");
    if (winner) return winner;
    throw e;
  }
  await writeAudit(db, actor, { accountId, action: "price_list.draft_started", targetType: "price_list", targetId: lineageId, details: { version: (top ?? 0) + 1 } });
  return (await versionOf(db, accountId, lineageId, "draft"))!;
}

export type WriteResult = { ok: true } | { ok: false; error: string };
const NOT_FOUND: WriteResult = { ok: false, error: "This price list was not found." };

/** Changes the draft's name, currency, tax handling or valid-from date. */
export async function saveDraftMeta(db: Db, actor: Actor, accountId: string, lineageId: string, patch: Partial<PriceListMetaInput>): Promise<WriteResult> {
  const problem = metaProblem(patch);
  if (problem) return { ok: false, error: problem };
  const draft = await ensureDraft(db, actor, accountId, lineageId);
  if (!draft) return NOT_FOUND;
  const set = {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
    ...(patch.pricesIncludeTax !== undefined ? { pricesIncludeTax: patch.pricesIncludeTax } : {}),
    ...(patch.taxRateBp !== undefined ? { taxRateBp: patch.taxRateBp } : {}),
    ...(patch.validFrom !== undefined ? { validFrom: patch.validFrom } : {}),
  };
  if (Object.keys(set).length === 0) return { ok: true };
  await db.update(priceLists).set(set).where(and(eq(priceLists.id, draft.id), eq(priceLists.accountId, accountId)));
  await writeAudit(db, actor, { accountId, action: "price_list.settings_saved", targetType: "price_list", targetId: lineageId, details: { ...set } });
  return { ok: true };
}

/** Adds or replaces a SKU's prices in the draft. */
export async function setEntry(db: Db, actor: Actor, accountId: string, lineageId: string, input: EntryInput): Promise<WriteResult> {
  const n = normalizeEntry(input);
  if (!n.ok) return n;
  const draft = await ensureDraft(db, actor, accountId, lineageId);
  if (!draft) return NOT_FOUND;
  const { sku, ...prices } = n.value;
  await db
    .insert(priceListEntries)
    .values({ id: randomUUID(), accountId, priceListId: draft.id, sku, ...prices })
    .onConflictDoUpdate({ target: [priceListEntries.priceListId, priceListEntries.sku], set: prices });
  await writeAudit(db, actor, { accountId, action: "price_list.entry_set", targetType: "price_list", targetId: lineageId, details: { ...n.value } });
  return { ok: true };
}

/** Removes a SKU from the draft: it is then "Not sold" in this price list. */
export async function removeEntry(db: Db, actor: Actor, accountId: string, lineageId: string, sku: string): Promise<WriteResult> {
  const draft = await ensureDraft(db, actor, accountId, lineageId);
  if (!draft) return NOT_FOUND;
  const gone = await db
    .delete(priceListEntries)
    .where(and(eq(priceListEntries.accountId, accountId), eq(priceListEntries.priceListId, draft.id), eq(priceListEntries.sku, sku.trim().toUpperCase())))
    .returning({ id: priceListEntries.id });
  if (gone.length === 0) return { ok: false, error: "This item is not in the price list." };
  await writeAudit(db, actor, { accountId, action: "price_list.entry_removed", targetType: "price_list", targetId: lineageId, details: { sku } });
  return { ok: true };
}

export type PublishResult =
  | { ok: true; list: PriceList }
  | { ok: false; reason: "no_draft" | "no_entries" }
  | { ok: false; reason: "problems"; problems: EntryProblem[] };

/** Publishes the draft; the previous live version is archived in the same transaction. */
export async function publishPriceList(db: Db, actor: Actor, accountId: string, lineageId: string, now = new Date()): Promise<PublishResult> {
  const draft = await versionOf(db, accountId, lineageId, "draft");
  if (!draft) return { ok: false, reason: "no_draft" };
  const entries = await entriesOf(db, accountId, draft.id);
  if (entries.length === 0) return { ok: false, reason: "no_entries" };
  const problems = entries.flatMap(entryProblems);
  if (problems.length > 0) return { ok: false, reason: "problems", problems };
  await atomic(db, (q) => [
    q.update(priceLists)
      .set({ status: "archived" })
      .where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId), eq(priceLists.status, "live"))),
    q.update(priceLists)
      .set({ status: "live", publishedAt: now, publishedByUserId: actor.userId })
      .where(and(eq(priceLists.id, draft.id), eq(priceLists.status, "draft"))),
  ]);
  await writeAudit(db, actor, { accountId, action: "price_list.published", targetType: "price_list", targetId: lineageId, details: { version: draft.version, entries: entries.length } });
  const [list] = await db.select().from(priceLists).where(eq(priceLists.id, draft.id));
  return { ok: true, list };
}
export { publishPriceList as publish };

/** Throws the draft away (back to the live version). A list that was never published cannot lose its only version. */
export async function discardDraft(db: Db, actor: Actor, accountId: string, lineageId: string): Promise<WriteResult> {
  const live = await versionOf(db, accountId, lineageId, "live");
  if (!live) return { ok: false, error: "This price list has no live version to go back to." };
  const gone = await db
    .delete(priceLists)
    .where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId), eq(priceLists.status, "draft")))
    .returning({ id: priceLists.id });
  if (gone.length > 0) await writeAudit(db, actor, { accountId, action: "price_list.draft_discarded", targetType: "price_list", targetId: lineageId });
  return { ok: true };
}

export type DeleteResult = { ok: true } | { ok: false; reason: "not_found" | "in_use" | "quoted"; markets?: string[] };

/**
 * Deletes a price list with every version (the list page's ⋯ › Delete). A
 * list a market sells from cannot be deleted (choose another list for the
 * market first), nor one that quotes were priced from: those quotes keep
 * pointing at the version they froze.
 */
export async function deletePriceList(db: Db, actor: Actor, accountId: string, lineageId: string): Promise<DeleteResult> {
  const versions = await db
    .select({ id: priceLists.id, name: priceLists.name })
    .from(priceLists)
    .where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId)));
  if (versions.length === 0) return { ok: false, reason: "not_found" };
  const using = await db
    .select({ name: markets.name })
    .from(markets)
    .where(and(eq(markets.accountId, accountId), eq(markets.priceListLineageId, lineageId)));
  if (using.length > 0) return { ok: false, reason: "in_use", markets: using.map((m) => m.name) };
  const ids = versions.map((v) => v.id);
  const [quoted] = await db
    .select({ id: quoteVersions.id })
    .from(quoteVersions)
    .where(and(eq(quoteVersions.accountId, accountId), inArray(quoteVersions.priceListId, ids)))
    .limit(1);
  if (quoted) return { ok: false, reason: "quoted" };
  // Entries go with their version (on delete cascade); copies made from it keep their prices.
  await db.delete(priceLists).where(and(eq(priceLists.accountId, accountId), eq(priceLists.lineageId, lineageId)));
  await writeAudit(db, actor, { accountId, action: "price_list.deleted", targetType: "price_list", targetId: lineageId, details: { name: versions[0].name } });
  return { ok: true };
}

export type CopyOptions = {
  name: string;
  /** Target currency; defaults to the source's. */
  currency?: string;
  /** Typed by the seller, e.g. "0.215" (there is no exchange-rate service). */
  factor?: string;
  /** e.g. "-10" or "7.5". */
  percent?: string;
  rounding: Rounding;
  pricesIncludeTax?: boolean;
  taxRateBp?: number;
  validFrom?: string | null;
};

export type CopyResult =
  | { ok: true; list: PriceList; entries: number; problems: EntryProblem[] }
  | { ok: false; error: string };

/**
 * "Copy and adjust": a new price list (draft version 1, new lineage) with
 * every entry of the source version converted by factor × (100 + percent)%.
 * Prices and tiers are converted with exact integer math; missing prices stay
 * missing. Problems (e.g. tiers that became equal after rounding) are
 * returned, and block publishing until fixed.
 */
export async function copyAndAdjust(db: Db, actor: Actor, accountId: string, sourceListId: string, opts: CopyOptions): Promise<CopyResult> {
  const source = await priceListVersion(db, accountId, sourceListId);
  if (!source) return { ok: false, error: "This price list was not found." };
  const currency = opts.currency ?? source.list.currency;
  const meta = {
    name: opts.name,
    currency,
    pricesIncludeTax: opts.pricesIncludeTax ?? source.list.pricesIncludeTax,
    taxRateBp: opts.taxRateBp ?? source.list.taxRateBp,
    validFrom: opts.validFrom === undefined ? source.list.validFrom : opts.validFrom,
  };
  const problem = metaProblem(meta);
  if (problem) return { ok: false, error: problem };
  if (!ROUNDINGS.includes(opts.rounding)) return { ok: false, error: "Choose how to round." };
  const ratio = adjustmentRatio({ factor: opts.factor, percent: opts.percent });
  if (!ratio) return { ok: false, error: "Enter a factor above 0 and a percentage above -100." };
  const digits = { from: minorDigits(source.list.currency), to: minorDigits(currency) };
  let tooLarge = false;
  const conv = (v: number | null) => {
    if (v === null) return null;
    const out = adjustMinor(v, ratio, opts.rounding, digits);
    if (out === null) tooLarge = true;
    return out ?? 0;
  };
  const convTiers = (tiers: VolumeTier[]) => tiers.map((t) => ({ minQty: t.minQty, priceMinor: conv(t.priceMinor)! }));
  const listId = randomUUID();
  const entries = source.entries.map((e) => ({
    id: randomUUID(),
    accountId,
    priceListId: listId,
    sku: e.sku,
    oneTimeCharged: e.oneTimeCharged,
    oneTimeMinor: conv(e.oneTimeMinor),
    oneTimeTiers: convTiers(e.oneTimeTiers),
    recurringCharged: e.recurringCharged,
    recurringMinor: conv(e.recurringMinor),
    recurringPeriod: e.recurringPeriod,
    recurringTiers: convTiers(e.recurringTiers),
    customPricingFromQty: e.customPricingFromQty,
  }));
  if (tooLarge) return { ok: false, error: "Some prices would be too large. Check the factor." };
  await atomic(db, (q) => [
    q.insert(priceLists).values({
      id: listId,
      accountId,
      lineageId: randomUUID(),
      name: meta.name.trim(),
      currency,
      pricesIncludeTax: meta.pricesIncludeTax,
      taxRateBp: meta.taxRateBp,
      validFrom: meta.validFrom ?? null,
      version: 1,
      status: "draft",
      copiedFromId: source.list.id,
    }),
    ...entries.map((e) => q.insert(priceListEntries).values(e)),
  ]);
  const [list] = await db.select().from(priceLists).where(eq(priceLists.id, listId));
  await writeAudit(db, actor, {
    accountId,
    action: "price_list.copied",
    targetType: "price_list",
    targetId: list.lineageId,
    details: { from: source.list.id, name: list.name, currency, factor: opts.factor ?? null, percent: opts.percent ?? null, rounding: opts.rounding },
  });
  return { ok: true, list, entries: entries.length, problems: entries.flatMap(entryProblems) };
}

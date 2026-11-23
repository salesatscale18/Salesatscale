/**
 * Quotes (implementation plan P3.2, P3.5; mvp-plan 3.13). Every price comes
 * from the pricing engine (lib/pricing/engine.ts) and the live price list of
 * the lead's market; catalog prices are not used. A version freezes its
 * market, price list version and catalog version, and is immutable once
 * written. Multi-row writes are atomic (db/atomic.ts).
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, ilike, inArray, max, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { TableSort } from "@/lib/domain/table-sort";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { localDateIso } from "@/lib/format";
import { marketTimezone } from "@/lib/markets/settings";
import { marketWhere } from "@/lib/markets/selection";
import { marketNameSort } from "@/lib/markets/sort";
import {
  leadEvents, leads, markets, quoteLines, quotes, quoteVersions, sellerAccounts, toolCalls, users,
  type ApprovalReason, type Quote, type QuoteStatus, type QuoteVersion,
} from "@/db/schema";
import { writeAudit } from "@/lib/accounts/audit";
import { displayName } from "@/lib/auth/display";
import { approvalReasonText, type PricingError, type QuoteRequestLine } from "@/lib/catalog/pricing";
import { checkFit, type FitResult } from "@/lib/catalog/fit";
import { priceWithList, type EngineResult } from "@/lib/pricing/engine";
import { applyAutoAdd } from "@/lib/pricing/auto-add";
import {
  catalogAutoAdd, contextFits, customsFor, customPricesOf, effectiveRemovals, engineItems, enginePriceList, pricingContext, requestLinesOf,
  type PricingContext, type PublishedCatalog,
} from "./pricing";

export const QUOTE_VALID_DAYS = 7;
const DAY_MS = 86_400_000;

/** Who creates a quote. The agent never approves anything. */
export type QuoteActor = { kind: "human"; userId: string; actingAs: boolean } | { kind: "agent" } | { kind: "system" };

export type QuoteInput = {
  /** One line per SKU; the engine makes a line per charge (one-time, recurring). */
  lines: QuoteRequestLine[];
  discountBp: number;
  /** Site count from the deal state, for per-site fit and auto-add rules. */
  sites?: number;
  /**
   * SKUs of auto-added lines the buyer asked to remove. Only SKUs that
   * removable rules add take effect; those are stored on the version
   * (removed_auto_add). Left out on a new version: the current version's
   * removals carry over. An empty list clears them.
   */
  removedByBuyer?: string[];
  idempotencyKey?: string;
  changeNote?: string;
  /**
   * An approved exception from the playbook the quote uses (the agent's
   * create_quote `exception`). The quote then waits for the seller's approval
   * with the reason "Exception: <text>".
   */
  exception?: { id: string; text: string };
  /**
   * Approved exceptions a quote already used, kept on record on a person's new
   * version (the quote editor). Stored as "exception" reasons, as `exception` is.
   */
  exceptions?: { id: string; text: string }[];
  /** Optional: rows the caller already loaded (see price()). */
  preloaded?: PricingPreload;
};

export type QuoteRefusal =
  | { reason: "lead_not_found" | "lead_opted_out" | "no_catalog" | "no_price_list" | "quote_not_found" | "quote_closed" }
  | { reason: "pricing"; errors: PricingError[] }
  | { reason: "fit"; problems: string[] };

export type QuoteResult = { ok: true; quote: Quote; version: QuoteVersion; reused: boolean } | ({ ok: false } & QuoteRefusal);

const isUnique = (e: unknown) => String((e as { code?: string })?.code ?? e).includes("23505");

async function versionByKey(db: Db, accountId: string, key: string) {
  const [v] = await db.select().from(quoteVersions).where(and(eq(quoteVersions.accountId, accountId), eq(quoteVersions.idempotencyKey, key)));
  if (!v) return null;
  const [q] = await db.select().from(quotes).where(eq(quotes.id, v.quoteId));
  return { quote: q, version: v };
}

/** Rows a caller already loaded (the agent's per-turn memo), so price() does not read them again. */
export type PricingPreload = {
  account?: typeof sellerAccounts.$inferSelect;
  catalog?: PublishedCatalog | null;
  /** Market, catalog and live price list for the lead's market. Ignored unless it is this account's and this market's. */
  context?: PricingContext;
};

type Priced = Extract<EngineResult, { ok: true }>;
type PriceOk = {
  ok: true; priced: Priced; fit: FitResult; ctx: PricingContext & { catalog: PublishedCatalog; priceList: NonNullable<PricingContext["priceList"]> };
  /** The buyer's removals that take effect (stored on the version). */
  removed: string[];
  /** Of those, the lines a rule would add to this quote now (sold here): what the editor shows as removed. */
  removedNow: string[];
};
type PriceFail = { ok: false; reason: "no_catalog" | "no_price_list" } | { ok: false; reason: "pricing"; errors: PricingError[] };

/**
 * Prices a request with the live price list of the market (null = home) and
 * the account's discount limit. `customs` are a person's prices per charge
 * ("SKU:one_time" / "SKU:recurring"). Preloaded rows of another account or
 * market are ignored.
 */
async function price(db: Db, accountId: string, marketId: string | null, input: QuoteInput, customs?: Record<string, number>): Promise<PriceOk | PriceFail> {
  const pre = input.preloaded;
  const ctx = contextFits(pre?.context, accountId, marketId) ? pre!.context! : await pricingContext(db, accountId, marketId, { catalog: pre?.catalog });
  if (!ctx.catalog) return { ok: false, reason: "no_catalog" };
  if (!ctx.priceList) return { ok: false, reason: "no_price_list" };
  const [account] = pre?.account && pre.account.id === accountId
    ? [pre.account]
    : await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const entryBySku = new Map(ctx.priceList.entries.map((e) => [e.sku, e]));
  const rules = catalogAutoAdd(ctx.catalog);
  const removed = effectiveRemovals(rules, input.removedByBuyer, input.lines.map((l) => l.sku));
  // A person's price for a line a rule adds (not a request line) applies to that auto-added line.
  const requested = new Set(input.lines.map((l) => l.sku));
  const autoCustoms: Record<string, ReturnType<typeof customsFor>> = {};
  for (const key of Object.keys(customs ?? {})) {
    const sku = key.split(":")[0];
    if (!requested.has(sku)) autoCustoms[sku] = customsFor(customs, sku, entryBySku.get(sku));
  }
  const priced = priceWithList({
    items: engineItems(ctx.catalog),
    entries: ctx.priceList.entries,
    priceList: enginePriceList(ctx.priceList.list),
    lines: input.lines.map((l) => ({ sku: l.sku, qty: l.qty, ...customsFor(customs, l.sku, entryBySku.get(l.sku)) })),
    sites: input.sites,
    discountBp: input.discountBp,
    maxDiscountBp: account.maxDiscountBp,
    autoAdd: rules,
    removedByBuyer: removed,
    autoCustoms,
  });
  if (!priced.ok) return { ok: false, reason: "pricing", errors: priced.errors };
  const exceptions = [...(input.exception ? [input.exception] : []), ...(input.exceptions ?? [])];
  const seenExc = new Set<string>();
  for (const x of exceptions) {
    if (seenExc.has(x.id)) continue;
    seenExc.add(x.id);
    priced.approvalReasons.push({ kind: "exception", id: x.id, text: x.text.slice(0, 300) });
  }
  // Fit rules see what will be quoted, including lines added automatically.
  const fit = checkFit(ctx.catalog.rules, requestLinesOf(priced.lines), input.sites);
  const wouldAdd = new Set(removed.length ? applyAutoAdd(rules, input.lines, input.sites).autoAdded.map((a) => a.sku) : []);
  const sold = (sku: string) => entryBySku.has(sku) && ctx.catalog!.items.some((i) => i.sku === sku && i.active);
  const removedNow = removed.filter((sku) => wouldAdd.has(sku) && sold(sku));
  return { ok: true, priced, fit, ctx: ctx as PriceOk["ctx"], removed, removedNow };
}

export type QuotePreview =
  | { ok: true; priced: Priced; fit: FitResult; context: PriceOk["ctx"]; removed: string[]; removedNow: string[] }
  | ({ ok: false } & QuoteRefusal);

/**
 * Prices a request for a lead exactly as createQuote would, and saves nothing
 * (the quote editor's live preview). Scoped by account. With `fromQuoteId`
 * (a new version) it prices in that quote's market, as createQuoteVersion does,
 * and carries over the current version's removals unless the input gives them.
 */
export async function previewQuote(
  db: Db, accountId: string, leadId: string, input: QuoteInput, fromQuoteId?: string,
  /** A person's prices per charge ("SKU:one_time" / "SKU:recurring"), as createQuoteVersion takes them. */
  customs?: Record<string, number>,
): Promise<QuotePreview> {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!lead) return { ok: false, reason: "lead_not_found" };
  let marketId = lead.marketId;
  let removedByBuyer = input.removedByBuyer;
  if (fromQuoteId) {
    const q = await quoteOf(db, accountId, fromQuoteId);
    if (!q || q.leadId !== leadId) return { ok: false, reason: "quote_not_found" };
    marketId = q.marketId ?? lead.marketId;
    removedByBuyer ??= (await currentVersionOf(db, q))?.removedAutoAdd ?? [];
  }
  const p = await price(db, accountId, marketId, { ...input, removedByBuyer }, customs);
  if (!p.ok) return p;
  return { ok: true, priced: p.priced, fit: p.fit, context: p.ctx, removed: p.removed, removedNow: p.removedNow };
}

function versionRows(
  accountId: string,
  quoteId: string,
  version: number,
  p: PriceOk,
  actor: QuoteActor,
  input: QuoteInput,
  now: Date,
  approvedByUserId: string | null,
) {
  const versionId = randomUUID();
  const v = {
    id: versionId,
    accountId,
    quoteId,
    version,
    catalogVersionId: p.ctx.catalog.version.id,
    marketId: p.ctx.market.id,
    priceListId: p.ctx.priceList.list.id,
    removedAutoAdd: p.removed,
    currency: p.priced.currency,
    discountBp: input.discountBp,
    pricesIncludeTax: p.priced.pricesIncludeTax,
    taxRateBp: p.priced.taxRateBp,
    oneTimeSubtotalMinor: p.priced.oneTime.subtotalMinor,
    oneTimeDiscountMinor: p.priced.oneTime.discountMinor,
    oneTimeTaxMinor: p.priced.oneTime.taxMinor,
    oneTimeTotalMinor: p.priced.oneTime.totalMinor,
    recurringSubtotalMinor: p.priced.recurring.subtotalMinor,
    recurringDiscountMinor: p.priced.recurring.discountMinor,
    recurringTaxMinor: p.priced.recurring.taxMinor,
    recurringTotalMinor: p.priced.recurring.totalMinor,
    recurringPeriod: p.priced.recurringPeriod,
    // Price-missing reasons also say which charge ({ charge }): extra jsonb data, read by approvalReasonText.
    approvalReasons: p.priced.approvalReasons as ApprovalReason[],
    approvedByUserId,
    approvedAt: approvedByUserId ? now : null,
    validUntil: new Date(now.getTime() + QUOTE_VALID_DAYS * DAY_MS),
    changeNote: input.changeNote?.slice(0, 300) ?? null,
    createdByActor: actor.kind,
    createdByUserId: actor.kind === "human" ? actor.userId : null,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt: now,
  };
  const lines = p.priced.lines.map((l, i) => ({
    id: randomUUID(),
    accountId,
    quoteVersionId: versionId,
    catalogItemId: l.catalogItemId,
    sku: l.sku,
    name: l.name,
    chargeType: l.charge,
    period: l.period,
    unit: l.unit,
    qty: l.qty,
    unitPriceMinor: l.unitPriceMinor,
    priceSource: l.priceSource,
    lineTotalMinor: l.lineTotalMinor,
    sortOrder: i,
  }));
  return { v, lines };
}

/** Status of a new version: approval is needed unless a person priced everything (they approve it themselves). */
function statusFor(reasons: ApprovalReason[], complete: boolean, actor: QuoteActor): { status: QuoteStatus; approvedBy: string | null } {
  if (reasons.length === 0) return { status: "draft", approvedBy: null };
  if (actor.kind === "human" && complete) return { status: "draft", approvedBy: actor.userId };
  return { status: "awaiting_approval", approvedBy: null };
}

function refusalOf(p: PriceFail): { ok: false } & QuoteRefusal {
  return p.reason === "pricing" ? { ok: false, reason: "pricing", errors: p.errors } : { ok: false, reason: p.reason };
}

export async function createQuote(db: Db, accountId: string, actor: QuoteActor, leadId: string, input: QuoteInput, now = new Date()): Promise<QuoteResult> {
  if (input.idempotencyKey) {
    const hit = await versionByKey(db, accountId, input.idempotencyKey);
    if (hit) return { ok: true, ...hit, reused: true };
  }
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!lead) return { ok: false, reason: "lead_not_found" };
  if (lead.status === "opted_out") return { ok: false, reason: "lead_opted_out" };
  const p = await price(db, accountId, lead.marketId, input);
  if (!p.ok) return refusalOf(p);
  if (!p.fit.ok) return { ok: false, reason: "fit", problems: p.fit.problems };
  const { status, approvedBy } = statusFor(p.priced.approvalReasons, p.priced.complete, actor);

  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ top }] = await db.select({ top: max(quotes.number) }).from(quotes).where(eq(quotes.accountId, accountId));
    const quoteId = randomUUID();
    const number = (top ?? 1000) + 1;
    const { v, lines } = versionRows(accountId, quoteId, 1, p, actor, input, now, approvedBy);
    try {
      await atomic(db, (q) => [
        q.insert(quotes).values({ id: quoteId, accountId, leadId, number, status, currentVersion: 1, marketId: p.ctx.market.id, createdAt: now }),
        q.insert(quoteVersions).values(v),
        ...lines.map((l) => q.insert(quoteLines).values(l)),
        q.insert(leadEvents).values({
          accountId, leadId, type: "quote.created", actor: actor.kind, actorUserId: actor.kind === "human" ? actor.userId : null,
          data: { quoteId, number, version: 1, oneTimeTotalMinor: v.oneTimeTotalMinor, recurringTotalMinor: v.recurringTotalMinor, currency: v.currency, status },
        }),
        ...(approvedBy && v.approvalReasons.length
          ? [q.insert(leadEvents).values({ accountId, leadId, type: "quote.approved", actor: "human", actorUserId: approvedBy, data: { quoteId, number, version: 1, reasons: v.approvalReasons.map(approvalReasonText) } })]
          : []),
        q.update(leads).set({ lastActivityAt: now }).where(eq(leads.id, leadId)),
      ]);
      // Re-read both rows (DB defaults such as updated_at) in one parallel round trip.
      const [[quote], [version]] = await Promise.all([
        db.select().from(quotes).where(eq(quotes.id, quoteId)),
        db.select().from(quoteVersions).where(eq(quoteVersions.id, v.id)),
      ]);
      if (actor.kind === "human" && actor.actingAs) {
        await writeAudit(db, { userId: actor.userId, actingAs: true }, { accountId, action: "quote.created", targetType: "quote", targetId: quoteId });
      }
      return { ok: true, quote, version, reused: false };
    } catch (e) {
      if (!isUnique(e)) throw e;
      if (input.idempotencyKey) {
        const hit = await versionByKey(db, accountId, input.idempotencyKey);
        if (hit) return { ok: true, ...hit, reused: true };
      }
      // Quote number taken by a concurrent create: try the next one.
    }
  }
  throw new Error("Could not allocate a quote number");
}

async function quoteOf(db: Db, accountId: string, quoteId: string) {
  const [q] = await db.select().from(quotes).where(and(eq(quotes.id, quoteId), eq(quotes.accountId, accountId)));
  return q ?? null;
}

async function currentVersionOf(db: Db, q: Quote) {
  const [v] = await db.select().from(quoteVersions).where(and(eq(quoteVersions.quoteId, q.id), eq(quoteVersions.version, q.currentVersion)));
  return v;
}

/**
 * A material change makes a new version; the previous one is replaced
 * (its order-form link stops working once forms exist, P5). The new version is
 * priced from the quote's market's live price list as it is now.
 */
export async function createQuoteVersion(
  db: Db, accountId: string, actor: QuoteActor, quoteId: string, input: QuoteInput, now = new Date(),
  /** A person's prices per charge: "SKU:one_time" / "SKU:recurring" (a bare "SKU" means its only or one-time charge). */
  customs?: Record<string, number>,
  /** Set by approveQuote: the person approving this version. */
  approvingUserId?: string,
): Promise<QuoteResult> {
  if (input.idempotencyKey) {
    const hit = await versionByKey(db, accountId, input.idempotencyKey);
    if (hit) return { ok: true, ...hit, reused: true };
  }
  const q = await quoteOf(db, accountId, quoteId);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (q.status === "cancelled") return { ok: false, reason: "quote_closed" };
  const [lead] = await db.select().from(leads).where(eq(leads.id, q.leadId));
  if (lead.status === "opted_out") return { ok: false, reason: "lead_opted_out" };
  // The buyer's removals carry over from the current version unless the input gives them.
  const current = await currentVersionOf(db, q);
  const removedByBuyer = input.removedByBuyer ?? current?.removedAutoAdd ?? [];
  // A quote stays in its market; quotes made before markets follow the lead's.
  const p = await price(db, accountId, q.marketId ?? lead.marketId, { ...input, removedByBuyer }, customs);
  if (!p.ok) return refusalOf(p);
  if (!p.fit.ok) return { ok: false, reason: "fit", problems: p.fit.problems };
  const decided = statusFor(p.priced.approvalReasons, p.priced.complete, actor);
  const status = approvingUserId && p.priced.complete ? "draft" : decided.status;
  const approvedBy = approvingUserId && p.priced.complete ? approvingUserId : decided.approvedBy;
  const next = q.currentVersion + 1;
  const { v, lines } = versionRows(accountId, q.id, next, p, actor, input, now, approvedBy);
  // A person changed a price (set, changed or reset one) in the editor: "Price changed by …" on the lead's timeline.
  const priceChanged = actor.kind === "human" && !approvingUserId && current
    ? !samePrices(customPricesOf(await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, current.id))), customPricesOf(lines))
    : false;
  // Named as the seller's screens name people (display name, never the full email).
  const [changer] = priceChanged && actor.kind === "human" ? await db.select().from(users).where(eq(users.id, actor.userId)) : [];
  try {
    await atomic(db, (tx) => [
      tx.insert(quoteVersions).values(v),
      ...lines.map((l) => tx.insert(quoteLines).values(l)),
      // Guarded on the current version so two concurrent edits can't both win.
      tx.update(quotes).set({ currentVersion: next, status, marketId: p.ctx.market.id }).where(and(eq(quotes.id, q.id), eq(quotes.currentVersion, q.currentVersion))),
      tx.insert(leadEvents).values({
        accountId, leadId: q.leadId, type: "quote.versioned", actor: actor.kind, actorUserId: actor.kind === "human" ? actor.userId : null,
        data: { quoteId: q.id, number: q.number, version: next, note: v.changeNote, status },
      }),
      ...(priceChanged && actor.kind === "human"
        ? [tx.insert(leadEvents).values({ accountId, leadId: q.leadId, type: "quote.price_changed", actor: "human", actorUserId: actor.userId, data: { quoteId: q.id, number: q.number, version: next, by: changer ? displayName(changer) : null } })]
        : []),
      ...(approvedBy && v.approvalReasons.length
        ? [tx.insert(leadEvents).values({ accountId, leadId: q.leadId, type: "quote.approved", actor: "human", actorUserId: approvedBy, data: { quoteId: q.id, number: q.number, version: next, reasons: v.approvalReasons.map(approvalReasonText) } })]
        : []),
      tx.update(leads).set({ lastActivityAt: now }).where(eq(leads.id, q.leadId)),
    ]);
  } catch (e) {
    if (isUnique(e) && input.idempotencyKey) {
      const hit = await versionByKey(db, accountId, input.idempotencyKey);
      if (hit) return { ok: true, ...hit, reused: true };
    }
    throw e;
  }
  const [quoteRow, [version]] = await Promise.all([
    quoteOf(db, accountId, q.id),
    db.select().from(quoteVersions).where(eq(quoteVersions.id, v.id)),
  ]);
  const quote = quoteRow!;
  if (actor.kind === "human") {
    await writeAudit(db, { userId: actor.userId, actingAs: actor.actingAs }, { accountId, action: "quote.versioned", targetType: "quote", targetId: q.id, details: { version: next } });
  }
  return { ok: true, quote, version, reused: false };
}

/** Two sets of a person's prices per charge are the same. */
function samePrices(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

/** The key of a person's price for one charge of a SKU (approve form: "price:SKU:charge"). */
export const customKey = (sku: string, charge: string) => `${sku}:${charge}`;

/**
 * "Approve and send" (canvas: Orders): a person prices custom lines and/or
 * accepts the discount. Same lines → the current version is approved; custom
 * prices (per charge, "SKU:one_time" / "SKU:recurring") → a new, approved version.
 */
export async function approveQuote(
  db: Db, accountId: string, actor: { userId: string; actingAs: boolean }, quoteId: string, customPrices: Record<string, number>, now = new Date(),
): Promise<QuoteResult> {
  const q = await quoteOf(db, accountId, quoteId);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (q.status !== "awaiting_approval") return { ok: false, reason: "quote_closed" };
  const current = await currentVersionOf(db, q);
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, current.id)).orderBy(asc(quoteLines.sortOrder));
  // A bare "SKU" key covers a SKU that has only one line (older forms).
  const perSku = new Map<string, number>();
  for (const l of lines) perSku.set(l.sku, (perSku.get(l.sku) ?? 0) + 1);
  const priceFor = (l: (typeof lines)[number]) => customPrices[customKey(l.sku, l.chargeType)] ?? (perSku.get(l.sku) === 1 ? customPrices[l.sku] : undefined);
  const unpriced = lines.filter((l) => l.unitPriceMinor === null && priceFor(l) === undefined);
  if (unpriced.length) return { ok: false, reason: "pricing", errors: unpriced.map((l) => ({ kind: "bad_custom_price" as const, sku: l.sku })) };
  const human: QuoteActor = { kind: "human", ...actor };
  if (Object.keys(customPrices).length > 0) {
    // Keep prices a person already set on earlier custom lines; normalise bare keys to per-charge keys.
    const given: Record<string, number> = {};
    for (const l of lines) {
      const p = priceFor(l);
      if (p !== undefined) given[customKey(l.sku, l.chargeType)] = p;
    }
    return createQuoteVersion(
      db, accountId, human, q.id,
      {
        lines: requestLinesOf(lines), discountBp: current.discountBp, changeNote: "Priced and approved by the seller",
        // An approved exception the quote used stays recorded on the new version.
        ...(() => {
          const ex = current.approvalReasons.find((r) => r.kind === "exception");
          return ex && ex.kind === "exception" ? { exception: { id: ex.id, text: ex.text } } : {};
        })(),
      },
      now, { ...customPricesOf(lines), ...given }, actor.userId,
    );
  }
  await atomic(db, (tx) => [
    tx.update(quoteVersions).set({ approvedByUserId: actor.userId, approvedAt: now }).where(eq(quoteVersions.id, current.id)),
    tx.update(quotes).set({ status: "draft" }).where(and(eq(quotes.id, q.id), eq(quotes.status, "awaiting_approval"))),
    tx.insert(leadEvents).values({ accountId, leadId: q.leadId, type: "quote.approved", actor: "human", actorUserId: actor.userId, data: { quoteId: q.id, number: q.number, version: current.version, reasons: current.approvalReasons.map(approvalReasonText) } }),
  ]);
  await writeAudit(db, actor, { accountId, action: "quote.approved", targetType: "quote", targetId: q.id, details: { version: current.version } });
  const [quoteRow, [version]] = await Promise.all([
    quoteOf(db, accountId, q.id),
    db.select().from(quoteVersions).where(eq(quoteVersions.id, current.id)),
  ]);
  const quote = quoteRow!;
  return { ok: true, quote, version, reused: false };
}

export async function cancelQuote(db: Db, accountId: string, actor: { userId: string; actingAs: boolean }, quoteId: string) {
  const q = await quoteOf(db, accountId, quoteId);
  if (!q || q.status === "cancelled") return null;
  await atomic(db, (tx) => [
    tx.update(quotes).set({ status: "cancelled" }).where(and(eq(quotes.id, q.id), eq(quotes.accountId, accountId))),
    tx.insert(leadEvents).values({ accountId, leadId: q.leadId, type: "quote.cancelled", actor: "human", actorUserId: actor.userId, data: { quoteId: q.id, number: q.number } }),
  ]);
  await writeAudit(db, actor, { accountId, action: "quote.cancelled", targetType: "quote", targetId: q.id });
  return quoteOf(db, accountId, q.id);
}

/**
 * The buyer has the quote: the app sent its card (web chats) or its text
 * (WhatsApp). Draft → Sent through the existing status; any other status
 * (awaiting approval, replaced, cancelled, already sent) is left as is.
 * Returns whether the status changed.
 */
export async function markQuoteSent(db: Db, accountId: string, quoteId: string): Promise<boolean> {
  const updated = await db.update(quotes).set({ status: "sent" })
    .where(and(eq(quotes.id, quoteId), eq(quotes.accountId, accountId), eq(quotes.status, "draft")))
    .returning({ id: quotes.id });
  return updated.length > 0;
}

/**
 * Display status: "Expires today" / "Expired" are derived from the valid-until
 * date, "today" in the quote's time zone (lib/markets/settings.ts marketTimezone; UTC when not given).
 * A quote a signed or paid order came from shows "Ordered" (`ordered`), whatever its stored status or date.
 */
export function displayQuoteStatus(status: QuoteStatus, validUntil: Date, now = new Date(), timezone?: string | null, ordered = false): "draft" | "awaiting_approval" | "sent" | "expires_today" | "expired" | "replaced" | "cancelled" | "ordered" {
  if (ordered) return "ordered";
  if (status === "draft" || status === "sent") {
    if (validUntil.getTime() <= now.getTime()) return "expired";
    if (localDateIso(validUntil, timezone) === localDateIso(now, timezone)) return "expires_today";
  }
  return status;
}

/**
 * One pill for a quote row on the lead card: the furthest state the deal
 * reached with this quote, so the row and the timeline agree (round-4 review
 * F2). A paid order shows Paid; a signed one Ordered; a sent quote whose order
 * form the buyer opened shows Opened. Ended quotes (expired, replaced,
 * cancelled) and "expires today" keep their quote state. Pure.
 */
export function furthestQuoteState(
  quoteState: ReturnType<typeof displayQuoteStatus>,
  doc: { form: "sent" | "opened" | "signed" | "link_expired" | null; payment: string | null } | null | undefined,
): { object: "quote"; state: ReturnType<typeof displayQuoteStatus> } | { object: "order_form"; state: "opened" | "signed" } | { object: "payment"; state: "paid" } {
  if (doc?.payment === "paid") return { object: "payment", state: "paid" };
  if (quoteState === "ordered") return { object: "quote", state: "ordered" };
  if (quoteState === "sent" && doc?.form === "signed") return { object: "order_form", state: "signed" };
  if (quoteState === "sent" && doc?.form === "opened") return { object: "order_form", state: "opened" };
  return { object: "quote", state: quoteState };
}

/**
 * The time zone each quote's dates are shown in (valid until, expires today):
 * its market's, else the account's. The quote card uses the same zone, so the
 * seller and the buyer see one date. Keyed by quote id; scoped by account.
 */
export async function quoteTimezones(db: Db, accountId: string, rows: { id: string; marketId: string | null }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rows.length) return out;
  const marketIds = [...new Set(rows.map((r) => r.marketId).filter((x): x is string => !!x))];
  // The quote's market, else (no market, or a removed one) the home market, as resolveMarket does.
  const [[account], ms] = await Promise.all([
    db.select({ timezone: sellerAccounts.timezone }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    db.select({ id: markets.id, isHome: markets.isHome, overrides: markets.overrides }).from(markets)
      .where(and(eq(markets.accountId, accountId), marketIds.length ? or(eq(markets.isHome, true), inArray(markets.id, marketIds)) : eq(markets.isHome, true))),
  ]);
  const accountTz = { timezone: account?.timezone ?? "UTC" };
  const byId = new Map(ms.map((m) => [m.id, m]));
  const home = ms.find((m) => m.isHome) ?? null;
  for (const r of rows) out.set(r.id, marketTimezone(accountTz, (r.marketId ? byId.get(r.marketId) : null) ?? home));
  return out;
}

/**
 * Quotes created before Draft -> Sent was stored (markQuoteSent) stay "draft"
 * although the app already sent them. Read at display time, as signed orders
 * are (lib/orders/service.ts withSignedValues): a draft whose current version
 * went out as the app's quote message (create_quote with `quote_message_id`,
 * not a held placeholder; or an `app_message` of kind "quote" after an
 * approval) shows as "sent". Matched on "Q-<number> v<current version>", so a
 * newer version the buyer has not had stays "draft". One query; account-scoped.
 */
export async function sentDraftQuoteIds(db: Db, accountId: string, rows: { id: string; number: number; status: QuoteStatus; currentVersion: number }[]): Promise<Set<string>> {
  const drafts = rows.filter((r) => r.status === "draft");
  if (!drafts.length) return new Set();
  const byLabel = new Map(drafts.map((q) => [`Q-${q.number} v${q.currentVersion}`, q.id]));
  const label = sql<string>`${toolCalls.result} ->> 'quote'`;
  const found = await db.select({ label }).from(toolCalls)
    .where(and(
      eq(toolCalls.accountId, accountId), eq(toolCalls.outcome, "ok"),
      inArray(label, [...byLabel.keys()]),
      or(
        and(eq(toolCalls.name, "create_quote"), sql`${toolCalls.result} ? 'quote_message_id'`, sql`coalesce(${toolCalls.result} ->> 'quote_held', 'false') <> 'true'`),
        and(eq(toolCalls.name, "app_message"), sql`${toolCalls.result} ->> 'kind' = 'quote'`),
      ),
    ));
  return new Set(found.map((f) => byLabel.get(f.label)).filter((x): x is string => !!x));
}

/** The row with the quote's derived "sent" status where sentDraftQuoteIds found one. */
function withSent<T extends { quote: Quote }>(row: T, sent: Set<string>): T {
  return sent.has(row.quote.id) ? { ...row, quote: { ...row.quote, status: "sent" } } : row;
}

export type QuoteTab = "quotes" | "approval";

/** Quotes list columns that sort on the server; default: newest first. */
export const QUOTE_SORT_KEYS = ["quote", "lead", "one_time", "monthly", "status", "market", "created", "valid_until"] as const;
export type QuoteSortKey = (typeof QUOTE_SORT_KEYS)[number];
export const QUOTE_SORT_DEFAULT: TableSort<QuoteSortKey> = { key: "created", dir: "desc" };

/** "Created: Last N days" / "Signed: Last N days" on Quotes and orders; null = any time. */
export const DOC_PERIODS = [7, 30, 90] as const;
export const DOC_PERIOD_DEFAULT = 30;
/** The period from the URL: "7" | "30" | "90" | "any"; anything else is the default (30 days). */
export function parseDocPeriod(v: string | undefined): number | null {
  if (v === "any") return null;
  const n = Number(v);
  return (DOC_PERIODS as readonly number[]).includes(n) ? n : DOC_PERIOD_DEFAULT;
}
/** The first moment inside a "Last N days" period (null = any time). */
export function periodStart(days: number | null, now = new Date()): Date | null {
  return days ? new Date(now.getTime() - days * 86_400_000) : null;
}

/**
 * Search in Quotes and orders: a quote number ("Q-1003", "1003"), an order
 * number ("PD-10001"), or part of the lead's name or company. Null for an empty search.
 */
export function docSearchSql(q: string | undefined, numberCol: AnyPgColumn): SQL | null {
  const s = q?.trim();
  if (!s) return null;
  const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const conds: SQL[] = [ilike(leads.fullName, like), ilike(leads.company, like)];
  const num = s.match(/^(?:[a-z]{1,3}-?)?\s*(\d{1,9})$/i);
  if (num) conds.push(eq(numberCol, Number(num[1])));
  return or(...conds)!;
}

/** The market switcher's choice for Quotes and orders (lib/markets/selection.ts): a quote or order with no market id is the home market's. */
export type DocMarketFilter = { id: string; isHome: boolean } | null;

export async function listQuotes(db: Db, accountId: string, tab: QuoteTab = "quotes", opts: { q?: string; sort?: TableSort<QuoteSortKey>; market?: DocMarketFilter; since?: Date | null } = {}) {
  const sort = opts.sort ?? QUOTE_SORT_DEFAULT;
  const col: Record<QuoteSortKey, SQL | AnyPgColumn> = {
    quote: quotes.number,
    lead: sql`lower(coalesce(${leads.company}, ${leads.fullName}))`,
    one_time: quoteVersions.oneTimeTotalMinor,
    monthly: quoteVersions.recurringTotalMinor,
    status: quotes.status,
    market: marketNameSort(markets.name, quotes.accountId),
    created: quotes.createdAt,
    valid_until: quoteVersions.validUntil,
  };
  const rows = await db
    .select({ quote: quotes, version: quoteVersions, lead: leads, market: { id: markets.id, name: markets.name } })
    .from(quotes)
    .innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.currentVersion)))
    .innerJoin(leads, eq(leads.id, quotes.leadId))
    .leftJoin(markets, and(eq(markets.id, quotes.marketId), eq(markets.accountId, quotes.accountId)))
    .where(and(eq(quotes.accountId, accountId), eq(leads.isTest, false), ...(tab === "approval" ? [eq(quotes.status, "awaiting_approval")] : []), docSearchSql(opts.q, quotes.number) ?? undefined, marketWhere(quotes.marketId, opts.market ?? null), opts.since ? gte(quotes.createdAt, opts.since) : undefined))
    .orderBy(sort.dir === "asc" ? sql`${col[sort.key]} asc nulls last` : sql`${col[sort.key]} desc nulls last`, desc(quotes.createdAt))
    .limit(200);
  const sent = await sentDraftQuoteIds(db, accountId, rows.map((r) => r.quote));
  return rows.map((r) => withSent(r, sent));
}

export async function countAwaitingApproval(db: Db, accountId: string, market: DocMarketFilter = null) {
  const [{ n }] = await db.select({ n: count() }).from(quotes).innerJoin(leads, eq(leads.id, quotes.leadId))
    .where(and(eq(quotes.accountId, accountId), eq(leads.isTest, false), eq(quotes.status, "awaiting_approval"), marketWhere(quotes.marketId, market)));
  return n;
}

/** Quotes of real leads in the market; with `since`, only those created from then on. */
export async function countQuotes(db: Db, accountId: string, market: DocMarketFilter = null, since: Date | null = null) {
  const [{ n }] = await db.select({ n: count() }).from(quotes).innerJoin(leads, eq(leads.id, quotes.leadId)).where(and(eq(quotes.accountId, accountId), eq(leads.isTest, false), marketWhere(quotes.marketId, market), since ? gte(quotes.createdAt, since) : undefined));
  return n;
}

export async function getQuote(db: Db, accountId: string, quoteId: string) {
  const q = await quoteOf(db, accountId, quoteId);
  if (!q) return null;
  // Lead, versions, their lines and the derived "sent" in one parallel round trip after the quote.
  const [[lead], versions, lines, sent] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, q.leadId)),
    db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, q.id)).orderBy(desc(quoteVersions.version)),
    db.select().from(quoteLines)
      .where(inArray(quoteLines.quoteVersionId, db.select({ id: quoteVersions.id }).from(quoteVersions).where(eq(quoteVersions.quoteId, q.id))))
      .orderBy(asc(quoteLines.sortOrder)),
    sentDraftQuoteIds(db, accountId, [q]),
  ]);
  return {
    quote: withSent({ quote: q }, sent).quote,
    lead,
    versions: versions.map((v) => ({ version: v, lines: lines.filter((l) => l.quoteVersionId === v.id) })),
  };
}

/** A lead's quotes, newest first: the current version plus older versions (newest first) for "Show v1". */
export async function quotesForLead(db: Db, accountId: string, leadId: string) {
  const rows = await db
    .select({ quote: quotes, version: quoteVersions })
    .from(quotes)
    .innerJoin(quoteVersions, eq(quoteVersions.quoteId, quotes.id))
    .where(and(eq(quotes.accountId, accountId), eq(quotes.leadId, leadId)))
    .orderBy(desc(quotes.createdAt), desc(quoteVersions.version));
  // Map keeps insertion order, so quotes stay newest first.
  const byQuote = new Map<string, { quote: typeof quotes.$inferSelect; version: typeof quoteVersions.$inferSelect; older: (typeof quoteVersions.$inferSelect)[] }>();
  for (const r of rows) {
    const cur = byQuote.get(r.quote.id);
    if (!cur) byQuote.set(r.quote.id, { quote: r.quote, version: r.version, older: [] });
    else cur.older.push(r.version);
  }
  const sent = await sentDraftQuoteIds(db, accountId, [...byQuote.values()].map((o) => o.quote));
  return [...byQuote.values()].map((o) => {
    const current = [o.version, ...o.older].find((v) => v.version === o.quote.currentVersion) ?? o.version;
    return { quote: withSent(o, sent).quote, version: current, older: [o.version, ...o.older].filter((v) => v.version !== current.version) };
  });
}

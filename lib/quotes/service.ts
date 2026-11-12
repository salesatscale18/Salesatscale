/**
 * Quotes (implementation plan P3.2, P3.5). Every price comes from the quote
 * engine and the published catalog; a version is immutable once written.
 * Multi-row writes are atomic (db/atomic.ts).
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  leadEvents, leads, quoteLines, quotes, quoteVersions, sellerAccounts,
  type ApprovalReason, type Quote, type QuoteStatus, type QuoteVersion,
} from "@/db/schema";
import { writeAudit } from "@/lib/accounts/audit";
import { approvalReasonText, priceQuote, type PricingError, type QuoteRequestLine } from "@/lib/catalog/pricing";
import { checkFit } from "@/lib/catalog/fit";
import { publishedCatalog } from "@/lib/catalog/service";

export const QUOTE_VALID_DAYS = 7;
const DAY_MS = 86_400_000;

/** Who creates a quote. The agent never approves anything. */
export type QuoteActor = { kind: "human"; userId: string; actingAs: boolean } | { kind: "agent" } | { kind: "system" };

export type QuoteInput = {
  lines: QuoteRequestLine[];
  discountBp: number;
  /** Site count from the deal state, for per-site fit rules. */
  sites?: number;
  idempotencyKey?: string;
  changeNote?: string;
};

export type QuoteRefusal =
  | { reason: "lead_not_found" | "lead_opted_out" | "no_catalog" | "quote_not_found" | "quote_closed" }
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

/** Prices a request against the published catalog and the account's discount limit. */
async function price(db: Db, accountId: string, input: QuoteInput, customs?: Record<string, number>) {
  const catalog = await publishedCatalog(db, accountId);
  if (!catalog) return { ok: false as const, reason: "no_catalog" as const };
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const lines = input.lines.map((l) => (customs && customs[l.sku] !== undefined ? { ...l, customUnitPriceMinor: customs[l.sku] } : l));
  const priced = priceQuote({
    items: catalog.items,
    lines,
    discountBp: input.discountBp,
    maxDiscountBp: account.maxDiscountBp,
    pricesIncludeTax: catalog.version.pricesIncludeTax,
    taxRateBp: catalog.version.taxRateBp,
  });
  if (!priced.ok) return { ok: false as const, reason: "pricing" as const, errors: priced.errors };
  const fit = checkFit(catalog.rules, input.lines, input.sites);
  return { ok: true as const, priced, fit, catalog, currency: account.currency };
}

function versionRows(
  accountId: string,
  quoteId: string,
  version: number,
  p: Extract<Awaited<ReturnType<typeof price>>, { ok: true }>,
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
    catalogVersionId: p.catalog.version.id,
    currency: p.currency,
    discountBp: input.discountBp,
    pricesIncludeTax: p.catalog.version.pricesIncludeTax,
    taxRateBp: p.catalog.version.taxRateBp,
    oneTimeSubtotalMinor: p.priced.oneTime.subtotalMinor,
    oneTimeDiscountMinor: p.priced.oneTime.discountMinor,
    oneTimeTaxMinor: p.priced.oneTime.taxMinor,
    oneTimeTotalMinor: p.priced.oneTime.totalMinor,
    recurringSubtotalMinor: p.priced.recurring.subtotalMinor,
    recurringDiscountMinor: p.priced.recurring.discountMinor,
    recurringTaxMinor: p.priced.recurring.taxMinor,
    recurringTotalMinor: p.priced.recurring.totalMinor,
    recurringPeriod: p.priced.recurringPeriod,
    approvalReasons: p.priced.approvalReasons,
    approvedByUserId,
    approvedAt: approvedByUserId ? now : null,
    validUntil: new Date(now.getTime() + QUOTE_VALID_DAYS * DAY_MS),
    changeNote: input.changeNote?.slice(0, 300) ?? null,
    createdByActor: actor.kind,
    createdByUserId: actor.kind === "human" ? actor.userId : null,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt: now,
  };
  const lines = p.priced.lines.map((l, i) => ({ ...l, id: randomUUID(), accountId, quoteVersionId: versionId, sortOrder: i }));
  return { v, lines };
}

/** Status of a new version: approval is needed unless a person priced everything (they approve it themselves). */
function statusFor(reasons: ApprovalReason[], complete: boolean, actor: QuoteActor): { status: QuoteStatus; approvedBy: string | null } {
  if (reasons.length === 0) return { status: "draft", approvedBy: null };
  if (actor.kind === "human" && complete) return { status: "draft", approvedBy: actor.userId };
  return { status: "awaiting_approval", approvedBy: null };
}

export async function createQuote(db: Db, accountId: string, actor: QuoteActor, leadId: string, input: QuoteInput, now = new Date()): Promise<QuoteResult> {
  if (input.idempotencyKey) {
    const hit = await versionByKey(db, accountId, input.idempotencyKey);
    if (hit) return { ok: true, ...hit, reused: true };
  }
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!lead) return { ok: false, reason: "lead_not_found" };
  if (lead.status === "opted_out") return { ok: false, reason: "lead_opted_out" };
  const p = await price(db, accountId, input);
  if (!p.ok) return p.reason === "pricing" ? { ok: false, reason: "pricing", errors: p.errors } : { ok: false, reason: p.reason };
  if (!p.fit.ok) return { ok: false, reason: "fit", problems: p.fit.problems };
  const { status, approvedBy } = statusFor(p.priced.approvalReasons, p.priced.complete, actor);

  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ top }] = await db.select({ top: max(quotes.number) }).from(quotes).where(eq(quotes.accountId, accountId));
    const quoteId = randomUUID();
    const number = (top ?? 1000) + 1;
    const { v, lines } = versionRows(accountId, quoteId, 1, p, actor, input, now, approvedBy);
    try {
      await atomic(db, (q) => [
        q.insert(quotes).values({ id: quoteId, accountId, leadId, number, status, currentVersion: 1, createdAt: now }),
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
      const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
      const [version] = await db.select().from(quoteVersions).where(eq(quoteVersions.id, v.id));
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
 * (its order-form link stops working once forms exist, P5).
 */
export async function createQuoteVersion(
  db: Db, accountId: string, actor: QuoteActor, quoteId: string, input: QuoteInput, now = new Date(), customs?: Record<string, number>,
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
  const p = await price(db, accountId, input, customs);
  if (!p.ok) return p.reason === "pricing" ? { ok: false, reason: "pricing", errors: p.errors } : { ok: false, reason: p.reason };
  if (!p.fit.ok) return { ok: false, reason: "fit", problems: p.fit.problems };
  const decided = statusFor(p.priced.approvalReasons, p.priced.complete, actor);
  const status = approvingUserId && p.priced.complete ? "draft" : decided.status;
  const approvedBy = approvingUserId && p.priced.complete ? approvingUserId : decided.approvedBy;
  const next = q.currentVersion + 1;
  const { v, lines } = versionRows(accountId, q.id, next, p, actor, input, now, approvedBy);
  try {
    await atomic(db, (tx) => [
      tx.insert(quoteVersions).values(v),
      ...lines.map((l) => tx.insert(quoteLines).values(l)),
      // Guarded on the current version so two concurrent edits can't both win.
      tx.update(quotes).set({ currentVersion: next, status }).where(and(eq(quotes.id, q.id), eq(quotes.currentVersion, q.currentVersion))),
      tx.insert(leadEvents).values({
        accountId, leadId: q.leadId, type: "quote.versioned", actor: actor.kind, actorUserId: actor.kind === "human" ? actor.userId : null,
        data: { quoteId: q.id, number: q.number, version: next, note: v.changeNote, status },
      }),
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
  const quote = (await quoteOf(db, accountId, q.id))!;
  const [version] = await db.select().from(quoteVersions).where(eq(quoteVersions.id, v.id));
  if (actor.kind === "human") {
    await writeAudit(db, { userId: actor.userId, actingAs: actor.actingAs }, { accountId, action: "quote.versioned", targetType: "quote", targetId: q.id, details: { version: next } });
  }
  return { ok: true, quote, version, reused: false };
}

/**
 * "Approve and send" (canvas: Orders): a person prices custom lines and/or
 * accepts the discount. Same lines → the current version is approved; custom
 * prices → a new, approved version.
 */
export async function approveQuote(
  db: Db, accountId: string, actor: { userId: string; actingAs: boolean }, quoteId: string, customPrices: Record<string, number>, now = new Date(),
): Promise<QuoteResult> {
  const q = await quoteOf(db, accountId, quoteId);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (q.status !== "awaiting_approval") return { ok: false, reason: "quote_closed" };
  const current = await currentVersionOf(db, q);
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, current.id)).orderBy(asc(quoteLines.sortOrder));
  const missing = lines.some((l) => l.unitPriceMinor === null && customPrices[l.sku] === undefined);
  if (missing) return { ok: false, reason: "pricing", errors: lines.filter((l) => l.unitPriceMinor === null && customPrices[l.sku] === undefined).map((l) => ({ kind: "bad_custom_price" as const, sku: l.sku })) };
  const human: QuoteActor = { kind: "human", ...actor };
  if (Object.keys(customPrices).length > 0) {
    // Keep prices a person already set on earlier custom lines.
    const carried: Record<string, number> = {};
    for (const l of lines) if (l.priceSource === "custom" && l.unitPriceMinor !== null) carried[l.sku] = l.unitPriceMinor;
    return createQuoteVersion(
      db, accountId, human, q.id,
      { lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })), discountBp: current.discountBp, changeNote: "Priced and approved by the seller" },
      now, { ...carried, ...customPrices }, actor.userId,
    );
  }
  await atomic(db, (tx) => [
    tx.update(quoteVersions).set({ approvedByUserId: actor.userId, approvedAt: now }).where(eq(quoteVersions.id, current.id)),
    tx.update(quotes).set({ status: "draft" }).where(and(eq(quotes.id, q.id), eq(quotes.status, "awaiting_approval"))),
    tx.insert(leadEvents).values({ accountId, leadId: q.leadId, type: "quote.approved", actor: "human", actorUserId: actor.userId, data: { quoteId: q.id, number: q.number, version: current.version, reasons: current.approvalReasons.map(approvalReasonText) } }),
  ]);
  await writeAudit(db, actor, { accountId, action: "quote.approved", targetType: "quote", targetId: q.id, details: { version: current.version } });
  const quote = (await quoteOf(db, accountId, q.id))!;
  const [version] = await db.select().from(quoteVersions).where(eq(quoteVersions.id, current.id));
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

/** Display status: "Expires today" / "Expired" are derived from the valid-until date. */
export function displayQuoteStatus(status: QuoteStatus, validUntil: Date, now = new Date()): "draft" | "awaiting_approval" | "sent" | "expires_today" | "expired" | "replaced" | "cancelled" {
  if (status === "draft" || status === "sent") {
    if (validUntil.getTime() <= now.getTime()) return "expired";
    if (validUntil.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return "expires_today";
  }
  return status;
}

export type QuoteTab = "quotes" | "approval";

export async function listQuotes(db: Db, accountId: string, tab: QuoteTab = "quotes") {
  const rows = await db
    .select({ quote: quotes, version: quoteVersions, lead: leads })
    .from(quotes)
    .innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.currentVersion)))
    .innerJoin(leads, eq(leads.id, quotes.leadId))
    .where(and(eq(quotes.accountId, accountId), eq(leads.isTest, false), ...(tab === "approval" ? [eq(quotes.status, "awaiting_approval")] : [])))
    .orderBy(desc(quotes.createdAt))
    .limit(200);
  return rows;
}

export async function countAwaitingApproval(db: Db, accountId: string) {
  const [{ n }] = await db.select({ n: count() }).from(quotes).innerJoin(leads, eq(leads.id, quotes.leadId))
    .where(and(eq(quotes.accountId, accountId), eq(leads.isTest, false), eq(quotes.status, "awaiting_approval")));
  return n;
}

export async function countQuotes(db: Db, accountId: string) {
  const [{ n }] = await db.select({ n: count() }).from(quotes).innerJoin(leads, eq(leads.id, quotes.leadId)).where(and(eq(quotes.accountId, accountId), eq(leads.isTest, false)));
  return n;
}

export async function getQuote(db: Db, accountId: string, quoteId: string) {
  const q = await quoteOf(db, accountId, quoteId);
  if (!q) return null;
  const [lead] = await db.select().from(leads).where(eq(leads.id, q.leadId));
  const versions = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, q.id)).orderBy(desc(quoteVersions.version));
  const lines = versions.length
    ? await db.select().from(quoteLines).where(inArray(quoteLines.quoteVersionId, versions.map((v) => v.id))).orderBy(asc(quoteLines.sortOrder))
    : [];
  return {
    quote: q,
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
  const out: { quote: typeof quotes.$inferSelect; version: typeof quoteVersions.$inferSelect; older: (typeof quoteVersions.$inferSelect)[] }[] = [];
  for (const r of rows) {
    const cur = out.find((o) => o.quote.id === r.quote.id);
    if (!cur) out.push({ quote: r.quote, version: r.version, older: [] });
    else cur.older.push(r.version);
  }
  return out.map((o) => {
    const current = [o.version, ...o.older].find((v) => v.version === o.quote.currentVersion) ?? o.version;
    return { quote: o.quote, version: current, older: [o.version, ...o.older].filter((v) => v.version !== current.version) };
  });
}

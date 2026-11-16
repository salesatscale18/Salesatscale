/**
 * Order forms, signatures and orders (P5.3–P5.6). Every function is scoped by
 * account (seller side) or by a verified link token (buyer side).
 *
 * Rules (mvp-plan 3.2, 3.5): the order is binding when the buyer signs; it is
 * paid only when a verified payment event arrives (lib/payments/events.ts) or a
 * person confirms a bank transfer. Snapshots and signatures are never updated.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  catalogItems, catalogVersions, dealStates, leadEvents, leads, markets, orderForms, orders, paymentAttempts, priceLists, quoteLines, quoteVersions, quotes, sellerAccounts, signatures,
  type OrderForm, type OrderFormField, type OrderSnapshot, type RecurringPeriod, type UnitCustom,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { priceQuote } from "@/lib/catalog/pricing";
import { itemsOf, publishedCatalog } from "@/lib/catalog/service";
import { marketLegal } from "@/lib/markets/legal";
import { resolveMarket } from "@/lib/markets/service";
import { accountDefaultsFrom, effectiveSettings } from "@/lib/markets/settings";
import { fakePaymentsEnabled } from "@/lib/payments/mode";
import { priceWithList } from "@/lib/pricing/engine";
import { entriesOf, livePriceList } from "@/lib/pricing/price-lists";
import { customPricesOf, customsFor, engineItems, enginePriceList, requestLinesOf } from "@/lib/quotes/pricing";
import { createQuoteVersion, getQuote } from "@/lib/quotes/service";
import { orderFormPrefill } from "./prefill";
import { getOrderFormSettings } from "./settings";
import { formIdFromToken, hashToken, publicUrl, tokenFor } from "./token";

const DAY_MS = 86_400_000;

/**
 * A snapshot line. Forms made from price-list quotes also say which charge the
 * line is (one-time or recurring, with its period) and its unit; older
 * snapshots have only `recurring`. The stored type (db/schema.ts OrderSnapshot)
 * is unchanged: these fields are optional extras in the same jsonb.
 */
export type SnapshotLine = OrderSnapshot["lines"][number] & {
  charge?: "one_time" | "recurring";
  period?: RecurringPeriod | null;
  unit?: string;
  unitCustom?: UnitCustom | null;
  /** "list" | "tier" | "custom" | "not_charged" */
  priceSource?: string;
};
export type FormSnapshot = Omit<OrderSnapshot, "lines"> & {
  lines: SnapshotLine[];
  /** Period of the recurring total; missing on older snapshots (= month). */
  recurringPeriod?: RecurringPeriod | null;
  taxRateBp?: number;
  /** The price list version the quote was priced from; missing on catalog-priced snapshots. */
  priceList?: { name: string; version: number } | null;
};

/** The snapshot with the optional price-list fields typed. */
export const snapshotOf = (form: Pick<OrderForm, "snapshot">) => form.snapshot as FormSnapshot;
export const chargeOf = (l: Pick<SnapshotLine, "charge" | "recurring">): "one_time" | "recurring" => l.charge ?? (l.recurring ? "recurring" : "one_time");

export type FormActor = { kind: "human"; userId: string; actingAs: boolean } | { kind: "agent" };

export function orderLabel(tradeName: string, number: number) {
  const initials = tradeName.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return `${initials || "OR"}-${number}`;
}

export const formPath = (token: string) => `/f/${token}`;

// ---------------------------------------------------------------------------
// Seller / agent side: create the link
// ---------------------------------------------------------------------------

export type CreateFormResult =
  | { ok: true; form: OrderForm; token: string; url: string }
  | { ok: false; reason: "quote_not_found" | "quote_not_ready" | "quote_expired" | "price_missing" | "lead_opted_out" | "no_legal" | "account_paused" };

export async function createOrderForm(
  db: Db, accountId: string, actor: FormActor, quoteId: string, opts: { language?: string } = {}, now = new Date(),
): Promise<CreateFormResult> {
  const q = await getQuote(db, accountId, quoteId);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (q.quote.status !== "draft" && q.quote.status !== "sent") return { ok: false, reason: "quote_not_ready" };
  if (q.lead.status === "opted_out") return { ok: false, reason: "lead_opted_out" };
  const cur = q.versions[0];
  if (cur.version.validUntil.getTime() <= now.getTime()) return { ok: false, reason: "quote_expired" };
  if (cur.lines.some((l) => l.unitPriceMinor === null || l.lineTotalMinor === null)) return { ok: false, reason: "price_missing" };

  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (account.status === "paused") return { ok: false, reason: "account_paused" };
  const v = cur.version;
  // The quote's market decides languages, legal texts and payment methods.
  const market = await resolveMarket(db, accountId, v.marketId ?? q.quote.marketId ?? q.lead.marketId);
  const itemIds = [...new Set(cur.lines.map((l) => l.catalogItemId).filter((x): x is string => !!x))];
  const [settings, sections, [list], [catalogVersion], units, [deal]] = await Promise.all([
    getOrderFormSettings(db, accountId),
    marketLegal(db, accountId, market.id),
    v.priceListId ? db.select().from(priceLists).where(and(eq(priceLists.id, v.priceListId), eq(priceLists.accountId, accountId))) : Promise.resolve([]),
    db.select({ version: catalogVersions.version }).from(catalogVersions).where(and(eq(catalogVersions.id, v.catalogVersionId), eq(catalogVersions.accountId, accountId))),
    itemIds.length
      ? db.select({ id: catalogItems.id, unitCustom: catalogItems.unitCustom }).from(catalogItems).where(and(eq(catalogItems.accountId, accountId), inArray(catalogItems.id, itemIds)))
      : Promise.resolve([]),
    db.select({ fields: dealStates.fields }).from(dealStates).where(and(eq(dealStates.accountId, accountId), eq(dealStates.leadId, q.lead.id))),
  ]);
  const eff = effectiveSettings(accountDefaultsFrom(account, settings), market, list ?? null);
  const languages = eff.languages.value;
  const language = opts.language && languages.includes(opts.language) ? opts.language : q.lead.language && languages.includes(q.lead.language) ? q.lead.language : languages[0] ?? "en";
  const legal = sections.filter((s) => s.language === language);
  if (legal.length === 0) return { ok: false, reason: "no_legal" };
  const unitCustomOf = new Map(units.map((u) => [u.id, u.unitCustom ?? null]));

  const lines: SnapshotLine[] = cur.lines.map((l) => ({
    sku: l.sku, name: l.name, qty: l.qty, unitPriceMinor: l.unitPriceMinor!, lineTotalMinor: l.lineTotalMinor!, recurring: l.chargeType === "recurring",
    charge: l.chargeType, period: l.chargeType === "recurring" ? ((l.period as RecurringPeriod | null) ?? "month") : null,
    unit: l.unit, unitCustom: l.catalogItemId ? unitCustomOf.get(l.catalogItemId) ?? null : null, priceSource: l.priceSource,
  }));
  const snapshot: FormSnapshot = {
    seller: { tradeName: account.tradeName, legalName: account.legalName, brandColor: settings.brandColor },
    quote: { number: q.quote.number, version: v.version, catalogVersion: catalogVersion?.version ?? 0 },
    currency: v.currency,
    pricesIncludeTax: v.pricesIncludeTax,
    taxRateBp: v.taxRateBp,
    lines,
    oneTime: { subtotalMinor: v.oneTimeSubtotalMinor, discountMinor: v.oneTimeDiscountMinor, taxMinor: v.oneTimeTaxMinor, totalMinor: v.oneTimeTotalMinor },
    recurring: { subtotalMinor: v.recurringSubtotalMinor, discountMinor: v.recurringDiscountMinor, taxMinor: v.recurringTaxMinor, totalMinor: v.recurringTotalMinor },
    recurringPeriod: (v.recurringPeriod as RecurringPeriod | null) ?? null,
    priceList: list ? { name: list.name, version: list.version } : null,
    validUntil: v.validUntil.toISOString(),
    legal: legal.map((s) => ({ key: s.sectionKey, title: s.title, version: s.version, body: s.body })),
    fields: settings.fields,
    // What the conversation learned fills the form (lib/orders/prefill.ts maps deal-state keys to fields).
    prefill: orderFormPrefill(q.lead, deal?.fields),
    paymentMethods: eff.paymentMethods.value,
    bankDetails: eff.bankDetails.value,
    supportContact: account.supportContact ?? null,
  };

  const id = randomUUID();
  const token = tokenFor(id);
  const expiresAt = new Date(Math.min(now.getTime() + settings.linkValidDays * DAY_MS, v.validUntil.getTime()));
  await atomic(db, (tx) => [
    tx.update(orderForms).set({ status: "link_expired", supersededById: id })
      .where(and(eq(orderForms.accountId, accountId), eq(orderForms.quoteId, quoteId), inArray(orderForms.status, ["sent", "opened"]))),
    tx.insert(orderForms).values({
      id, accountId, leadId: q.lead.id, quoteId, quoteVersionId: v.id, tokenHash: hashToken(token), language, snapshot: snapshot as OrderSnapshot, expiresAt, marketId: market.id,
      createdBy: actor.kind, createdByUserId: actor.kind === "human" ? actor.userId : null, createdAt: now,
    }),
    tx.update(quotes).set({ status: "sent" }).where(and(eq(quotes.id, quoteId), eq(quotes.accountId, accountId))),
    tx.insert(leadEvents).values({
      accountId, leadId: q.lead.id, type: "order_form.sent", actor: actor.kind, actorUserId: actor.kind === "human" ? actor.userId : null,
      data: { quoteId, number: q.quote.number, version: v.version, formId: id },
    }),
  ]);
  if (actor.kind === "human" && actor.actingAs) {
    await writeAudit(db, { userId: actor.userId, actingAs: true }, { accountId, action: "order_form.sent", targetType: "order_form", targetId: id });
  }
  const [form] = await db.select().from(orderForms).where(eq(orderForms.id, id));
  return { ok: true, form, token, url: publicUrl(formPath(token)) };
}

/** The current link of an open form (the token is derived, never stored). */
export function linkFor(form: Pick<OrderForm, "id">) {
  const token = tokenFor(form.id);
  return { token, url: publicUrl(formPath(token)) };
}

// ---------------------------------------------------------------------------
// Buyer side: open the link
// ---------------------------------------------------------------------------

export type FormView =
  | { state: "open"; form: OrderForm }
  | { state: "signed"; form: OrderForm; order: typeof orders.$inferSelect }
  | { state: "expired"; form: OrderForm }
  | { state: "updated"; form: OrderForm; newer: { token: string; snapshot: OrderSnapshot } | null; changeNote: string | null };

export async function loadForm(db: Db, token: string, now = new Date()): Promise<FormView | null> {
  const id = formIdFromToken(token);
  if (!id) return null;
  const [form] = await db.select().from(orderForms).where(and(eq(orderForms.id, id), eq(orderForms.tokenHash, hashToken(token))));
  if (!form) return null;
  if (form.status === "signed") {
    const [order] = await db.select().from(orders).where(eq(orders.orderFormId, form.id));
    return { state: "signed", form, order };
  }
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, form.quoteId));
  if (quote.status === "cancelled") return { state: "expired", form };
  // Past its own expiry the link is expired, even when a newer offer exists:
  // an expired link never hands out a newer one.
  if (form.expiresAt.getTime() <= now.getTime()) return { state: "expired", form };
  const replaced = form.supersededById !== null || quote.currentVersion !== form.snapshot.quote.version;
  if (replaced) {
    const [newest] = await db.select().from(orderForms)
      .where(and(eq(orderForms.quoteId, form.quoteId), inArray(orderForms.status, ["sent", "opened"])))
      .orderBy(desc(orderForms.createdAt)).limit(1);
    const newer = newest && newest.id !== form.id && newest.expiresAt.getTime() > now.getTime() ? { token: tokenFor(newest.id), snapshot: newest.snapshot } : null;
    const [cur] = await db.select({ changeNote: quoteVersions.changeNote }).from(quoteVersions)
      .where(and(eq(quoteVersions.quoteId, form.quoteId), eq(quoteVersions.version, quote.currentVersion)));
    return { state: "updated", form, newer, changeNote: cur?.changeNote ?? null };
  }
  if (form.status === "link_expired") return { state: "expired", form };
  return { state: "open", form };
}

/** First view: Sent → Opened, once. */
export async function markOpened(db: Db, form: OrderForm, now = new Date()) {
  if (form.status !== "sent") return;
  const updated = await db.update(orderForms).set({ status: "opened", openedAt: now }).where(and(eq(orderForms.id, form.id), eq(orderForms.status, "sent"))).returning({ id: orderForms.id });
  if (updated.length) {
    await db.insert(leadEvents).values({ accountId: form.accountId, leadId: form.leadId, type: "order_form.opened", actor: "buyer", data: { quoteId: form.quoteId, number: form.snapshot.quote.number, version: form.snapshot.quote.version } });
  }
}

export type PriceCheckLine = {
  sku: string; name: string; qty: number;
  charge: "one_time" | "recurring";
  /** Recurring period ("month" | "year"); null for one-time lines. */
  period: RecurringPeriod | null;
  beforeMinor: number; nowMinor: number;
  recurring: boolean;
};

export type PriceCheck =
  | { status: "same" }
  | {
    status: "changed"; lines: PriceCheckLine[]; oneTimeMinor: number; recurringMinor: number; recurringPeriod: RecurringPeriod | null;
    /** Today's VAT basis and totals, so the screen can show before VAT / VAT / Due today like the main buyer page. */
    pricesIncludeTax: boolean; oneTime: PriceCheckTotals; recurring: PriceCheckTotals;
  }
  | { status: "unavailable" };

export type PriceCheckTotals = { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number };
const totalsOf = (t: PriceCheckTotals): PriceCheckTotals => ({ subtotalMinor: t.subtotalMinor, discountMinor: t.discountMinor, taxMinor: t.taxMinor, totalMinor: t.totalMinor });

const lineKey = (sku: string, charge: string) => `${sku}|${charge}`;

/**
 * Re-prices the snapshot against the live price list of the form's market
 * (mvp-plan 3.5: before signing and payment), line by line and charge by
 * charge. The quote froze the price list version it was priced from: the
 * same live version means the same prices (one query). Forms of quotes priced
 * from the catalog (before price lists) are checked against the catalog.
 */
export async function priceCheck(db: Db, form: OrderForm): Promise<PriceCheck> {
  const [row] = await db
    .select({ priceListId: quoteVersions.priceListId, discountBp: quoteVersions.discountBp, removedAutoAdd: quoteVersions.removedAutoAdd, market: markets, live: priceLists })
    .from(quoteVersions)
    .leftJoin(markets, and(eq(markets.id, quoteVersions.marketId), eq(markets.accountId, quoteVersions.accountId)))
    .leftJoin(priceLists, and(eq(priceLists.accountId, quoteVersions.accountId), eq(priceLists.lineageId, markets.priceListLineageId), eq(priceLists.status, "live")))
    .where(and(eq(quoteVersions.id, form.quoteVersionId), eq(quoteVersions.accountId, form.accountId)));
  if (!row) return { status: "unavailable" };
  if (!row.priceListId) return catalogPriceCheck(db, form);
  let live = row.live;
  if (!row.market) {
    // The market was removed: the lead is served by the home market now.
    const home = await resolveMarket(db, form.accountId, null);
    live = home.priceListLineageId ? (await livePriceList(db, form.accountId, home.priceListLineageId))?.list ?? null : null;
  }
  if (!live) return { status: "unavailable" };
  // Price list versions never change once live: same version, same prices.
  if (live.id === row.priceListId) return { status: "same" };

  const [entries, catalog, lines] = await Promise.all([
    entriesOf(db, form.accountId, live.id),
    publishedCatalog(db, form.accountId),
    db.select({ sku: quoteLines.sku, qty: quoteLines.qty, chargeType: quoteLines.chargeType, unitPriceMinor: quoteLines.unitPriceMinor, priceSource: quoteLines.priceSource })
      .from(quoteLines).where(and(eq(quoteLines.quoteVersionId, form.quoteVersionId), eq(quoteLines.accountId, form.accountId))).orderBy(quoteLines.sortOrder),
  ]);
  if (!catalog) return { status: "unavailable" };
  const custom = customPricesOf(lines);
  const entryBySku = new Map(entries.map((e) => [e.sku, e]));
  const r = priceWithList({
    items: engineItems(catalog),
    entries,
    priceList: enginePriceList(live),
    // The stored lines already hold the auto-added ones: no rules applied again,
    // so a line the buyer removed stays out. The removals go along regardless.
    lines: requestLinesOf(lines).map((l) => ({ ...l, ...customsFor(custom, l.sku, entryBySku.get(l.sku)) })),
    removedByBuyer: row.removedAutoAdd,
    discountBp: row.discountBp,
    maxDiscountBp: 10_000,
  });
  // Not sold any more, or a price is missing: the buyer can't sign this offer.
  if (!r.ok || !r.complete) return { status: "unavailable" };
  const s = snapshotOf(form);
  const now = new Map(r.lines.map((l) => [lineKey(l.sku, l.charge), l]));
  const before = new Set(s.lines.map((l) => lineKey(l.sku, chargeOf(l))));
  const out: PriceCheckLine[] = s.lines.map((l) => {
    const charge = chargeOf(l);
    const n = now.get(lineKey(l.sku, charge));
    return { sku: l.sku, name: l.name, qty: l.qty, charge, period: charge === "recurring" ? n?.period ?? l.period ?? "month" : null, beforeMinor: l.lineTotalMinor, nowMinor: n?.lineTotalMinor ?? 0, recurring: charge === "recurring" };
  });
  // A charge the new price list adds (for example a new monthly fee).
  for (const n of r.lines) {
    if (!before.has(lineKey(n.sku, n.charge))) {
      out.push({ sku: n.sku, name: n.name, qty: n.qty, charge: n.charge, period: n.period, beforeMinor: 0, nowMinor: n.lineTotalMinor ?? 0, recurring: n.charge === "recurring" });
    }
  }
  const same = r.currency === s.currency
    && r.oneTime.totalMinor === s.oneTime.totalMinor
    && r.recurring.totalMinor === s.recurring.totalMinor
    && out.every((l) => l.beforeMinor === l.nowMinor && now.has(lineKey(l.sku, l.charge)) && before.has(lineKey(l.sku, l.charge)));
  if (same) return { status: "same" };
  return {
    status: "changed", lines: out, oneTimeMinor: r.oneTime.totalMinor, recurringMinor: r.recurring.totalMinor, recurringPeriod: r.recurringPeriod,
    pricesIncludeTax: live.pricesIncludeTax, oneTime: totalsOf(r.oneTime), recurring: totalsOf(r.recurring),
  };
}

/** Forms of quotes priced from the catalog (before price lists): compared with today's published catalog. */
async function catalogPriceCheck(db: Db, form: OrderForm): Promise<PriceCheck> {
  const [row] = await db.select({ catalogVersionId: quoteVersions.catalogVersionId, discountBp: quoteVersions.discountBp, published: catalogVersions })
    .from(quoteVersions)
    .leftJoin(catalogVersions, and(eq(catalogVersions.accountId, quoteVersions.accountId), eq(catalogVersions.status, "published")))
    .where(and(eq(quoteVersions.id, form.quoteVersionId), eq(quoteVersions.accountId, form.accountId)));
  if (!row || !row.published) return { status: "unavailable" };
  if (row.published.id === row.catalogVersionId) return { status: "same" };
  const published = row.published;
  const [items, lines] = await Promise.all([
    itemsOf(db, form.accountId, published.id),
    db.select({ sku: quoteLines.sku, unitPriceMinor: quoteLines.unitPriceMinor, priceSource: quoteLines.priceSource }).from(quoteLines)
      .where(and(eq(quoteLines.quoteVersionId, form.quoteVersionId), eq(quoteLines.accountId, form.accountId))),
  ]);
  const custom: Record<string, number> = {};
  for (const l of lines) if (l.priceSource === "custom" && l.unitPriceMinor !== null) custom[l.sku] = l.unitPriceMinor;
  const r = priceQuote({
    items,
    lines: form.snapshot.lines.map((l) => ({ sku: l.sku, qty: l.qty, ...(custom[l.sku] !== undefined ? { customUnitPriceMinor: custom[l.sku] } : {}) })),
    discountBp: row.discountBp,
    maxDiscountBp: 10_000,
    pricesIncludeTax: published.pricesIncludeTax,
    taxRateBp: published.taxRateBp,
  });
  if (!r.ok || !r.complete) return { status: "unavailable" };
  const s = form.snapshot;
  if (r.oneTime.totalMinor === s.oneTime.totalMinor && r.recurring.totalMinor === s.recurring.totalMinor) return { status: "same" };
  return {
    status: "changed",
    lines: s.lines.map((l) => {
      const n = r.lines.find((x) => x.sku === l.sku);
      const charge = l.recurring ? "recurring" as const : "one_time" as const;
      return { sku: l.sku, name: l.name, qty: l.qty, charge, period: l.recurring ? "month" as const : null, beforeMinor: l.lineTotalMinor, nowMinor: n?.lineTotalMinor ?? l.lineTotalMinor, recurring: l.recurring };
    }),
    oneTimeMinor: r.oneTime.totalMinor,
    recurringMinor: r.recurring.totalMinor,
    recurringPeriod: r.recurring.totalMinor ? "month" : null,
    pricesIncludeTax: published.pricesIncludeTax, oneTime: totalsOf(r.oneTime), recurring: totalsOf(r.recurring),
  };
}

/** "Accept new total": a new quote version from today's price list and a new link. The old link stops working. */
export async function acceptNewPrice(db: Db, token: string, now = new Date()): Promise<{ ok: true; token: string } | { ok: false; reason: "not_open" | "needs_approval" | "failed" }> {
  const view = await loadForm(db, token, now);
  if (!view || view.state !== "open") return { ok: false, reason: "not_open" };
  // Only when the price really changed; otherwise a link holder could churn quote versions.
  if ((await priceCheck(db, view.form)).status !== "changed") return { ok: false, reason: "not_open" };
  const q = await getQuote(db, view.form.accountId, view.form.quoteId);
  const v = q?.versions.find((x) => x.version.id === view.form.quoteVersionId);
  if (!q || !v) return { ok: false, reason: "failed" };
  const r = await createQuoteVersion(db, view.form.accountId, { kind: "agent" }, q.quote.id, {
    // The new version re-applies the catalog's auto-add rules: the buyer's removals keep their lines out.
    lines: requestLinesOf(v.lines), discountBp: v.version.discountBp, removedByBuyer: v.version.removedAutoAdd,
    changeNote: "Price updated from the price list; accepted by the buyer",
  }, now, customPricesOf(v.lines));
  if (!r.ok) return { ok: false, reason: "failed" };
  if (r.quote.status === "awaiting_approval") return { ok: false, reason: "needs_approval" };
  const f = await createOrderForm(db, view.form.accountId, { kind: "agent" }, q.quote.id, { language: view.form.language }, now);
  return f.ok ? { ok: true, token: f.token } : { ok: false, reason: "failed" };
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export type SignInput = { fields: Partial<Record<OrderFormField, string>>; fullName: string; role: string; agreed: boolean };
export type SignErrors = Partial<Record<OrderFormField | "full_name" | "agreed", "required" | "invalid">>;

const OPTIONAL: OrderFormField[] = ["po_number"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSignature(snapshot: OrderSnapshot, input: SignInput): SignErrors {
  const e: SignErrors = {};
  for (const f of snapshot.fields) {
    if (f === "signatory_role") continue;
    const v = (input.fields[f] ?? "").trim();
    if (!v && !OPTIONAL.includes(f)) e[f] = "required";
    else if (v && f === "invoice_email" && !EMAIL.test(v)) e[f] = "invalid";
  }
  if (snapshot.fields.includes("signatory_role") && !input.role.trim()) e.signatory_role = "required";
  if (input.fullName.trim().length < 2) e.full_name = "required";
  if (!input.agreed) e.agreed = "required";
  return e;
}

export type SignResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: "not_open" | "price_changed" | "unavailable" }
  | { ok: false; reason: "invalid"; errors: SignErrors };

export async function signForm(db: Db, token: string, input: SignInput, meta: { ip?: string | null; userAgent?: string | null }, now = new Date()): Promise<SignResult> {
  const view = await loadForm(db, token, now);
  if (!view || view.state !== "open") return { ok: false, reason: "not_open" };
  const form = view.form;
  const errors = validateSignature(form.snapshot, input);
  if (Object.keys(errors).length) return { ok: false, reason: "invalid", errors };
  const [check, paused] = await Promise.all([priceCheck(db, form), accountPaused(db, form.accountId)]);
  if (paused) return { ok: false, reason: "unavailable" };
  if (check.status !== "same") return { ok: false, reason: check.status === "changed" ? "price_changed" : "unavailable" };

  const buyerFields: Record<string, string> = {};
  for (const f of form.snapshot.fields) if (f !== "signatory_role") buyerFields[f] = (input.fields[f] ?? "").trim().slice(0, 300);
  const legalVersions = form.snapshot.legal.map((l) => ({ key: l.key, version: l.version }));
  const documentHash = createHash("sha256")
    .update(JSON.stringify({ snapshot: form.snapshot, buyerFields, fullName: input.fullName.trim(), role: input.role.trim(), signedAt: now.toISOString() }))
    .digest("hex");
  const orderId = randomUUID();
  const s = form.snapshot;

  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ top }] = await db.select({ top: max(orders.number) }).from(orders).where(eq(orders.accountId, form.accountId));
    try {
      await atomic(db, (tx) => [
        tx.insert(signatures).values({
          id: randomUUID(), accountId: form.accountId, orderFormId: form.id, fullName: input.fullName.trim().slice(0, 120), role: input.role.trim().slice(0, 80) || null,
          buyerFields, agreed: true, legalVersions, documentHash, ip: meta.ip?.slice(0, 64) ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, signedAt: now,
        }),
        tx.update(orderForms).set({ status: "signed", signedAt: now }).where(and(eq(orderForms.id, form.id), inArray(orderForms.status, ["sent", "opened"]))),
        tx.insert(orders).values({
          id: orderId, accountId: form.accountId, leadId: form.leadId, quoteId: form.quoteId, orderFormId: form.id, number: (top ?? 10_000) + 1,
          currency: s.currency, amountDueMinor: s.oneTime.totalMinor, recurringMinor: s.recurring.totalMinor, marketId: form.marketId, createdAt: now,
        }),
        tx.insert(leadEvents).values({
          accountId: form.accountId, leadId: form.leadId, type: "order_form.signed", actor: "buyer",
          data: { quoteId: form.quoteId, number: s.quote.number, version: s.quote.version, orderId, signedBy: input.fullName.trim().slice(0, 120) },
        }),
        tx.update(leads).set({ lastActivityAt: now }).where(eq(leads.id, form.leadId)),
      ]);
      return { ok: true, orderId };
    } catch (e) {
      const again = await loadForm(db, token, now);
      if (again?.state === "signed") return { ok: true, orderId: again.order.id };
      if (attempt === 2) throw e;
    }
  }
  return { ok: false, reason: "not_open" };
}

// ---------------------------------------------------------------------------
// Pay (the provider confirms; see lib/payments)
// ---------------------------------------------------------------------------

export type StartPaymentResult =
  | { ok: true; kind: "card"; attemptId: string; providerRef: string }
  | { ok: true; kind: "bank_transfer" }
  | { ok: false; reason: "not_signed" | "already_paid" | "method_off" | "recurring_consent" | "price_changed" | "unavailable" };

export async function startPayment(
  db: Db, token: string, opts: { method: "card" | "bank_transfer"; recurringConsent: boolean }, now = new Date(),
): Promise<StartPaymentResult> {
  const view = await loadForm(db, token, now);
  if (!view || view.state !== "signed") return { ok: false, reason: "not_signed" };
  const { form, order } = view;
  if (order.paymentStatus === "paid") return { ok: false, reason: "already_paid" };
  const methods = form.snapshot.paymentMethods;
  if ((opts.method === "card" && !methods.card) || (opts.method === "bank_transfer" && !methods.bankTransfer)) return { ok: false, reason: "method_off" };
  // Card needs a provider (only the test one exists today); a chosen bank transfer stays a bank transfer.
  if (opts.method === "card" && (!fakePaymentsEnabled() || order.paymentStatus === "bank_transfer_expected")) return { ok: false, reason: "method_off" };
  const [check, paused] = await Promise.all([priceCheck(db, form), accountPaused(db, form.accountId)]);
  if (paused) return { ok: false, reason: "unavailable" };
  if (check.status !== "same") return { ok: false, reason: check.status === "changed" ? "price_changed" : "unavailable" };

  if (opts.method === "bank_transfer") {
    if (order.paymentStatus === "bank_transfer_expected") return { ok: true, kind: "bank_transfer" };
    await atomic(db, (tx) => [
      tx.update(orders).set({ paymentStatus: "bank_transfer_expected", paymentMethod: "bank_transfer" }).where(eq(orders.id, order.id)),
      tx.insert(leadEvents).values({ accountId: form.accountId, leadId: form.leadId, type: "payment.bank_transfer", actor: "buyer", data: { orderId: order.id, number: order.number } }),
    ]);
    return { ok: true, kind: "bank_transfer" };
  }
  if (order.recurringMinor > 0 && !opts.recurringConsent) return { ok: false, reason: "recurring_consent" };
  const attemptId = randomUUID();
  const providerRef = `fake_${randomUUID().replace(/-/g, "")}`;
  await atomic(db, (tx) => [
    tx.insert(paymentAttempts).values({ id: attemptId, accountId: form.accountId, orderId: order.id, provider: "fake", providerRef, amountMinor: order.amountDueMinor, currency: order.currency, createdAt: now }),
    tx.update(orders).set({ paymentStatus: "pending", paymentMethod: "card", recurringConsent: opts.recurringConsent }).where(eq(orders.id, order.id)),
  ]);
  return { ok: true, kind: "card", attemptId, providerRef };
}

/** The open attempt the buyer's payment step is on (card). */
export async function pendingAttempt(db: Db, orderId: string) {
  const [a] = await db.select().from(paymentAttempts).where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, "pending"))).orderBy(desc(paymentAttempts.createdAt)).limit(1);
  return a ?? null;
}

/** A paused account takes no new signatures or payments and sends no new links. */
export async function accountPaused(db: Db, accountId: string) {
  const [a] = await db.select({ status: sellerAccounts.status }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  return a?.status === "paused";
}

export async function lastAttempt(db: Db, orderId: string) {
  const [a] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId)).orderBy(desc(paymentAttempts.createdAt)).limit(1);
  return a ?? null;
}

export async function attemptCount(db: Db, orderId: string) {
  const [r] = await db.select({ n: count() }).from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));
  return r?.n ?? 0;
}

/** Seller confirms a bank transfer arrived. Only bank-transfer orders; audited. */
export async function markBankTransferReceived(db: Db, actor: Actor & { userId: string }, accountId: string, orderId: string, now = new Date()) {
  const [order] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.accountId, accountId)));
  if (!order) return { ok: false as const, reason: "not_found" as const };
  if (order.paymentMethod !== "bank_transfer" || order.paymentStatus !== "bank_transfer_expected") return { ok: false as const, reason: "not_bank_transfer" as const };
  await atomic(db, (tx) => [
    tx.update(orders).set({ paymentStatus: "paid", paidAt: now, markedPaidByUserId: actor.userId }).where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "bank_transfer_expected"))),
    tx.update(leads).set({ status: "won", lastActivityAt: now }).where(eq(leads.id, order.leadId)),
    tx.insert(leadEvents).values({ accountId, leadId: order.leadId, type: "order.paid", actor: "human", actorUserId: actor.userId, data: { orderId: order.id, number: order.number, method: "bank_transfer" } }),
  ]);
  await writeAudit(db, actor, { accountId, action: "order.bank_transfer_received", targetType: "order", targetId: order.id, details: { number: order.number, amountMinor: order.amountDueMinor } });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Seller views
// ---------------------------------------------------------------------------

/** A quote's order forms, newest first, without the (large) snapshot. */
export async function formsForQuote(db: Db, accountId: string, quoteId: string) {
  return db.select({
    id: orderForms.id, accountId: orderForms.accountId, leadId: orderForms.leadId, quoteId: orderForms.quoteId,
    quoteVersionId: orderForms.quoteVersionId, tokenHash: orderForms.tokenHash, language: orderForms.language,
    status: orderForms.status, expiresAt: orderForms.expiresAt, supersededById: orderForms.supersededById,
    openedAt: orderForms.openedAt, signedAt: orderForms.signedAt, createdBy: orderForms.createdBy,
    createdByUserId: orderForms.createdByUserId, createdAt: orderForms.createdAt,
  }).from(orderForms).where(and(eq(orderForms.accountId, accountId), eq(orderForms.quoteId, quoteId))).orderBy(desc(orderForms.createdAt));
}

export async function orderForQuote(db: Db, accountId: string, quoteId: string) {
  const [o] = await db.select({ order: orders, signature: signatures }).from(orders)
    .innerJoin(signatures, eq(signatures.orderFormId, orders.orderFormId))
    .where(and(eq(orders.accountId, accountId), eq(orders.quoteId, quoteId))).orderBy(desc(orders.createdAt)).limit(1);
  return o ?? null;
}

/** The Orders tab: newest 200 orders of real (non-test) leads. */
export async function listOrders(db: Db, accountId: string) {
  return db.select({ order: orders, lead: leads }).from(orders).innerJoin(leads, eq(leads.id, orders.leadId))
    .where(and(eq(orders.accountId, accountId), eq(leads.isTest, false))).orderBy(desc(orders.createdAt)).limit(200);
}

export async function ordersForLead(db: Db, accountId: string, leadId: string) {
  return db.select().from(orders).where(and(eq(orders.accountId, accountId), eq(orders.leadId, leadId))).orderBy(desc(orders.createdAt));
}

export async function signatureFor(db: Db, formId: string) {
  const [s] = await db.select().from(signatures).where(eq(signatures.orderFormId, formId));
  return s ?? null;
}

/** Latest order-form status and payment per quote, for the Quotes list. */
export async function docStatusByQuote(db: Db, accountId: string, quoteIds: string[]) {
  const out = new Map<string, { form: OrderForm["status"] | null; payment: (typeof orders.$inferSelect)["paymentStatus"] | null }>();
  if (!quoteIds.length) return out;
  const [forms, ords] = await Promise.all([
    db.select({ quoteId: orderForms.quoteId, status: orderForms.status, expiresAt: orderForms.expiresAt }).from(orderForms)
      .where(and(eq(orderForms.accountId, accountId), inArray(orderForms.quoteId, quoteIds))).orderBy(desc(orderForms.createdAt)),
    db.select({ quoteId: orders.quoteId, paymentStatus: orders.paymentStatus }).from(orders)
      .where(and(eq(orders.accountId, accountId), inArray(orders.quoteId, quoteIds))).orderBy(desc(orders.createdAt)),
  ]);
  for (const id of quoteIds) {
    const f = forms.find((x) => x.quoteId === id);
    const o = ords.find((x) => x.quoteId === id);
    out.set(id, { form: f ? (f.status !== "signed" && f.expiresAt.getTime() <= Date.now() ? "link_expired" : f.status) : null, payment: o?.paymentStatus ?? null });
  }
  return out;
}

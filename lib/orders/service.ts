/**
 * Order forms, signatures and orders (P5.3–P5.6). Every function is scoped by
 * account (seller side) or by a verified link token (buyer side).
 *
 * Rules (mvp-plan 3.2, 3.5): the order is binding when the buyer signs; it is
 * paid only when a verified payment event arrives (lib/payments/events.ts) or a
 * person confirms a bank transfer. Snapshots and signatures are never updated.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  leadEvents, leads, orderForms, orders, paymentAttempts, quotes, sellerAccounts, signatures,
  type OrderForm, type OrderFormField, type OrderSnapshot,
} from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { priceQuote } from "@/lib/catalog/pricing";
import { publishedCatalog } from "@/lib/catalog/service";
import { createQuoteVersion, getQuote } from "@/lib/quotes/service";
import { currentLegal, getOrderFormSettings } from "./settings";
import { formIdFromToken, hashToken, publicUrl, tokenFor } from "./token";

const DAY_MS = 86_400_000;

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
  | { ok: false; reason: "quote_not_found" | "quote_not_ready" | "quote_expired" | "price_missing" | "lead_opted_out" | "no_legal" };

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
  const language = opts.language && account.languages.includes(opts.language) ? opts.language : q.lead.language && account.languages.includes(q.lead.language) ? q.lead.language : account.languages[0] ?? "en";
  const legal = (await currentLegal(db, accountId)).filter((s) => s.language === language);
  if (legal.length === 0) return { ok: false, reason: "no_legal" };
  const settings = await getOrderFormSettings(db, accountId);
  const catalog = await publishedCatalog(db, accountId);

  const v = cur.version;
  const snapshot: OrderSnapshot = {
    seller: { tradeName: account.tradeName, legalName: account.legalName, brandColor: settings.brandColor },
    quote: { number: q.quote.number, version: v.version, catalogVersion: catalog?.version.id === v.catalogVersionId ? catalog.version.version : 0 },
    currency: v.currency,
    pricesIncludeTax: v.pricesIncludeTax,
    lines: cur.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPriceMinor: l.unitPriceMinor!, lineTotalMinor: l.lineTotalMinor!, recurring: l.chargeType === "recurring" })),
    oneTime: { subtotalMinor: v.oneTimeSubtotalMinor, discountMinor: v.oneTimeDiscountMinor, taxMinor: v.oneTimeTaxMinor, totalMinor: v.oneTimeTotalMinor },
    recurring: { subtotalMinor: v.recurringSubtotalMinor, discountMinor: v.recurringDiscountMinor, taxMinor: v.recurringTaxMinor, totalMinor: v.recurringTotalMinor },
    validUntil: v.validUntil.toISOString(),
    legal: legal.map((s) => ({ key: s.sectionKey, title: s.title, version: s.version, body: s.body })),
    fields: settings.fields,
    prefill: {
      ...(q.lead.company ? { company_name: q.lead.company } : {}),
      ...(q.lead.email ? { invoice_email: q.lead.email } : {}),
      signatory_name: q.lead.fullName,
    },
    paymentMethods: { card: settings.card, bankTransfer: settings.bankTransfer },
    bankDetails: settings.bankDetails,
    supportContact: account.supportContact ?? null,
  };

  const id = randomUUID();
  const token = tokenFor(id);
  const expiresAt = new Date(Math.min(now.getTime() + settings.linkValidDays * DAY_MS, v.validUntil.getTime()));
  await atomic(db, (tx) => [
    tx.update(orderForms).set({ status: "link_expired", supersededById: id })
      .where(and(eq(orderForms.accountId, accountId), eq(orderForms.quoteId, quoteId), inArray(orderForms.status, ["sent", "opened"]))),
    tx.insert(orderForms).values({
      id, accountId, leadId: q.lead.id, quoteId, quoteVersionId: v.id, tokenHash: hashToken(token), language, snapshot, expiresAt,
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
  const replaced = form.supersededById !== null || quote.currentVersion !== form.snapshot.quote.version;
  if (replaced) {
    const [newest] = await db.select().from(orderForms)
      .where(and(eq(orderForms.quoteId, form.quoteId), inArray(orderForms.status, ["sent", "opened"])))
      .orderBy(desc(orderForms.createdAt)).limit(1);
    const newer = newest && newest.id !== form.id && newest.expiresAt.getTime() > now.getTime() ? { token: tokenFor(newest.id), snapshot: newest.snapshot } : null;
    const q = await getQuote(db, form.accountId, form.quoteId);
    return { state: "updated", form, newer, changeNote: q?.versions[0].version.changeNote ?? null };
  }
  if (form.status === "link_expired" || form.expiresAt.getTime() <= now.getTime()) return { state: "expired", form };
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

export type PriceCheck =
  | { status: "same" }
  | { status: "changed"; lines: { sku: string; name: string; qty: number; beforeMinor: number; nowMinor: number; recurring: boolean }[]; oneTimeMinor: number; recurringMinor: number }
  | { status: "unavailable" };

/** Re-prices the snapshot against the published catalog (mvp-plan 3.5: before signing and payment). */
export async function priceCheck(db: Db, form: OrderForm): Promise<PriceCheck> {
  const catalog = await publishedCatalog(db, form.accountId);
  if (!catalog) return { status: "unavailable" };
  const q = await getQuote(db, form.accountId, form.quoteId);
  const v = q?.versions.find((x) => x.version.id === form.quoteVersionId);
  if (!q || !v) return { status: "unavailable" };
  const custom = new Map(v.lines.filter((l) => l.priceSource === "custom").map((l) => [l.sku, l.unitPriceMinor!]));
  const r = priceQuote({
    items: catalog.items,
    lines: form.snapshot.lines.map((l) => ({ sku: l.sku, qty: l.qty, ...(custom.has(l.sku) ? { customUnitPriceMinor: custom.get(l.sku) } : {}) })),
    discountBp: v.version.discountBp,
    maxDiscountBp: 10_000,
    pricesIncludeTax: catalog.version.pricesIncludeTax,
    taxRateBp: catalog.version.taxRateBp,
  });
  if (!r.ok || !r.complete) return { status: "unavailable" };
  const s = form.snapshot;
  if (r.oneTime.totalMinor === s.oneTime.totalMinor && r.recurring.totalMinor === s.recurring.totalMinor) return { status: "same" };
  return {
    status: "changed",
    lines: s.lines.map((l) => {
      const n = r.lines.find((x) => x.sku === l.sku);
      return { sku: l.sku, name: l.name, qty: l.qty, beforeMinor: l.lineTotalMinor, nowMinor: n?.lineTotalMinor ?? l.lineTotalMinor, recurring: l.recurring };
    }),
    oneTimeMinor: r.oneTime.totalMinor,
    recurringMinor: r.recurring.totalMinor,
  };
}

/** "Accept new total": a new quote version from today's catalog and a new link. The old link stops working. */
export async function acceptNewPrice(db: Db, token: string, now = new Date()): Promise<{ ok: true; token: string } | { ok: false; reason: "not_open" | "needs_approval" | "failed" }> {
  const view = await loadForm(db, token, now);
  if (!view || view.state !== "open") return { ok: false, reason: "not_open" };
  const q = await getQuote(db, view.form.accountId, view.form.quoteId);
  const v = q?.versions.find((x) => x.version.id === view.form.quoteVersionId);
  if (!q || !v) return { ok: false, reason: "failed" };
  const r = await createQuoteVersion(db, view.form.accountId, { kind: "agent" }, q.quote.id, {
    lines: v.lines.map((l) => ({ sku: l.sku, qty: l.qty })), discountBp: v.version.discountBp, changeNote: "Price updated from the catalog; accepted by the buyer",
  }, now);
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
  const check = await priceCheck(db, form);
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
          currency: s.currency, amountDueMinor: s.oneTime.totalMinor, recurringMinor: s.recurring.totalMinor, createdAt: now,
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
  const check = await priceCheck(db, form);
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

export async function lastAttempt(db: Db, orderId: string) {
  const [a] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId)).orderBy(desc(paymentAttempts.createdAt)).limit(1);
  return a ?? null;
}

export async function attemptCount(db: Db, orderId: string) {
  return (await db.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId))).length;
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

export async function formsForQuote(db: Db, accountId: string, quoteId: string) {
  return db.select().from(orderForms).where(and(eq(orderForms.accountId, accountId), eq(orderForms.quoteId, quoteId))).orderBy(desc(orderForms.createdAt));
}

export async function orderForQuote(db: Db, accountId: string, quoteId: string) {
  const [o] = await db.select({ order: orders, signature: signatures }).from(orders)
    .innerJoin(signatures, eq(signatures.orderFormId, orders.orderFormId))
    .where(and(eq(orders.accountId, accountId), eq(orders.quoteId, quoteId))).orderBy(desc(orders.createdAt)).limit(1);
  return o ?? null;
}

export async function listOrders(db: Db, accountId: string) {
  return db.select({ order: orders, lead: leads }).from(orders).innerJoin(leads, eq(leads.id, orders.leadId))
    .where(and(eq(orders.accountId, accountId), eq(leads.isTest, false))).orderBy(desc(orders.createdAt));
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
  const forms = await db.select().from(orderForms).where(and(eq(orderForms.accountId, accountId), inArray(orderForms.quoteId, quoteIds))).orderBy(desc(orderForms.createdAt));
  const ords = await db.select().from(orders).where(and(eq(orders.accountId, accountId), inArray(orders.quoteId, quoteIds))).orderBy(desc(orders.createdAt));
  for (const id of quoteIds) {
    const f = forms.find((x) => x.quoteId === id);
    const o = ords.find((x) => x.quoteId === id);
    out.set(id, { form: f ? (f.status !== "signed" && f.expiresAt.getTime() <= Date.now() ? "link_expired" : f.status) : null, payment: o?.paymentStatus ?? null });
  }
  return out;
}

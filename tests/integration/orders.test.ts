import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations, leadEvents, leads, messages, orderForms, orders, paymentAttempts, providerEvents, quotes, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseCatalogItem } from "@/lib/catalog/rules";
import { addDraftRule, publishDraft, saveDraftItem } from "@/lib/catalog/service";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { createQuote, createQuoteVersion, quotesForLead } from "@/lib/quotes/service";
import { currentLegal, getOrderFormSettings, saveLegalSection } from "@/lib/orders/settings";
import {
  acceptNewPrice, createOrderForm, docStatusByQuote, formsForQuote, listOrders, loadForm, markBankTransferReceived, markOpened, orderLabel, priceCheck, signForm, startPayment,
} from "@/lib/orders/service";
import { formIdFromToken, tokenFor } from "@/lib/orders/token";
import { handleProviderEvent, signFake, simulateFakePayment } from "@/lib/payments/events";
import { createTestDb, type TestDb } from "../helpers/db";

const sign = { fields: { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "8 Dizengoff St", delivery_address: "Tel Aviv", invoice_email: "rina@kitchen.test" }, fullName: "Rina Cohen", role: "Owner", agreed: true };

describe("order forms, signatures and payments", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const human = () => ({ kind: "human" as const, userId: me.id, actingAs: false });
  const actor = () => ({ userId: me.id, actingAs: false });

  const newLead = async (phone: string, language = "en") => {
    const p = parseLead({ fullName: "Rina Cohen", company: "Rina's Kitchen", phone, language, consent: "on", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const r = (await upsertLead(db, acc, actor(), p.value, "manual", {} as never)) as { lead: { id: string } };
    return r.lead.id;
  };
  const newQuote = async (leadId: string) => {
    const r = await createQuote(db, acc, human(), leadId, { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discountBp: 0, sites: 2 });
    if (!r.ok) throw new Error(r.reason);
    return r.quote.id;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.replace(/\s/g, "")}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, actor(), p.value)).account.id;
    };
    acc = await mk("Polar Monitoring");
    other = await mk("Other");
    for (const raw of [
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "sensor", price: "590" },
      { sku: "GW-10", name: "Site gateway", unit: "site", price: "660" },
      { sku: "PLAN-M", name: "Monitoring plan", unit: "site", price: "90", chargeType: "recurring" },
    ]) {
      const p = parseCatalogItem(raw, "ILS");
      if (!p.ok) throw new Error();
      await saveDraftItem(db, acc, p.value);
    }
    await addDraftRule(db, acc, { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true });
    await publishDraft(db, actor(), acc);
  });
  afterAll(async () => t.close());

  it("versions legal sections per language; a form needs text in the buyer's language", async () => {
    const leadId = await newLead("0525550101");
    const q = await newQuote(leadId);
    expect(await createOrderForm(db, acc, human(), q)).toEqual({ ok: false, reason: "no_legal" });
    expect(await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "v1 text" })).toBe(1);
    expect(await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "v2 text" })).toBe(2);
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "טקסט" });
    const legal = await currentLegal(db, acc);
    expect(legal.map((l) => [l.language, l.version, l.body])).toEqual([["en", 2, "v2 text"], ["he", 1, "טקסט"]]);
    expect((await getOrderFormSettings(db, acc)).fields).toContain("company_id");
  });

  it("creates a personal link with an immutable snapshot; tampered tokens are refused", async () => {
    const leadId = await newLead("0525550102");
    const q = await newQuote(leadId);
    const r = await createOrderForm(db, acc, human(), q);
    if (!r.ok) throw new Error(r.reason);
    expect(r.url).toMatch(/\/f\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(r.form.snapshot).toMatchObject({ oneTime: { totalMinor: 486_000 }, recurring: { totalMinor: 18_000 }, legal: [{ key: "sales_terms", version: 2 }], prefill: { company_name: "Rina's Kitchen", signatory_name: "Rina Cohen" } });
    expect(formIdFromToken(r.token)).toBe(r.form.id);
    expect(formIdFromToken(r.token.slice(0, -2) + "AA")).toBeNull();
    expect(await loadForm(db, "nope")).toBeNull();
    const view = await loadForm(db, r.token);
    expect(view?.state).toBe("open");
    await markOpened(db, view!.form);
    await markOpened(db, (await loadForm(db, r.token))!.form);
    const opened = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.type, "order_form.opened")));
    expect(opened).toHaveLength(1);
    expect(await formsForQuote(db, other, q)).toEqual([]);
  });

  it("a new link or a new quote version makes the old link show 'Offer updated'", async () => {
    const leadId = await newLead("0525550103");
    const q = await newQuote(leadId);
    const first = await createOrderForm(db, acc, human(), q);
    const second = await createOrderForm(db, acc, human(), q);
    if (!first.ok || !second.ok) throw new Error();
    const old = await loadForm(db, first.token);
    expect(old?.state === "updated" && old.newer?.token).toBe(second.token);
    await createQuoteVersion(db, acc, human(), q, { lines: [{ sku: "SNS-200", qty: 5 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discountBp: 0, changeNote: "5 sensors instead of 6" });
    const now = await loadForm(db, second.token);
    expect(now).toMatchObject({ state: "updated", newer: null, changeNote: "5 sensors instead of 6" });
    expect((await signForm(db, second.token, sign, {})).ok).toBe(false);
  });

  it("refuses links for quotes that wait for approval or are opted out", async () => {
    const leadId = await newLead("0525550104");
    const r = await createQuote(db, acc, { kind: "agent" }, leadId, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 2000 });
    if (!r.ok) throw new Error();
    expect(await createOrderForm(db, acc, { kind: "agent" }, r.quote.id)).toEqual({ ok: false, reason: "quote_not_ready" });
  });

  let paidToken = "";
  it("signs once, records who signed what, and creates the order", async () => {
    const leadId = await newLead("0525550105");
    const q = await newQuote(leadId);
    const f = await createOrderForm(db, acc, human(), q);
    if (!f.ok) throw new Error();
    paidToken = f.token;
    const bad = await signForm(db, f.token, { ...sign, fields: { company_name: "" }, agreed: false }, {});
    expect(bad).toMatchObject({ ok: false, reason: "invalid", errors: { company_name: "required", company_id: "required", agreed: "required" } });
    const ok = await signForm(db, f.token, sign, { ip: "203.0.113.9", userAgent: "test" });
    expect(ok.ok).toBe(true);
    expect((await signForm(db, f.token, sign, {})).ok).toBe(false);
    const view = await loadForm(db, f.token);
    expect(view?.state).toBe("signed");
    if (view?.state !== "signed") return;
    expect(view.order).toMatchObject({ amountDueMinor: 486_000, recurringMinor: 18_000, paymentStatus: "not_started", number: expect.any(Number) });
    expect(orderLabel("Polar Monitoring", view.order.number)).toMatch(/^PM-1000\d$/);
    const ev = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.type, "order_form.signed")));
    expect(ev[0].data).toMatchObject({ signedBy: "Rina Cohen" });
  });

  it("card: needs recurring consent; a decline fails; only a verified event marks it paid", async () => {
    expect(await startPayment(db, paidToken, { method: "card", recurringConsent: false })).toEqual({ ok: false, reason: "recurring_consent" });
    const a1 = await startPayment(db, paidToken, { method: "card", recurringConsent: true });
    if (!a1.ok || a1.kind !== "card") throw new Error();
    expect(await simulateFakePayment(db, a1.providerRef, "failed")).toBe("failed");
    let view = await loadForm(db, paidToken);
    expect(view?.state === "signed" && view.order.paymentStatus).toBe("failed");

    const a2 = await startPayment(db, paidToken, { method: "card", recurringConsent: true });
    if (!a2.ok || a2.kind !== "card") throw new Error();
    view = await loadForm(db, paidToken);
    if (view?.state !== "signed") throw new Error();
    const order = view.order;
    const forged = JSON.stringify({ id: "evt_x", type: "payment.succeeded", provider_ref: a2.providerRef, account_id: acc, order_id: order.id, amount_minor: order.amountDueMinor, currency: "ILS" });
    expect(await handleProviderEvent(db, "fake", forged, "0".repeat(64))).toBe("rejected: bad signature");
    const cheap = JSON.stringify({ id: "evt_y", type: "payment.succeeded", provider_ref: a2.providerRef, account_id: acc, order_id: order.id, amount_minor: 100, currency: "ILS" });
    expect(await handleProviderEvent(db, "fake", cheap, signFake(cheap))).toBe("rejected: amount mismatch");
    const usd = JSON.stringify({ id: "evt_z", type: "payment.succeeded", provider_ref: a2.providerRef, account_id: acc, order_id: order.id, amount_minor: order.amountDueMinor, currency: "USD" });
    expect(await handleProviderEvent(db, "fake", usd, signFake(usd))).toBe("rejected: currency mismatch");
    const otherAcc = JSON.stringify({ id: "evt_w", type: "payment.succeeded", provider_ref: a2.providerRef, account_id: other, order_id: order.id, amount_minor: order.amountDueMinor, currency: "ILS" });
    expect(await handleProviderEvent(db, "fake", otherAcc, signFake(otherAcc))).toBe("rejected: account or order mismatch");
    view = await loadForm(db, paidToken);
    expect(view?.state === "signed" && view.order.paymentStatus).toBe("pending");

    const good = JSON.stringify({ id: "evt_ok", type: "payment.succeeded", provider_ref: a2.providerRef, account_id: acc, order_id: order.id, amount_minor: order.amountDueMinor, currency: "ILS", card_last4: "4242" });
    expect(await handleProviderEvent(db, "fake", good, signFake(good))).toBe("paid");
    expect(await handleProviderEvent(db, "fake", good, signFake(good))).toBe("duplicate");
    view = await loadForm(db, paidToken);
    expect(view?.state === "signed" && view.order.paymentStatus).toBe("paid");
    const [lead] = await db.select().from(leads).where(eq(leads.id, order.leadId));
    expect(lead.status).toBe("won");
    expect(await startPayment(db, paidToken, { method: "card", recurringConsent: true })).toEqual({ ok: false, reason: "already_paid" });
    const events = await db.select().from(providerEvents);
    expect(events.filter((e) => e.result === "paid")).toHaveLength(1);
  });

  it("bank transfer: only those orders can be marked received by a person, audited", async () => {
    const leadId = await newLead("0525550106");
    const q = await newQuote(leadId);
    const f = await createOrderForm(db, acc, human(), q);
    if (!f.ok) throw new Error();
    await signForm(db, f.token, sign, {});
    expect(await startPayment(db, f.token, { method: "bank_transfer", recurringConsent: false })).toEqual({ ok: true, kind: "bank_transfer" });
    const view = await loadForm(db, f.token);
    if (view?.state !== "signed") throw new Error();
    expect(view.order.paymentStatus).toBe("bank_transfer_expected");
    expect(await markBankTransferReceived(db, actor(), other, view.order.id)).toEqual({ ok: false, reason: "not_found" });
    expect(await markBankTransferReceived(db, actor(), acc, view.order.id)).toEqual({ ok: true });
    const [paid] = await db.select().from(orders).where(eq(orders.id, view.order.id));
    expect(paid).toMatchObject({ paymentStatus: "paid", markedPaidByUserId: me.id });
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "order.bank_transfer_received"));
    expect(audit).toHaveLength(1);
    // A card order can't be marked by hand.
    const cardView = await loadForm(db, paidToken);
    if (cardView?.state !== "signed") throw new Error();
    expect(await markBankTransferReceived(db, actor(), acc, cardView.order.id)).toEqual({ ok: false, reason: "not_bank_transfer" });
  });

  it("a catalog price change blocks signing until the buyer accepts the new total (new version, new link)", async () => {
    const leadId = await newLead("0525550107");
    const q = await newQuote(leadId);
    const f = await createOrderForm(db, acc, human(), q);
    if (!f.ok) throw new Error();
    const p = parseCatalogItem({ sku: "SNS-200", name: "Wireless fridge sensor", unit: "sensor", price: "620" }, "ILS");
    if (!p.ok) throw new Error();
    const { draftItemIdFor } = await import("@/lib/catalog/service");
    const { catalogState } = await import("@/lib/catalog/service");
    const sns = (await catalogState(db, acc)).items.find((i) => i.sku === "SNS-200")!;
    await saveDraftItem(db, acc, p.value, (await draftItemIdFor(db, acc, sns.id))!);
    await publishDraft(db, actor(), acc);
    expect(await signForm(db, f.token, sign, {})).toEqual({ ok: false, reason: "price_changed" });
    const accepted = await acceptNewPrice(db, f.token);
    if (!accepted.ok) throw new Error(accepted.reason);
    expect((await loadForm(db, f.token))?.state).toBe("updated");
    const fresh = await loadForm(db, accepted.token);
    expect(fresh?.state === "open" && fresh.form.snapshot.oneTime.totalMinor).toBe(6 * 62_000 + 2 * 66_000);
    expect((await signForm(db, accepted.token, sign, {})).ok).toBe(true);
  });

  it("confirms payment in the buyer's conversation", async () => {
    const leadId = await newLead("0525550108", "he");
    const { ensureDraftVersion } = await import("@/lib/agent/service");
    const v = await ensureDraftVersion(db, acc);
    const [conv] = await db.insert(conversations).values({ accountId: acc, leadId, channel: "testlab", isTest: true, agentVersionId: v.id, language: "he" }).returning();
    const q = await newQuote(leadId);
    const f = await createOrderForm(db, acc, human(), q, { language: "he" });
    if (!f.ok) throw new Error(f.reason);
    await signForm(db, f.token, sign, {});
    const a = await startPayment(db, f.token, { method: "card", recurringConsent: true });
    if (!a.ok || a.kind !== "card") throw new Error();
    expect(await simulateFakePayment(db, a.providerRef, "succeeded")).toBe("paid");
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs.at(-1)?.body).toContain("התשלום התקבל");
    expect(tokenFor(f.form.id)).toBe(f.token);
    expect((await db.select().from(orderForms).where(eq(orderForms.id, f.form.id)))[0].language).toBe("he");
  });

  // --- Hardening (lane P3) -------------------------------------------------

  const setPrice = async (sku: string, price: string) => {
    const { catalogState, draftItemIdFor } = await import("@/lib/catalog/service");
    const item = (await catalogState(db, acc)).items.find((i) => i.sku === sku)!;
    const known: Record<string, { name: string; unit: string }> = { "SNS-200": { name: "Wireless fridge sensor", unit: "sensor" }, "GW-10": { name: "Site gateway", unit: "site" } };
    const p = parseCatalogItem({ sku, ...known[sku], price }, "ILS");
    if (!p.ok) throw new Error();
    await saveDraftItem(db, acc, p.value, (await draftItemIdFor(db, acc, item.id))!);
    await publishDraft(db, actor(), acc);
  };
  /** Counts db.select() calls, to check the short path of priceCheck. */
  const counting = () => {
    const box = { n: 0 };
    const proxy = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "select") return (...a: unknown[]) => { box.n++; return (target.select as (...x: unknown[]) => unknown)(...a); };
        return Reflect.get(target, prop, recv);
      },
    });
    return { db: proxy as TestDb, box };
  };

  it("priceCheck: same catalog version is 'same' in one query; a new version re-prices", async () => {
    const leadId = await newLead("0525550201");
    const f = await createOrderForm(db, acc, human(), await newQuote(leadId));
    if (!f.ok) throw new Error(f.reason);
    const c = counting();
    expect(await priceCheck(c.db, f.form)).toEqual({ status: "same" });
    expect(c.box.n).toBe(1);
    await setPrice("GW-10", "700");
    const c2 = counting();
    expect(await priceCheck(c2.db, f.form)).toMatchObject({ status: "changed", oneTimeMinor: f.form.snapshot.oneTime.totalMinor + 2 * 4_000 });
    expect(c2.box.n).toBe(3);
    // A republished catalog with the same prices is still "same" after a full re-price.
    await setPrice("GW-10", "660");
    expect(await priceCheck(db, f.form)).toEqual({ status: "same" });
  });

  it("accept-new-price is refused when nothing changed, and carries the seller's custom prices over", async () => {
    const leadId = await newLead("0525550202");
    const q = await newQuote(leadId);
    const same = await createOrderForm(db, acc, human(), q);
    if (!same.ok) throw new Error(same.reason);
    expect(await acceptNewPrice(db, same.token)).toEqual({ ok: false, reason: "not_open" });
    const [qr] = await db.select().from(quotes).where(eq(quotes.id, q));
    expect(qr.currentVersion).toBe(1);
    expect((await loadForm(db, same.token))?.state).toBe("open");

    // The seller set a custom gateway price; then the sensor price changes.
    const v2 = await createQuoteVersion(db, acc, human(), q, { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discountBp: 0, sites: 2 }, new Date(), { "GW-10": 50_000 });
    if (!v2.ok) throw new Error(v2.reason);
    const f = await createOrderForm(db, acc, human(), q);
    if (!f.ok) throw new Error(f.reason);
    expect(f.form.snapshot.lines.find((l) => l.sku === "GW-10")?.unitPriceMinor).toBe(50_000);
    await setPrice("SNS-200", "650");
    const check = await priceCheck(db, f.form);
    expect(check).toMatchObject({ status: "changed", oneTimeMinor: 6 * 65_000 + 2 * 50_000 });
    const accepted = await acceptNewPrice(db, f.token);
    if (!accepted.ok) throw new Error(accepted.reason);
    const fresh = await loadForm(db, accepted.token);
    if (fresh?.state !== "open") throw new Error();
    expect(fresh.form.snapshot.lines.find((l) => l.sku === "GW-10")?.unitPriceMinor).toBe(50_000);
    expect(fresh.form.snapshot.oneTime.totalMinor).toBe(6 * 65_000 + 2 * 50_000);
    expect(await priceCheck(db, fresh.form)).toEqual({ status: "same" });
    expect((await signForm(db, accepted.token, sign, {})).ok).toBe(true);
  });

  it("an old link past its own expiry shows 'expired', never the newer offer", async () => {
    const leadId = await newLead("0525550203");
    const q = await newQuote(leadId);
    const old = await createOrderForm(db, acc, human(), q, {}, new Date(Date.now() - 30 * 86_400_000));
    if (!old.ok) throw new Error(old.reason);
    expect(old.form.expiresAt.getTime()).toBeLessThan(Date.now());
    const fresh = await createOrderForm(db, acc, human(), q);
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(await loadForm(db, old.token)).toMatchObject({ state: "expired" });
    expect((await loadForm(db, fresh.token))?.state).toBe("open");
    // A superseded link that has not expired still points to the new one, with the change note.
    const third = await createOrderForm(db, acc, human(), q);
    if (!third.ok) throw new Error();
    const v = await loadForm(db, fresh.token);
    expect(v?.state === "updated" && v.newer?.token).toBe(third.token);
  });

  it("card is refused when test payments are off, and a chosen bank transfer stays one", async () => {
    const leadId = await newLead("0525550204");
    const f = await createOrderForm(db, acc, human(), await newQuote(leadId));
    if (!f.ok) throw new Error();
    expect((await signForm(db, f.token, sign, {})).ok).toBe(true);
    vi.stubEnv("PAYMENTS_MODE", "live");
    try {
      expect(await startPayment(db, f.token, { method: "card", recurringConsent: true })).toEqual({ ok: false, reason: "method_off" });
    } finally {
      vi.unstubAllEnvs();
    }
    let view = await loadForm(db, f.token);
    if (view?.state !== "signed") throw new Error();
    expect(view.order.paymentStatus).toBe("not_started");
    expect(await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, view.order.id))).toHaveLength(0);

    expect(await startPayment(db, f.token, { method: "bank_transfer", recurringConsent: false })).toEqual({ ok: true, kind: "bank_transfer" });
    expect(await startPayment(db, f.token, { method: "card", recurringConsent: true })).toEqual({ ok: false, reason: "method_off" });
    view = await loadForm(db, f.token);
    expect(view?.state === "signed" && view.order.paymentStatus).toBe("bank_transfer_expected");
  });

  it("a paused account can't send, sign or pay", async () => {
    const lead1 = await newLead("0525550205");
    const q1 = await newQuote(lead1);
    const open = await createOrderForm(db, acc, human(), q1);
    const lead2 = await newLead("0525550206");
    const signedForm = await createOrderForm(db, acc, human(), await newQuote(lead2));
    if (!open.ok || !signedForm.ok) throw new Error();
    expect((await signForm(db, signedForm.token, sign, {})).ok).toBe(true);
    const [{ status: was }] = await db.select({ status: sellerAccounts.status }).from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, acc));
    try {
      expect(await createOrderForm(db, acc, human(), q1)).toEqual({ ok: false, reason: "account_paused" });
      expect(await signForm(db, open.token, sign, {})).toEqual({ ok: false, reason: "unavailable" });
      expect(await startPayment(db, signedForm.token, { method: "card", recurringConsent: true })).toEqual({ ok: false, reason: "unavailable" });
      expect(await startPayment(db, signedForm.token, { method: "bank_transfer", recurringConsent: false })).toEqual({ ok: false, reason: "unavailable" });
      expect((await loadForm(db, open.token))?.state).toBe("open");
    } finally {
      await db.update(sellerAccounts).set({ status: was }).where(eq(sellerAccounts.id, acc));
    }
    expect((await signForm(db, open.token, sign, {})).ok).toBe(true);
  });

  it("two concurrent success events for one payment confirm it once", async () => {
    const leadId = await newLead("0525550207");
    const { ensureDraftVersion } = await import("@/lib/agent/service");
    const av = await ensureDraftVersion(db, acc);
    const [conv] = await db.insert(conversations).values({ accountId: acc, leadId, channel: "testlab", isTest: true, agentVersionId: av.id, language: "en" }).returning();
    const f = await createOrderForm(db, acc, human(), await newQuote(leadId));
    if (!f.ok) throw new Error();
    await signForm(db, f.token, sign, {});
    const a = await startPayment(db, f.token, { method: "card", recurringConsent: true });
    if (!a.ok || a.kind !== "card") throw new Error();
    const view = await loadForm(db, f.token);
    if (view?.state !== "signed") throw new Error();
    const ev = (id: string) => JSON.stringify({ id, type: "payment.succeeded", provider_ref: a.providerRef, account_id: acc, order_id: view.order.id, amount_minor: view.order.amountDueMinor, currency: "ILS", card_last4: "4242" });
    const [e1, e2] = [ev("evt_race_1"), ev("evt_race_2")];
    const results = await Promise.all([handleProviderEvent(db, "fake", e1, signFake(e1)), handleProviderEvent(db, "fake", e2, signFake(e2))]);
    expect(results.filter((r) => r === "paid")).toHaveLength(1);
    expect(results.filter((r) => r.startsWith("rejected"))).toHaveLength(1);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs.filter((m) => m.body.includes("Payment received"))).toHaveLength(1);
    const paidEvents = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.type, "order.paid")));
    expect(paidEvents).toHaveLength(1);
    const after = await loadForm(db, f.token);
    expect(after?.state === "signed" && after.order.paymentStatus).toBe("paid");
  });

  it("read paths: forms without the snapshot, doc status per quote, orders list, quotes per lead, all scoped", async () => {
    const leadId = await newLead("0525550109");
    const q = await newQuote(leadId);
    const f1 = await createOrderForm(db, acc, human(), q);
    if (!f1.ok) throw new Error(f1.reason);
    const f2 = await createOrderForm(db, acc, human(), q);
    if (!f2.ok) throw new Error(f2.reason);
    const forms = await formsForQuote(db, acc, q);
    expect(forms.map((x) => x.id)).toEqual([f2.form.id, f1.form.id]);
    expect(forms[0]).not.toHaveProperty("snapshot");
    expect(forms[0]).toMatchObject({ status: "sent", quoteId: q, createdByUserId: me.id });

    const unsent = await newQuote(leadId);
    const docs = await docStatusByQuote(db, acc, [q, unsent]);
    expect(docs.get(q)).toEqual({ form: "sent", payment: null });
    expect(docs.get(unsent)).toEqual({ form: null, payment: null });
    expect((await docStatusByQuote(db, other, [q])).get(q)).toEqual({ form: null, payment: null });
    expect((await docStatusByQuote(db, acc, [])).size).toBe(0);

    await signForm(db, f2.token, sign, {});
    expect((await docStatusByQuote(db, acc, [q])).get(q)).toEqual({ form: "signed", payment: "not_started" });
    const list = await listOrders(db, acc);
    expect(list.some((r) => r.order.quoteId === q)).toBe(true);
    expect(await listOrders(db, other)).toEqual([]);

    const v2 = await createQuoteVersion(db, acc, human(), unsent, { lines: [{ sku: "SNS-200", qty: 3 }, { sku: "GW-10", qty: 1 }, { sku: "PLAN-M", qty: 1 }], discountBp: 0, sites: 1 });
    if (!v2.ok) throw new Error(v2.reason);
    expect(v2.quote).toMatchObject({ id: unsent, currentVersion: 2 });
    expect(v2.version).toMatchObject({ quoteId: unsent, version: 2 });
    const grouped = await quotesForLead(db, acc, leadId);
    expect(grouped.map((g) => [g.quote.id, g.version.version, g.older.map((o) => o.version)])).toEqual([[unsent, 2, [1]], [q, 1, []]]);
    expect(await quotesForLead(db, other, leadId)).toEqual([]);
  });
});

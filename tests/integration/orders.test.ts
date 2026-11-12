import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations, leadEvents, leads, messages, orderForms, orders, providerEvents, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseCatalogItem } from "@/lib/catalog/rules";
import { addDraftRule, publishDraft, saveDraftItem } from "@/lib/catalog/service";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { createQuote, createQuoteVersion } from "@/lib/quotes/service";
import { currentLegal, getOrderFormSettings, saveLegalSection } from "@/lib/orders/settings";
import {
  acceptNewPrice, createOrderForm, formsForQuote, loadForm, markBankTransferReceived, markOpened, orderLabel, signForm, startPayment,
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
});

/**
 * "Signed, not paid yet" (board UnpaidReminders) on PGlite: the runner on the follow-ups cron (reminders at
 * day 2 and 5 inside contact hours, the stops, a live call, idempotency, settings changed after signing), the
 * day-7 Needs you item, the timeline events, the mocked SMS and the Playbook save. No model call anywhere
 * (the reminder text is a template); SMS in mock mode.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentVersions, catalogVersions, consentRecords, conversations, leadEvents, leads, messages, orderForms, orders, quoteVersions, quotes,
  sellerAccounts, toolCalls, users, voiceSessions, type ContactHours, type User,
} from "@/db/schema";
import { ensureDraftVersion } from "@/lib/agent/service";
import { savePlaybookForm } from "@/lib/agent/playbook-save";
import { runUnpaidReminders, unpaidStepEventId } from "@/lib/orders/unpaid-run";
import { unpaidRemindersOf, type PlaybookWithUnpaid } from "@/lib/orders/unpaid-reminders";
import { needsYou, needsYouCount } from "@/lib/overview/service";
import { needCell } from "@/lib/leads/list-row";
import { leadEventTitle } from "@/lib/leads/event-icons";
import { t } from "@/lib/i18n";
import { hashToken, tokenFor } from "@/lib/orders/token";
import { buyerChat } from "@/lib/simulator/service";
import { sellerFormCards } from "@/lib/agent/conversation";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => { throw new Error("not used"); },
}));

const DAY = 24 * 3_600_000;
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const CLOSED: ContactHours = Array.from({ length: 7 }, () => ({ on: false, from: "08:00", to: "09:00" }));
/** Signed on a Sunday at 10:00 UTC (12:00 in Jerusalem): every "at(days)" stays inside ALL_DAY. */
const SIGNED = new Date("2026-11-22T10:00:00Z");
const at = (days: number) => new Date(SIGNED.getTime() + days * DAY);
const SMS = { env: { SMS_MODE: "mock" } };

describe("Signed, not paid yet", () => {
  let t0: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let n = 0;

  beforeAll(async () => {
    t0 = await createTestDb();
    db = t0.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u_unpaid", email: "owner@example.com", firstName: "Owner" }).returning();
  });
  afterAll(async () => { await t0.close(); });

  /** An account with a live agent version (the runner reads the live playbook's settings). */
  const mkAccount = async (extra: Partial<typeof sellerAccounts.$inferInsert> = {}, unpaid?: PlaybookWithUnpaid["unpaidReminders"]) => {
    const [a] = await db.insert(sellerAccounts).values({
      slug: `unpaid-${n++}`, tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS",
      plan: "pilot", monthlySpendCapMinor: 100_000, status: "live", contactHours: ALL_DAY, ...extra,
    }).returning();
    const draft = await ensureDraftVersion(db, a.id);
    const [v] = await db.update(agentVersions).set({ status: "live", playbook: { ...draft.playbook, agentName: "Maya", ...(unpaid ? { unpaidReminders: unpaid } : {}) } as PlaybookWithUnpaid })
      .where(eq(agentVersions.id, draft.id)).returning();
    return { account: a, version: v };
  };
  const setLiveSettings = async (acc: Awaited<ReturnType<typeof mkAccount>>, unpaid: PlaybookWithUnpaid["unpaidReminders"]) => {
    await db.update(agentVersions).set({ playbook: { ...acc.version.playbook, unpaidReminders: unpaid } as PlaybookWithUnpaid }).where(eq(agentVersions.id, acc.version.id));
  };

  type Order = { accountId: string; leadId: string; conversationId: string; orderId: string; quoteId: string; formId: string };
  /** A lead with a chat, a signed order (signed at SIGNED unless given) and SMS consent. */
  const mkOrder = async (
    acc: Awaited<ReturnType<typeof mkAccount>>,
    o: { channel?: string; language?: string; fullName?: string; signedAt?: Date; paymentStatus?: "not_started" | "pending" | "paid" | "failed" | "bank_transfer_expected"; bankTransfer?: boolean; isTest?: boolean } = {},
  ): Promise<Order> => {
    const accountId = acc.account.id;
    const signedAt = o.signedAt ?? SIGNED;
    const [lead] = await db.insert(leads).values({
      accountId, fullName: o.fullName ?? "Avi Demo", phone: `+97252666${String(n++).padStart(4, "0")}`, language: o.language ?? "en", origin: "manual", isTest: o.isTest ?? false,
    }).returning();
    await db.insert(consentRecords).values({ accountId, leadId: lead.id, wording: "I agree to WhatsApp and SMS", source: "Form", capturedAt: new Date(signedAt.getTime() - DAY) });
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      id: conversationId, accountId, leadId: lead.id, channel: o.channel ?? "chat", agentVersionId: acc.version.id, language: o.language ?? "en",
      createdAt: new Date(signedAt.getTime() - DAY),
    });
    // The buyer talked before signing (that never stops a reminder).
    await db.insert(messages).values({ accountId, conversationId, actor: "buyer", body: "send me the form", language: o.language ?? "en", createdAt: new Date(signedAt.getTime() - 3_600_000) });
    const [cv] = await db.insert(catalogVersions).values({ id: randomUUID(), accountId, version: n++, status: "archived" }).returning();
    const quoteId = randomUUID();
    await db.insert(quotes).values({ id: quoteId, accountId, leadId: lead.id, number: 2000 + n++, status: "sent" });
    const qvId = randomUUID();
    await db.insert(quoteVersions).values({
      id: qvId, accountId, quoteId, version: 1, catalogVersionId: cv.id, currency: "ILS", pricesIncludeTax: true, taxRateBp: 1800,
      oneTimeSubtotalMinor: 0, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 385_860, recurringSubtotalMinor: 0, recurringDiscountMinor: 0,
      recurringTaxMinor: 0, recurringTotalMinor: 0, approvalReasons: [], validUntil: new Date(signedAt.getTime() + 30 * DAY), createdByActor: "agent",
    });
    const formId = randomUUID();
    await db.insert(orderForms).values({
      id: formId, accountId, leadId: lead.id, quoteId, quoteVersionId: qvId, tokenHash: hashToken(tokenFor(formId)), language: o.language ?? "en",
      // Only what the runner and the chat cards read of the frozen form.
      snapshot: {
        paymentMethods: { card: true, bankTransfer: o.bankTransfer ?? true }, quote: { number: 1002, version: 1 }, currency: "ILS",
        oneTime: { totalMinor: 385_860 }, recurring: { totalMinor: 0 }, seller: { tradeName: "Polar Demo" },
      } as never,
      expiresAt: new Date(signedAt.getTime() + 7 * DAY), createdBy: "agent", status: "signed", signedAt,
    });
    const orderId = randomUUID();
    await db.insert(orders).values({
      id: orderId, accountId, leadId: lead.id, quoteId, orderFormId: formId, number: 10_000 + n++, currency: "ILS",
      amountDueMinor: 385_860, recurringMinor: 0, paymentStatus: o.paymentStatus ?? "not_started", createdAt: signedAt,
    });
    return { accountId, leadId: lead.id, conversationId, orderId, quoteId, formId };
  };

  const reminders = (conversationId: string) =>
    db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent"))).orderBy(messages.createdAt);
  const events = (leadId: string) => db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId)).orderBy(leadEvents.createdAt);
  const run = (now: Date) => runUnpaidReminders(db, null, now, { sms: SMS });

  describe("reminders", () => {
    let acc: Awaited<ReturnType<typeof mkAccount>>;
    beforeAll(async () => { acc = await mkAccount(); });

    it("posts the first reminder at day 2 with the pay card, the SMS line, and a timeline entry; then the second at day 5", async () => {
      const o = await mkOrder(acc);
      await run(at(1.9));
      expect(await reminders(o.conversationId)).toHaveLength(0);

      const s = await run(at(2));
      expect(s.reminders).toBeGreaterThanOrEqual(1);
      const [m1] = await reminders(o.conversationId);
      const label = `PD-${(await db.select({ number: orders.number }).from(orders).where(eq(orders.id, o.orderId)))[0].number}`;
      expect(m1.body).toMatch(new RegExp(`^Hi Avi, your order ${label} is signed\\. The last step is the payment, ₪3,858\\.60, here:\\nhttps?://\\S+/f/[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}$`));
      expect(m1).toMatchObject({ language: "en", deliveryStatus: "delivered" });
      const [call] = await db.select().from(toolCalls).where(eq(toolCalls.messageId, m1.id));
      expect(call).toMatchObject({ name: "app_message", result: { kind: "pay_reminder", message_id: m1.id, order_id: o.orderId, step: "first" } });

      const ev = await events(o.leadId);
      const rem = ev.find((e) => e.type === "order.pay_reminder");
      expect(rem).toMatchObject({ id: unpaidStepEventId(o.orderId, "first"), actor: "agent", data: { orderId: o.orderId, step: "first", days: 2, messageId: m1.id, conversationId: o.conversationId } });
      expect(leadEventTitle(rem!.type, rem!.data, t)).toBe("First payment reminder sent");
      // The fixed SMS line, mocked (SMS_MODE mock), pointing at the reminder message.
      const sms = ev.find((e) => e.type === "sms.mocked");
      expect(sms?.data).toMatchObject({ kind: "pay_reminder", messageId: m1.id });
      expect(String((sms?.data as { text?: string }).text)).toMatch(/^Your order from Polar Demo is waiting for payment: \S+\/c\/\S+$/);

      await run(at(4.9));
      expect(await reminders(o.conversationId)).toHaveLength(1);
      await run(at(5));
      const all = await reminders(o.conversationId);
      expect(all).toHaveLength(2);
      expect(all[1].body).toMatch(/^Still open, Avi\. Is anything holding up the payment\? If a bank transfer is easier, you can choose it on the payment page\.\nhttps?:\/\/\S+\/f\/\S+$/);
      const second = (await events(o.leadId)).find((e) => e.id === unpaidStepEventId(o.orderId, "second"));
      expect(leadEventTitle(second!.type, second!.data, t)).toBe("Second payment reminder sent");
    });

    it("is idempotent: the same step at most once per order, also when two runs overlap", async () => {
      const o = await mkOrder(acc);
      await Promise.all([run(at(2.1)), run(at(2.1)), run(at(2.1))]);
      await run(at(2.2));
      expect(await reminders(o.conversationId)).toHaveLength(1);
      expect((await events(o.leadId)).filter((e) => e.type === "order.pay_reminder")).toHaveLength(1);
    });

    it("goes out only inside contact hours", async () => {
      const closed = await mkAccount({ contactHours: CLOSED });
      const o = await mkOrder(closed);
      const s = await run(at(2));
      expect(s.deferred).toBeGreaterThanOrEqual(1);
      expect(await reminders(o.conversationId)).toHaveLength(0);
      await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, closed.account.id));
      await run(at(2.5));
      expect(await reminders(o.conversationId)).toHaveLength(1);
    });

    it("uses the conversation's language (Hebrew), without a bank transfer line when the form has none", async () => {
      const o = await mkOrder(acc, { language: "he", fullName: "אבי כהן", bankTransfer: false });
      await run(at(2));
      await run(at(5));
      const [m1, m2] = await reminders(o.conversationId);
      expect(m1.body.split("\n")[0]).toMatch(/^היי אבי, ההזמנה ⁨PD-\d+⁩ נחתמה\. השלב האחרון הוא התשלום, ⁨₪3,858\.60⁩, כאן:$/);
      expect(m1.language).toBe("he");
      expect(m2.body.split("\n")[0]).toBe("ההזמנה עדיין פתוחה, אבי. משהו מעכב את התשלום?");
    });

    describe("stops", () => {
      it("when the order is paid", async () => {
        const o = await mkOrder(acc);
        await run(at(2));
        await db.update(orders).set({ paymentStatus: "paid", paidAt: at(3) }).where(eq(orders.id, o.orderId));
        await run(at(5));
        await run(at(7));
        expect(await reminders(o.conversationId)).toHaveLength(1);
        expect((await events(o.leadId)).some((e) => e.type === "order.unpaid_flagged")).toBe(false);
      });
      it("when the buyer writes back after signing", async () => {
        const o = await mkOrder(acc);
        await run(at(2));
        await db.insert(messages).values({ accountId: o.accountId, conversationId: o.conversationId, actor: "buyer", body: "paying tomorrow", language: "en", createdAt: at(3) });
        const s = await run(at(5));
        expect(s.stopped).toBeGreaterThanOrEqual(1);
        expect(await reminders(o.conversationId)).toHaveLength(1);
        await run(at(6));
        await run(at(7));
        // No second reminder: not in the chat, no SMS for it, no event for the step; only the day-7 flag remains.
        expect(await reminders(o.conversationId)).toHaveLength(1);
        const ev = await events(o.leadId);
        expect(ev.filter((e) => e.type === "order.pay_reminder").map((e) => (e.data as { step: string }).step)).toEqual(["first"]);
        expect(ev.some((e) => e.id === unpaidStepEventId(o.orderId, "second"))).toBe(false);
        const sms = ev.filter((e) => e.type.startsWith("sms.") && (e.data as { kind?: string }).kind === "pay_reminder");
        expect(sms).toHaveLength(1);
        const flags = ev.filter((e) => e.type === "order.unpaid_flagged");
        expect(flags).toHaveLength(1);
        expect(flags[0].data).toMatchObject({ remindersSent: 1 });
        const items = (await needsYou(db, acc.account.id, at(7.1))).filter((i) => i.kind === "order_unpaid" && i.leadId === o.leadId);
        expect(items).toHaveLength(1);
        expect(needCell(items[0], { tradeName: "Polar Demo", timezone: "Asia/Jerusalem", now: at(7.1) }).detail).toMatch(/· 1 reminder sent$/);
      });
      it("when a person holds the chat (taken over, handed off, owned)", async () => {
        const taken = await mkOrder(acc);
        await db.update(conversations).set({ status: "human", takenOverByUserId: me.id }).where(eq(conversations.id, taken.conversationId));
        const handed = await mkOrder(acc);
        await db.update(leads).set({ status: "human_handling" }).where(eq(leads.id, handed.leadId));
        const owned = await mkOrder(acc);
        await db.update(leads).set({ ownerUserId: me.id }).where(eq(leads.id, owned.leadId));
        await run(at(2));
        for (const o of [taken, handed, owned]) expect(await reminders(o.conversationId)).toHaveLength(0);
      });
      it("never for a failed payment or an expected bank transfer (they have their own Needs you item), or a test lead", async () => {
        const failed = await mkOrder(acc, { paymentStatus: "failed" });
        const bank = await mkOrder(acc, { paymentStatus: "bank_transfer_expected" });
        const test = await mkOrder(acc, { isTest: true });
        await run(at(2));
        await run(at(7));
        for (const o of [failed, bank, test]) {
          expect(await reminders(o.conversationId)).toHaveLength(0);
          expect((await events(o.leadId)).filter((e) => e.type.startsWith("order."))).toHaveLength(0);
        }
      });
    });

    it("waits while a call is live on the conversation, and sends on the next run after it", async () => {
      const o = await mkOrder(acc);
      const [call] = await db.insert(voiceSessions).values({
        accountId: o.accountId, conversationId: o.conversationId, status: "live", createdAt: at(1.99), connectedAt: at(1.99), model: "scripted", mode: "scripted", ticketHash: "x",
      }).returning();
      const s = await run(at(2));
      expect(s.deferred).toBeGreaterThanOrEqual(1);
      expect(await reminders(o.conversationId)).toHaveLength(0);
      await db.update(voiceSessions).set({ status: "ended", endedAt: at(2.01) }).where(eq(voiceSessions.id, call.id));
      await run(at(2.02));
      expect(await reminders(o.conversationId)).toHaveLength(1);
    });
  });

  describe("settings", () => {
    it("an off step is skipped; the next one still goes out", async () => {
      const acc = await mkAccount({}, { first: { days: 2, on: false }, second: { days: 5, on: true }, team: { days: 7, on: false } });
      const o = await mkOrder(acc);
      await run(at(2));
      expect(await reminders(o.conversationId)).toHaveLength(0);
      await run(at(5));
      expect(await reminders(o.conversationId)).toHaveLength(1);
      await run(at(8));
      expect((await events(o.leadId)).some((e) => e.type === "order.unpaid_flagged")).toBe(false);
    });

    it("changed after signing: a sent step is never sent again; a step switched on long after it was due is skipped, the flag is not", async () => {
      const acc = await mkAccount();
      const o = await mkOrder(acc);
      await run(at(2));
      await setLiveSettings(acc, { first: { days: 3, on: true }, second: { days: 6, on: true }, team: { days: 7, on: true } });
      await run(at(3));
      expect(await reminders(o.conversationId)).toHaveLength(1);
      await run(at(6));
      expect(await reminders(o.conversationId)).toHaveLength(2);

      // Reminders were off when this order was signed; switched on at day 20.
      const off = await mkAccount({}, { first: { days: 2, on: false }, second: { days: 5, on: false }, team: { days: 7, on: false } });
      const late = await mkOrder(off);
      await run(at(10));
      await setLiveSettings(off, { first: { days: 2, on: true }, second: { days: 5, on: true }, team: { days: 7, on: true } });
      await run(at(20));
      expect(await reminders(late.conversationId)).toHaveLength(0);
      expect((await events(late.leadId)).filter((e) => e.type === "order.unpaid_flagged")).toHaveLength(1);
    });

    it("the Playbook save stores them in the draft; a form without the card keeps them; a wrong order is refused", async () => {
      const acc = await mkAccount();
      const base: [string, string][] = [["agentName", "Maya"], ["goal", "Help buyers order"], ["tone", "Short"], ["maxDiscount", "5"]];
      const card: [string, string][] = [
        ["unpaid.shown", "1"], ["unpaid.first.days", "3"], ["unpaid.first.on", "on"], ["unpaid.second.days", "6"], ["unpaid.team.days", "9"], ["unpaid.team.on", "on"],
      ];
      expect(await savePlaybookForm(db, acc.account.id, [...base, ...card])).toEqual({ ok: true });
      const draft = await ensureDraftVersion(db, acc.account.id);
      expect(unpaidRemindersOf(draft.playbook as PlaybookWithUnpaid)).toEqual({ first: { days: 3, on: true }, second: { days: 6, on: false }, team: { days: 9, on: true } });
      expect(await savePlaybookForm(db, acc.account.id, base)).toEqual({ ok: true });
      expect((( await ensureDraftVersion(db, acc.account.id)).playbook as PlaybookWithUnpaid).unpaidReminders).toEqual({ first: { days: 3, on: true }, second: { days: 6, on: false }, team: { days: 9, on: true } });
      const bad = await savePlaybookForm(db, acc.account.id, [...base, ["unpaid.shown", "1"], ["unpaid.first.days", "5"], ["unpaid.first.on", "on"], ["unpaid.second.days", "4"], ["unpaid.second.on", "on"], ["unpaid.team.days", "7"], ["unpaid.team.on", "on"]]);
      expect(bad.ok ? null : bad.errors).toEqual({ "unpaid.second.days": "Must be after the first reminder." });
      // The live version (what the runner reads) is untouched until the draft is published.
      expect(unpaidRemindersOf((await db.select().from(agentVersions).where(eq(agentVersions.id, acc.version.id)))[0].playbook as PlaybookWithUnpaid)).toEqual(unpaidRemindersOf(null));
    });
  });

  describe("Tell your team (day 7)", () => {
    it("a Needs you item with the order, amount and reminders sent, a timeline entry, and gone once paid", async () => {
      const acc = await mkAccount();
      const o = await mkOrder(acc);
      await run(at(2));
      await run(at(5));
      expect((await needsYou(db, acc.account.id, at(6.9))).filter((i) => i.kind === "order_unpaid")).toHaveLength(0);
      const s = await run(at(7));
      expect(s.flagged).toBe(1);
      await run(at(7.1));
      const flags = (await events(o.leadId)).filter((e) => e.type === "order.unpaid_flagged");
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({ id: unpaidStepEventId(o.orderId, "team"), actor: "system", data: { orderId: o.orderId, days: 7, remindersSent: 2 } });
      expect(leadEventTitle(flags[0].type, flags[0].data, t)).toBe("Signed, not paid: flagged for your team");

      const now = at(7.2);
      const items = (await needsYou(db, acc.account.id, now)).filter((i) => i.kind === "order_unpaid");
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "order_unpaid", leadId: o.leadId, orderId: o.orderId, quoteId: o.quoteId, amountMinor: 385_860, currency: "ILS", remindersSent: 2 });
      const cell = needCell(items[0], { tradeName: "Polar Demo", timezone: "Asia/Jerusalem", now });
      expect(cell.title).toBe("Signed 7 days ago, not paid");
      expect(cell.detail).toMatch(/^PD-\d+ · ₪3,858\.60 · 2 reminders sent$/);
      expect(await needsYouCount(db, acc.account.id, now)).toBe((await needsYou(db, acc.account.id, now)).length);

      await db.update(orders).set({ paymentStatus: "paid", paidAt: at(8) }).where(eq(orders.id, o.orderId));
      expect((await needsYou(db, acc.account.id, at(8))).filter((i) => i.kind === "order_unpaid")).toHaveLength(0);
      expect(await needsYouCount(db, acc.account.id, at(8))).toBe((await needsYou(db, acc.account.id, at(8))).length);
    });

    it("is scoped to the account", async () => {
      const a = await mkAccount();
      const b = await mkAccount();
      await mkOrder(a);
      await run(at(7));
      expect((await needsYou(db, b.account.id, at(7.1))).filter((i) => i.kind === "order_unpaid")).toHaveLength(0);
      expect((await needsYou(db, a.account.id, at(7.1))).filter((i) => i.kind === "order_unpaid")).toHaveLength(1);
    });
  });

  describe("stacked pay cards", () => {
    it("the buyer chat folds the earlier pay card once the second reminder posts a newer one; the seller thread mirrors it", async () => {
      const acc = await mkAccount();
      const o = await mkOrder(acc);
      const [lead] = await db.select().from(leads).where(eq(leads.id, o.leadId));
      const ctx = { lead, account: acc.account, brandColor: "#0f6b5a" };
      await run(at(2));
      const first = await buyerChat(db, ctx, { now: at(2.1) });
      const card1 = first.messages.find((m) => m.kind === "pay_reminder")!;
      // Signed: the pay card names the ORDER, the same number as the reminder text and the pay page.
      const [{ number }] = await db.select({ number: orders.number }).from(orders).where(eq(orders.id, o.orderId));
      const label = `PD-${number}`;
      expect(card1.previews).toMatchObject([{ pay: true, ref: label, oneTime: "₪3,858.60" }]);
      expect(card1.body.split("\n")[0]).toContain(`your order ${label} is signed`);
      expect(first.foldedPay).toEqual({});

      await run(at(5));
      const second = await buyerChat(db, ctx, { now: at(5.1) });
      const [m1, m2] = second.messages.filter((m) => m.kind === "pay_reminder");
      const url = m1.previews[0].url;
      expect(m2.previews[0].url).toBe(url);
      // Only the earlier card folds: "Payment · PD-10002 · latest is below"; the newest keeps the amount and "Pay now".
      expect(second.foldedPay).toEqual({ [`${m1.id} ${url}`]: `Payment · ${label} · latest is below` });
      // A poll for newer messages still carries every fold (the earlier card folds in place).
      expect((await buyerChat(db, ctx, { after: m2.id, now: at(5.2) })).foldedPay).toEqual(second.foldedPay);

      // The chat's current language decides the folded line's words.
      await db.update(conversations).set({ language: "he" }).where(eq(conversations.id, o.conversationId));
      expect(Object.values((await buyerChat(db, ctx, { now: at(5.3) })).foldedPay ?? {})).toEqual([`תשלום · ${label} · העדכני למטה`]);
      await db.update(conversations).set({ language: "en" }).where(eq(conversations.id, o.conversationId));

      // The seller's thread mirrors the fold (as replaced quote cards).
      const thread = (await reminders(o.conversationId)).map((m) => ({ message: m }));
      const seller = await sellerFormCards(db, o.accountId, thread, "en", at(5.3));
      expect(seller[m1.id][0].folded).toBe(`Payment · ${label} · latest is below`);
      expect(seller[m2.id][0].preview).toMatchObject({ pay: true, ref: label });
      expect(seller[m2.id][0].folded).toBeUndefined();

      // Paid: no pay cards, nothing folded (the existing paid behaviour).
      await db.update(orders).set({ paymentStatus: "paid", paidAt: at(6) }).where(eq(orders.id, o.orderId));
      expect((await buyerChat(db, ctx, { now: at(6.1) })).foldedPay).toEqual({});
    });
  });

  describe("one number per order on the cards", () => {
    it("before signing the form card shows the quote reference; once signed the order number (buyer chat and seller thread)", async () => {
      const acc = await mkAccount();
      const o = await mkOrder(acc);
      // The same form, not signed yet (an order form sent, waiting for the signature): no order on it.
      await db.delete(orders).where(eq(orders.id, o.orderId));
      await db.update(orderForms).set({ status: "sent", signedAt: null, expiresAt: at(30) }).where(eq(orderForms.id, o.formId));
      const url = `${process.env.APP_URL?.trim() || "http://localhost:3000"}/f/${tokenFor(o.formId)}`;
      const [m] = await db.insert(messages).values({ accountId: o.accountId, conversationId: o.conversationId, actor: "agent", body: url, language: "en", createdAt: at(0.5) }).returning();
      const [lead] = await db.select().from(leads).where(eq(leads.id, o.leadId));
      const ctx = { lead, account: acc.account, brandColor: "#0f6b5a" };
      const before = (await buyerChat(db, ctx, { now: at(1) })).messages.find((x) => x.id === m.id)!;
      expect(before.previews).toMatchObject([{ ref: "Q-1002 v1", pay: false }]);
      expect((await sellerFormCards(db, o.accountId, [{ message: m }], "en", at(1)))[m.id][0].preview).toMatchObject({ ref: "Q-1002 v1", pay: false });

      // Signed: an order exists, and every card of that form names it.
      await db.update(orderForms).set({ status: "signed", signedAt: at(1) }).where(eq(orderForms.id, o.formId));
      const [order] = await db.insert(orders).values({
        id: randomUUID(), accountId: o.accountId, leadId: o.leadId, quoteId: o.quoteId, orderFormId: o.formId, number: 10_500 + n++, currency: "ILS",
        amountDueMinor: 385_860, recurringMinor: 0, createdAt: at(1),
      }).returning();
      const after = (await buyerChat(db, ctx, { now: at(1.1) })).messages.find((x) => x.id === m.id)!;
      expect(after.previews).toMatchObject([{ ref: `PD-${order.number}`, pay: true }]);
      expect((await sellerFormCards(db, o.accountId, [{ message: m }], "en", at(1.1)))[m.id][0].preview).toMatchObject({ ref: `PD-${order.number}`, pay: true });
      // Paid: still the order number (the card reads "Order form · PD-…", Open).
      await db.update(orders).set({ paymentStatus: "paid", paidAt: at(2) }).where(eq(orders.id, order.id));
      expect((await buyerChat(db, ctx, { now: at(2.1) })).messages.find((x) => x.id === m.id)!.previews).toMatchObject([{ ref: `PD-${order.number}`, pay: false }]);
    });
  });
});

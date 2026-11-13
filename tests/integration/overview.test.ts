import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentVersions, auditLog, catalogVersions, knowledgeFacts, leadEvents, leads, orderForms, orders, quotes, quoteVersions,
  sellerAccounts, users, type User,
} from "@/db/schema";
import { needsYou, needsYouHref, overviewKpis, parsePeriod, periodRange, recentActivity } from "@/lib/overview/service";
import { setupProgress } from "@/lib/overview/setup";
import { listAuditLog, parseActionPrefix } from "@/lib/admin/activity";
import { saveLegalSection } from "@/lib/orders/settings";
import { createTestDb, type TestDb } from "../helpers/db";

const HOUR = 3_600_000;
const now = new Date("2026-11-13T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * HOUR);

describe("overview, setup progress and admin activity", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  const catalogOf = new Map<string, string>();
  let phone = 0;
  let quoteNo = 0;

  const mkAccount = async (slug: string, extra: Partial<typeof sellerAccounts.$inferInsert> = {}) => {
    const [a] = await db.insert(sellerAccounts).values({
      slug, tradeName: slug, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS",
      plan: "pilot", monthlySpendCapMinor: 100_000, ...extra,
    }).returning();
    const cv = randomUUID();
    await db.insert(catalogVersions).values({ id: cv, accountId: a.id, version: 1, status: "draft" });
    catalogOf.set(a.id, cv);
    return a.id;
  };
  const mkLead = async (accountId: string, o: Partial<typeof leads.$inferInsert> = {}) => {
    const [l] = await db.insert(leads).values({
      accountId, fullName: o.fullName ?? `Lead ${phone}`, phone: `+97252555${String(phone++).padStart(4, "0")}`, language: "en", origin: "manual", ...o,
    }).returning();
    return l;
  };
  const mkQuote = async (accountId: string, leadId: string, o: { status?: "draft" | "awaiting_approval" | "sent" | "cancelled"; createdAt?: Date } = {}) => {
    const id = randomUUID();
    const number = 1000 + quoteNo++;
    await db.insert(quotes).values({ id, accountId, leadId, number, status: o.status ?? "sent", createdAt: o.createdAt ?? now });
    await db.insert(quoteVersions).values({
      id: randomUUID(), accountId, quoteId: id, version: 1, catalogVersionId: catalogOf.get(accountId)!, currency: "ILS",
      pricesIncludeTax: true, taxRateBp: 1800, oneTimeSubtotalMinor: 0, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 0,
      recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0,
      approvalReasons: o.status === "awaiting_approval" ? [{ kind: "price_missing", sku: "SNS-1" }] : [],
      validUntil: new Date(now.getTime() + 7 * 24 * HOUR), createdByActor: "agent", createdAt: o.createdAt ?? ago(1),
    });
    return { id, number };
  };
  const mkForm = async (accountId: string, leadId: string, quoteId: string, o: Partial<typeof orderForms.$inferInsert> = {}) => {
    const id = randomUUID();
    const [qv] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
    await db.insert(orderForms).values({
      id, accountId, leadId, quoteId, quoteVersionId: qv.id, tokenHash: randomUUID(), language: "en", snapshot: {} as never,
      expiresAt: new Date(now.getTime() + 5 * 24 * HOUR), createdBy: "agent", createdAt: now, ...o,
    });
    return id;
  };
  const mkOrder = async (accountId: string, leadId: string, o: Partial<typeof orders.$inferInsert> = {}) => {
    const q = await mkQuote(accountId, leadId);
    const formId = await mkForm(accountId, leadId, q.id, { status: "signed", signedAt: o.createdAt ?? ago(2) });
    const id = randomUUID();
    await db.insert(orders).values({
      id, accountId, leadId, quoteId: q.id, orderFormId: formId, number: quoteNo, currency: "ILS", amountDueMinor: 302_000, recurringMinor: 9_000,
      updatedAt: ago(2), ...o,
    });
    return { id, quoteId: q.id };
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
  });
  afterAll(async () => t.close());

  describe("needsYou", () => {
    let expected: Record<string, string>;

    beforeAll(async () => {
      acc = await mkAccount("polar");
      other = await mkAccount("other");
      // Quote awaiting approval.
      const l1 = await mkLead(acc, { fullName: "Hotel Sea View" });
      const qa = await mkQuote(acc, l1.id, { status: "awaiting_approval", createdAt: ago(5) });
      // Handed to a person.
      const l2 = await mkLead(acc, { fullName: "Yossi Amar", status: "human_handling", lastActivityAt: ago(0.1) });
      // Bank transfer expected, and payment failed.
      const l3 = await mkLead(acc, { fullName: "Maya Ben-David" });
      const bank = await mkOrder(acc, l3.id, { paymentStatus: "bank_transfer_expected", updatedAt: ago(3) });
      const l4 = await mkLead(acc, { fullName: "Omer Katz" });
      const failed = await mkOrder(acc, l4.id, { paymentStatus: "failed", updatedAt: ago(4) });
      // Opened 30 h ago, not signed; opened only 2 h ago (not yet); expiring in 10 h.
      const l5 = await mkLead(acc, { fullName: "Noa Shalev" });
      const q5 = await mkQuote(acc, l5.id);
      const unsigned = await mkForm(acc, l5.id, q5.id, { status: "opened", openedAt: ago(30) });
      const q6 = await mkQuote(acc, l5.id);
      await mkForm(acc, l5.id, q6.id, { status: "opened", openedAt: ago(2) });
      const q7 = await mkQuote(acc, l5.id);
      const expiring = await mkForm(acc, l5.id, q7.id, { status: "sent", expiresAt: new Date(now.getTime() + 10 * HOUR) });
      // Not in the queue: expired, superseded, signed, cancelled quote, paid order.
      const q8 = await mkQuote(acc, l5.id);
      await mkForm(acc, l5.id, q8.id, { status: "opened", openedAt: ago(50), expiresAt: ago(1) });
      await mkForm(acc, l5.id, q8.id, { status: "opened", openedAt: ago(50), supersededById: unsigned });
      const q9 = await mkQuote(acc, l5.id, { status: "cancelled" });
      await mkForm(acc, l5.id, q9.id, { status: "opened", openedAt: ago(50) });
      await mkOrder(acc, l5.id, { paymentStatus: "paid", paidAt: ago(1) });
      // Test leads and other accounts never show.
      const test = await mkLead(acc, { fullName: "Test buyer", isTest: true, status: "human_handling" });
      await mkQuote(acc, test.id, { status: "awaiting_approval" });
      await mkOrder(acc, test.id, { paymentStatus: "failed" });
      const ol = await mkLead(other, { status: "human_handling" });
      await mkQuote(other, ol.id, { status: "awaiting_approval" });
      await mkOrder(other, ol.id, { paymentStatus: "bank_transfer_expected" });
      expected = { qa: qa.id, l2: l2.id, bank: bank.id, failed: failed.id, unsigned, expiring };
    });

    it("lists every kind of item once, newest first, for this account only", async () => {
      const items = await needsYou(db, acc, now);
      expect(items.map((i) => [i.kind, i.leadName])).toEqual([
        ["human_handling", "Yossi Amar"],
        ["bank_transfer", "Maya Ben-David"],
        ["payment_failed", "Omer Katz"],
        ["quote_approval", "Hotel Sea View"],
        ["form_unsigned", "Noa Shalev"],
        ["form_expiring", "Noa Shalev"],
      ]);
      const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
      expect(byKind.quote_approval).toMatchObject({ quoteId: expected.qa, version: 1, reasons: [{ kind: "price_missing" }] });
      expect(byKind.human_handling).toMatchObject({ leadId: expected.l2 });
      expect(byKind.bank_transfer).toMatchObject({ orderId: expected.bank, amountMinor: 302_000, currency: "ILS" });
      expect(byKind.payment_failed).toMatchObject({ orderId: expected.failed });
      expect(byKind.form_unsigned).toMatchObject({ formId: expected.unsigned, at: ago(6) });
      expect(byKind.form_expiring).toMatchObject({ formId: expected.expiring });
      expect(items.some((i) => i.leadName === "Test buyer")).toBe(false);
      expect(await needsYou(db, other, now)).toHaveLength(3);
    });

    it("links each item to where it is handled", async () => {
      const items = await needsYou(db, acc, now);
      const href = Object.fromEntries(items.map((i) => [i.kind, needsYouHref("/app/polar", i)]));
      expect(href.human_handling).toBe(`/app/polar/leads/${expected.l2}`);
      expect(href.quote_approval).toBe(`/app/polar/orders?tab=approval&quote=${expected.qa}`);
      expect(href.bank_transfer).toMatch(/^\/app\/polar\/orders\?tab=orders&quote=[0-9a-f-]{36}$/);
      expect(href.form_expiring).toMatch(/^\/app\/polar\/orders\?quote=/);
    });

    it("an opened form that is also expiring shows once, as expiring", async () => {
      const l = await mkLead(other, { fullName: "Both" });
      const q = await mkQuote(other, l.id);
      await mkForm(other, l.id, q.id, { status: "opened", openedAt: ago(40), expiresAt: new Date(now.getTime() + 2 * HOUR) });
      const mine = (await needsYou(db, other, now)).filter((i) => i.leadName === "Both");
      expect(mine.map((i) => i.kind)).toEqual(["form_expiring"]);
    });
  });

  describe("overviewKpis", () => {
    it("counts what happened in the period, without test leads or other accounts", async () => {
      const a = await mkAccount("kpis");
      const b = await mkAccount("kpis-other");
      const fresh = await mkLead(a, { createdAt: ago(24) });
      await mkLead(a, { createdAt: ago(24 * 10) }); // outside 7 days, inside 30
      await mkLead(a, { createdAt: ago(1), isTest: true });
      await mkLead(b, { createdAt: ago(1) });
      const q = await mkQuote(a, fresh.id, { createdAt: ago(20) });
      await mkForm(a, fresh.id, q.id, { createdAt: ago(19) });
      await mkOrder(a, fresh.id, { createdAt: ago(10), paymentStatus: "paid", paidAt: ago(9), amountDueMinor: 100_000, recurringMinor: 5_000 });
      await mkOrder(a, fresh.id, { createdAt: ago(24 * 9), paymentStatus: "paid", paidAt: ago(24 * 9), amountDueMinor: 50_000, recurringMinor: 0 });
      await mkOrder(a, fresh.id, { paymentStatus: "bank_transfer_expected" });
      const test = await mkLead(a, { isTest: true, createdAt: ago(1) });
      await mkOrder(a, test.id, { paymentStatus: "paid", paidAt: ago(1), amountDueMinor: 999_999 });

      const week = await overviewKpis(db, a, periodRange(7, now));
      // mkOrder adds a quote and a signed form for each order.
      expect(week).toEqual({ newLeads: 1, quotesCreated: 4, formsSent: 4, formsSigned: 2, paidOrders: 1, paidRevenueMinor: 100_000, paidRecurringMinor: 5_000 });
      const month = await overviewKpis(db, a, periodRange(30, now));
      expect(month).toMatchObject({ newLeads: 2, formsSigned: 3, paidOrders: 2, paidRevenueMinor: 150_000 });
      expect(parsePeriod("7")).toBe(7);
      expect(parsePeriod("x")).toBe(30);
      expect(parsePeriod(undefined)).toBe(30);
    });
  });

  describe("recentActivity", () => {
    it("returns the latest 10 lead events, without test leads", async () => {
      const a = await mkAccount("activity");
      const l = await mkLead(a, { fullName: "Real" });
      const test = await mkLead(a, { fullName: "Test", isTest: true });
      for (let i = 0; i < 12; i++) {
        await db.insert(leadEvents).values({ accountId: a, leadId: l.id, type: "lead.updated", actor: "human", actorUserId: me.id, createdAt: ago(12 - i) });
      }
      await db.insert(leadEvents).values({ accountId: a, leadId: test.id, type: "lead.created", actor: "system", createdAt: now });
      const rows = await recentActivity(db, a);
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.lead.fullName === "Real")).toBe(true);
      expect(rows[0].event.createdAt).toEqual(ago(1));
      expect(rows[0].user?.id).toBe(me.id);
    });
  });

  describe("setupProgress", () => {
    it("marks each step from the account's data", async () => {
      const a = await mkAccount("setup", { languages: ["en", "he"] });
      expect([...(await setupProgress(db, a))]).toEqual([]);

      await db.update(sellerAccounts).set({ legalName: "Polar Ltd" }).where(eq(sellerAccounts.id, a));
      expect((await setupProgress(db, a)).has("company")).toBe(false);
      await db.update(sellerAccounts).set({ companyId: "512345678" }).where(eq(sellerAccounts.id, a));

      await db.insert(knowledgeFacts).values({ accountId: a, topic: "t", statement: "s", status: "suggested" });
      expect((await setupProgress(db, a)).has("knowledge")).toBe(false);
      await db.insert(knowledgeFacts).values({ accountId: a, topic: "t", statement: "s", status: "approved" });

      expect((await setupProgress(db, a)).has("catalog")).toBe(false);
      await db.update(catalogVersions).set({ status: "published" }).where(eq(catalogVersions.accountId, a));

      const pb = { agentName: "A", goal: "", tone: "", outcomes: { orderForm: true, bankTransfer: false, meeting: false }, fields: [], objections: [], maxDiscountBp: 0, offerMeetingWhen: "", handOffWhen: "", neverDo: [] };
      await db.insert(agentVersions).values({ id: randomUUID(), accountId: a, version: 1, status: "draft", playbook: pb, model: "m" });
      expect((await setupProgress(db, a)).has("playbook")).toBe(false);
      await db.insert(agentVersions).values({ id: randomUUID(), accountId: a, version: 2, status: "live", playbook: pb, model: "m" });

      await saveLegalSection(db, a, null, { sectionKey: "terms", title: "Terms", language: "en", body: "x" });
      expect((await setupProgress(db, a)).has("order-form")).toBe(false);
      await saveLegalSection(db, a, null, { sectionKey: "terms", title: "Terms", language: "he", body: "x" });

      expect([...(await setupProgress(db, a))].sort()).toEqual(["catalog", "company", "knowledge", "order-form", "playbook"]);

      // Removing the Hebrew text (a new inactive version) undoes the order-form step.
      await saveLegalSection(db, a, null, { sectionKey: "terms", title: "Terms", language: "he", body: "x", active: false });
      expect((await setupProgress(db, a)).has("order-form")).toBe(false);

      await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, a));
      const done = await setupProgress(db, a);
      expect(done.has("go-live")).toBe(true);
      expect(done.has("sources")).toBe(false);
      expect(done.has("follow-ups")).toBe(false);
      // Another account's data never counts.
      expect([...(await setupProgress(db, other))]).toEqual([]);
    });
  });

  describe("listAuditLog", () => {
    it("filters by account and action prefix and pages without gaps", async () => {
      const a = await mkAccount("audit-a");
      const b = await mkAccount("audit-b");
      const base = new Date("2026-01-01T00:00:00Z").getTime();
      const rows: (typeof auditLog.$inferInsert)[] = [];
      for (let i = 0; i < 7; i++) rows.push({ accountId: a, actorUserId: me.id, action: i % 2 ? "quote.created" : "order_form.sent", createdAt: new Date(base + i * 1000) });
      // Three entries share one timestamp: the cursor must still not skip or repeat any.
      for (let i = 0; i < 3; i++) rows.push({ accountId: b, actorUserId: me.id, actingAs: true, action: "account.entered", createdAt: new Date(base + 500) });
      rows.push({ accountId: null, actorUserId: null, action: "order.bank_transfer_received", createdAt: new Date(base + 100) });
      await db.insert(auditLog).values(rows);

      const scoped = await listAuditLog(db, { accountId: a, limit: 50 });
      expect(scoped.rows).toHaveLength(7);
      expect(scoped.nextBefore).toBeNull();
      expect(scoped.rows[0].account?.slug).toBe("audit-a");
      expect(scoped.rows[0].actor?.id).toBe(me.id);

      const quotesOnly = await listAuditLog(db, { accountId: a, actionPrefix: "quote.", limit: 50 });
      expect(quotesOnly.rows.map((r) => r.entry.action)).toEqual(["quote.created", "quote.created", "quote.created"]);
      // "order." does not match "order_form." entries.
      const ordersOnly = await listAuditLog(db, { actionPrefix: "order.", limit: 50 });
      expect(ordersOnly.rows.map((r) => r.entry.action)).toEqual(["order.bank_transfer_received"]);
      expect(ordersOnly.rows[0].account).toBeNull();
      // LIKE wildcards in the prefix match literally.
      expect((await listAuditLog(db, { actionPrefix: "%", limit: 50 })).rows).toHaveLength(0);

      // Walk all of b + a + platform with page size 2.
      const scope = async (before?: string) => listAuditLog(db, { limit: 2, before });
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await scope(cursor);
        seen.push(...page.rows.map((r) => r.entry.id));
        cursor = page.nextBefore ?? undefined;
        pages++;
      } while (cursor && pages < 50);
      const all = await listAuditLog(db, { limit: 200 });
      expect(seen).toEqual(all.rows.map((r) => r.entry.id));
      expect(new Set(seen).size).toBe(seen.length);
      expect(all.rows.filter((r) => r.entry.actingAs)).toHaveLength(3);
    });

    it("accepts only plain action prefixes", () => {
      expect(parseActionPrefix("quote.")).toBe("quote.");
      expect(parseActionPrefix("order_form.")).toBe("order_form.");
      expect(parseActionPrefix("lead")).toBe("lead");
      expect(parseActionPrefix("%")).toBeUndefined();
      expect(parseActionPrefix("a.b.")).toBeUndefined();
      expect(parseActionPrefix("")).toBeUndefined();
    });
  });
});

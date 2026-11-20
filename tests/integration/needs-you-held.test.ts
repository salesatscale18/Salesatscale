/**
 * Needs you, "Asked for a person" (UX, 20 Nov): a lead handed to a person counts
 * only while nobody holds its chat. An owner, or a taken-over open chat, moves it
 * to With your team; its other items (here a bank transfer) still count.
 * needsYouCount always agrees with needsYou.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentVersions, catalogVersions, conversations, leads, orderForms, orders, quotes, quoteVersions, sellerAccounts, users, type User } from "@/db/schema";
import { needsYou, needsYouCount } from "@/lib/overview/service";
import { handBack, takeOver } from "@/lib/agent/conversation";
import { createTestDb, type TestDb } from "../helpers/db";

const HOUR = 3_600_000;
const now = new Date("2026-11-20T12:00:00Z");

describe("Needs you: Asked for a person only while nobody holds the chat", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let cv: string;
  let av: string;
  let phone = 0;

  const actor = () => ({ userId: me.id, actingAs: false });
  const mkLead = async (fullName: string, o: Partial<typeof leads.$inferInsert> = {}) => {
    const [l] = await db.insert(leads).values({
      accountId: acc, fullName, phone: `+97252666${String(phone++).padStart(4, "0")}`, language: "en", origin: "manual",
      status: "human_handling", lastActivityAt: new Date(now.getTime() - HOUR), ...o,
    }).returning();
    return l;
  };
  const mkConv = async (leadId: string) =>
    (await db.insert(conversations).values({ accountId: acc, leadId, channel: "whatsapp", agentVersionId: av, language: "en", status: "human" }).returning())[0];
  const mkBankTransfer = async (leadId: string) => {
    const quoteId = randomUUID();
    await db.insert(quotes).values({ id: quoteId, accountId: acc, leadId, number: 1000 + phone, status: "sent", createdAt: now });
    const qv = randomUUID();
    await db.insert(quoteVersions).values({
      id: qv, accountId: acc, quoteId, version: 1, catalogVersionId: cv, currency: "ILS", pricesIncludeTax: true, taxRateBp: 1800,
      oneTimeSubtotalMinor: 0, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 0,
      recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0,
      approvalReasons: [], validUntil: new Date(now.getTime() + 7 * 24 * HOUR), createdByActor: "agent",
    });
    const formId = randomUUID();
    await db.insert(orderForms).values({
      id: formId, accountId: acc, leadId, quoteId, quoteVersionId: qv, tokenHash: randomUUID(), language: "en", snapshot: {} as never,
      expiresAt: new Date(now.getTime() + 5 * 24 * HOUR), createdBy: "agent", createdAt: now, status: "signed", signedAt: now,
    });
    await db.insert(orders).values({
      id: randomUUID(), accountId: acc, leadId, quoteId, orderFormId: formId, number: 2000 + phone, currency: "ILS",
      amountDueMinor: 100_000, recurringMinor: 0, paymentStatus: "bank_transfer_expected",
    });
  };
  /** The lead's item kinds in Needs you, after checking the counter agrees with the list. */
  const kindsOf = async (leadId: string) => {
    const items = await needsYou(db, acc, now);
    expect(await needsYouCount(db, acc, now)).toBe(items.length);
    return items.filter((i) => i.leadId === leadId).map((i) => i.kind).sort();
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u_held", email: "held@p.test", firstName: "Dana", role: "user" }).returning();
    const [a] = await db.insert(sellerAccounts).values({
      slug: "held-chat", tradeName: "Held", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS",
      plan: "pilot", monthlySpendCapMinor: 100_000,
    }).returning();
    acc = a.id;
    cv = randomUUID();
    await db.insert(catalogVersions).values({ id: cv, accountId: acc, version: 1, status: "draft" });
    av = randomUUID();
    const pb = { agentName: "A", goal: "", tone: "", outcomes: { orderForm: true, bankTransfer: true, meeting: false }, fields: [], objections: [], maxDiscountBp: 0, offerMeetingWhen: "", handOffWhen: "", neverDo: [] };
    await db.insert(agentVersions).values({ id: av, accountId: acc, version: 1, status: "live", playbook: pb, model: "m" });
  });
  afterAll(async () => { await t.close(); });

  it("handed with nobody holding the chat: in; taken over: out; handed back and handed again: in", async () => {
    const lead = await mkLead("Nobody Holds");
    const conv = await mkConv(lead.id);
    expect(await kindsOf(lead.id)).toEqual(["human_handling"]);

    expect((await takeOver(db, actor(), acc, conv.id, now)).ok).toBe(true);
    const [held] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(held).toMatchObject({ status: "human", takenOverByUserId: me.id });
    expect(await kindsOf(lead.id)).toEqual([]);

    // Handed back: the chat is open again; the agent hands it to a person again, still no owner.
    expect((await handBack(db, actor(), acc, conv.id, now)).ok).toBe(true);
    const [open] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(open).toMatchObject({ status: "open", takenOverByUserId: null });
    await db.update(leads).set({ status: "human_handling" }).where(eq(leads.id, lead.id));
    expect(await kindsOf(lead.id)).toEqual(["human_handling"]);
  });

  it("an owner holds the chat: out of Needs you", async () => {
    const lead = await mkLead("Owned Lead");
    expect(await kindsOf(lead.id)).toEqual(["human_handling"]);
    await db.update(leads).set({ ownerUserId: me.id }).where(eq(leads.id, lead.id));
    expect(await kindsOf(lead.id)).toEqual([]);
  });

  it("a held lead keeps its other items: a bank transfer awaiting confirmation still counts", async () => {
    const owned = await mkLead("Owned Payer", { ownerUserId: me.id });
    await mkBankTransfer(owned.id);
    expect(await kindsOf(owned.id)).toEqual(["bank_transfer"]);

    const taken = await mkLead("Taken Payer");
    const conv = await mkConv(taken.id);
    await mkBankTransfer(taken.id);
    expect(await kindsOf(taken.id)).toEqual(["bank_transfer", "human_handling"]);
    expect((await takeOver(db, actor(), acc, conv.id, now)).ok).toBe(true);
    expect(await kindsOf(taken.id)).toEqual(["bank_transfer"]);
  });
});

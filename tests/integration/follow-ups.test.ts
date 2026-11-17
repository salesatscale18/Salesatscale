/**
 * Agreed follow-ups (P11 follow-up, decision 4): the schedule_follow_up tool,
 * the platform scheduler (selection, locking, cancel reasons, contact hours,
 * channels, retries), the seller's Cancel, Needs you and the cron route.
 * Scripted model only: nothing here calls the real API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentVersions, auditLog, catalogVersions, conversations, dealStates, followUps, leadEvents, leads, messages, orderForms, orders,
  quoteVersions, quotes, sellerAccounts, toolCalls, users, type ContactHours, type User,
} from "@/db/schema";
import { ensureDraftVersion } from "@/lib/agent/service";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { runBuyerTurn } from "@/lib/agent/turn";
import { ScriptedLlm } from "@/lib/agent/llm";
import { takeOver } from "@/lib/agent/conversation";
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { cancelFollowUp, leadFollowUp } from "@/lib/follow-ups/schedule";
import { runDueFollowUps } from "@/lib/follow-ups/scheduler";
import { needsYou, needsYouCount } from "@/lib/overview/service";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => { throw new Error("not used"); },
}));
const route = await import("@/app/api/cron/follow-ups/route");

const MIN = 60_000;
const HOUR = 60 * MIN;
const ALL_DAY: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const CLOSED: ContactHours = Array.from({ length: 7 }, () => ({ on: false, from: "08:00", to: "09:00" }));
const MONDAY_ONLY: ContactHours = Array.from({ length: 7 }, (_, i) => ({ on: i === 1, from: "09:00", to: "10:00" }));

/** A due time `hours` ahead on a whole local hour (never in the 23:59 gap of ALL_DAY). */
const aheadOnTheHour = (hours: number) => {
  const d = new Date(Date.now() + hours * HOUR);
  d.setUTCMinutes(0, 0, 0);
  return d;
};
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

describe("Agreed follow-ups", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let n = 0;

  const mkAccount = async (extra: Partial<typeof sellerAccounts.$inferInsert> = {}) => {
    const [a] = await db.insert(sellerAccounts).values({
      slug: `acc-${n++}`, tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS",
      plan: "pilot", monthlySpendCapMinor: 100_000, status: "live", contactHours: ALL_DAY, ...extra,
    }).returning();
    const draft = await ensureDraftVersion(db, a.id);
    const [v] = await db.update(agentVersions).set({ playbook: { ...draft.playbook, agentName: "Maya" } }).where(eq(agentVersions.id, draft.id)).returning();
    return { account: a, version: v };
  };

  type Chat = { accountId: string; leadId: string; conversationId: string; versionId: string };
  const mkChat = async (
    acc: { account: { id: string }; version: { id: string } },
    o: { channel?: string; language?: string; fullName?: string; isTest?: boolean; convStatus?: "open" | "human" | "closed"; buyerAt?: Date | null } = {},
  ): Promise<Chat> => {
    const accountId = acc.account.id;
    const [lead] = await db.insert(leads).values({
      accountId, fullName: o.fullName ?? "Rina Cohen", phone: `+97252555${String(n++).padStart(4, "0")}`, language: o.language ?? "en", origin: "manual",
      isTest: o.isTest ?? false,
    }).returning();
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      id: conversationId, accountId, leadId: lead.id, channel: o.channel ?? "simulator", agentVersionId: acc.version.id,
      language: o.language ?? "en", status: o.convStatus ?? "open", isTest: o.isTest ?? false,
    });
    if (o.buyerAt !== null) {
      await db.insert(messages).values({ accountId, conversationId, actor: "buyer", body: "maybe later", language: o.language ?? "en", createdAt: o.buyerAt ?? new Date(Date.now() - HOUR) });
    }
    return { accountId, leadId: lead.id, conversationId, versionId: acc.version.id };
  };

  /** A follow-up row as the tool writes it, due at `dueAt`, scheduled 30 minutes ago. */
  const mkFollowUp = async (c: Chat, dueAt: Date, extra: Partial<typeof followUps.$inferInsert> = {}) => {
    const [f] = await db.insert(followUps).values({
      accountId: c.accountId, leadId: c.leadId, conversationId: c.conversationId, dueAt, topic: "the second kitchen", language: "en",
      createdAt: new Date(Date.now() - 30 * MIN), ...extra,
    }).returning();
    return f;
  };
  const row = async (id: string) => (await db.select().from(followUps).where(eq(followUps.id, id)))[0];
  const agentMessages = (conversationId: string) =>
    db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent")));

  const ctxFor = async (c: Chat): Promise<ToolContext> => {
    const [v] = await db.select().from(agentVersions).where(eq(agentVersions.id, c.versionId));
    return { db, accountId: c.accountId, conversationId: c.conversationId, leadId: c.leadId, playbook: v.playbook, currency: "ILS", callId: randomUUID(), language: "en" };
  };
  const schedule = async (c: Chat, dueAt: unknown, topic = "the second kitchen") => runTool("schedule_follow_up", { due_at: dueAt, topic }, await ctxFor(c));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
  });
  afterAll(async () => t.close());

  // -------------------------------------------------------------------------
  describe("schedule_follow_up", () => {
    let acc: Awaited<ReturnType<typeof mkAccount>>;
    beforeAll(async () => { acc = await mkAccount(); });

    it("schedules, sets the deal's next step, logs it, and answers with the local time", async () => {
      const c = await mkChat(acc);
      const due = aheadOnTheHour(26);
      const r = await schedule(c, iso(due), "  the quote for the second kitchen ");
      expect(r.outcome).toBe("ok");
      expect(r.result).toMatchObject({ ok: true, due_local: expect.stringMatching(/^\w{3} \d{1,2} \w{3} \d{2}:00$/) });
      const [f] = await db.select().from(followUps).where(eq(followUps.leadId, c.leadId));
      expect(f).toMatchObject({ status: "scheduled", topic: "the quote for the second kitchen", language: "en", conversationId: c.conversationId, attempts: 0 });
      expect(f.dueAt.getTime()).toBe(due.getTime());
      const [deal] = await db.select().from(dealStates).where(eq(dealStates.leadId, c.leadId));
      expect(deal.nextStep).toBe(`Follow up ${r.result.due_local}: the quote for the second kitchen`);
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.accountId, c.accountId), eq(auditLog.action, "follow_up.scheduled")));
      expect(audit.map((a) => a.targetId)).toContain(f.id);
      const ev = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "follow_up.scheduled")));
      expect(ev).toHaveLength(1);
    });

    it("one per lead: a new time replaces the old one", async () => {
      const c = await mkChat(acc);
      await schedule(c, iso(aheadOnTheHour(5)));
      const r = await schedule(c, iso(aheadOnTheHour(48)), "pricing");
      expect(r.result).toMatchObject({ ok: true, replaced_earlier: true });
      const rows = await db.select().from(followUps).where(eq(followUps.leadId, c.leadId));
      expect(rows.map((x) => [x.status, x.reason]).sort()).toEqual([["cancelled", "replaced"], ["scheduled", null]]);
      expect(rows.find((x) => x.status === "scheduled")!.topic).toBe("pricing");
    });

    it("refuses a time less than 15 minutes or more than 30 days ahead, or without an offset", async () => {
      const c = await mkChat(acc);
      expect((await schedule(c, iso(new Date(Date.now() + 10 * MIN)))).rule).toBe("Time is less than 15 minutes ahead");
      expect((await schedule(c, iso(new Date(Date.now() + 31 * 24 * HOUR)))).rule).toBe("Time is more than 30 days ahead");
      const bad = await schedule(c, "tomorrow at 10");
      expect(bad).toMatchObject({ outcome: "refused", rule: "Invalid time" });
      expect(String(bad.result.message)).toMatch(/\+0[23]:00/);
      expect(await db.select().from(followUps).where(eq(followUps.leadId, c.leadId))).toHaveLength(0);
    });

    it("outside contact hours: not scheduled, the nearest allowed time comes back to offer the buyer", async () => {
      const mon = await mkAccount({ contactHours: MONDAY_ONLY });
      const c = await mkChat(mon);
      // A Saturday noon (Jerusalem) within the next 8 days.
      let sat = aheadOnTheHour(24);
      while (new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short" }).format(sat) !== "Sat") sat = new Date(sat.getTime() + 24 * HOUR);
      const r = await schedule(c, iso(sat));
      expect(r).toMatchObject({ outcome: "refused", rule: "Outside contact hours" });
      const suggested = new Date(String(r.result.suggested_due_at));
      expect(isWithinContactHours(MONDAY_ONLY, "Asia/Jerusalem", suggested)).toBe(true);
      expect(String(r.result.suggested_due_at)).toMatch(/T09:\d{2}:00\+02:00$/);
      expect(String(r.result.message)).toContain("Offer the buyer");
      // Agreeing the suggested time schedules it.
      expect((await schedule(c, r.result.suggested_due_at)).outcome).toBe("ok");
    });

    it("refused for an opted-out lead, a chat a person holds, and a paused account", async () => {
      const opted = await mkChat(acc);
      await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, opted.leadId));
      expect((await schedule(opted, iso(aheadOnTheHour(5)))).rule).toBe("Lead opted out");
      const held = await mkChat(acc, { convStatus: "human" });
      expect((await schedule(held, iso(aheadOnTheHour(5)))).rule).toBe("The agent is paused for this chat");
      const paused = await mkAccount({ status: "paused" });
      expect((await schedule(await mkChat(paused), iso(aheadOnTheHour(5)))).rule).toBe("The seller's account is paused");
      for (const c of [opted, held]) expect(await db.select().from(followUps).where(eq(followUps.leadId, c.leadId))).toHaveLength(0);
    });

    it("the next turn's context shows the scheduled follow-up and the local time", async () => {
      const c = await mkChat(acc);
      await schedule(c, iso(aheadOnTheHour(26)), "the second kitchen");
      const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "Sure, talk tomorrow." }] })]);
      const r = await runBuyerTurn(db, llm, { accountId: c.accountId, conversationId: c.conversationId, text: "ok thanks" });
      expect(r.status).toBe("replied");
      const turn = llm.requests[0].system[1];
      expect(turn).toMatch(/Follow-up scheduled: you write to the buyer on \w{3} \d{1,2} \w{3} \d{2}:00 about the second kitchen\./);
      expect(turn).toContain("Local time now:");
      expect(turn).toContain("(Asia/Jerusalem, UTC+0");
      expect(llm.requests[0].tools.map((x: { name: string }) => x.name)).toContain("schedule_follow_up");
    });
  });

  // -------------------------------------------------------------------------
  describe("the scheduler", () => {
    let acc: Awaited<ReturnType<typeof mkAccount>>;
    beforeAll(async () => { acc = await mkAccount(); });
    const now = () => new Date();

    it("sends a due follow-up into a simulated chat as a fixed app message, once", async () => {
      const c = await mkChat(acc);
      const f = await mkFollowUp(c, new Date(Date.now() - MIN));
      const later = await mkFollowUp(await mkChat(acc), new Date(Date.now() + HOUR));
      const s = await runDueFollowUps(db, null, now());
      expect(s).toMatchObject({ sent: 1 });
      const done = await row(f.id);
      expect(done).toMatchObject({ status: "sent", reason: null, attempts: 0 });
      const [m] = await agentMessages(c.conversationId);
      expect(done.sentMessageId).toBe(m.id);
      expect(m.body).toBe("Hi Rina, it's Maya from Polar Demo. You asked me to check back today about the second kitchen. Is now a good time?");
      expect(m.deliveryStatus).toBe("delivered");
      const [call] = await db.select().from(toolCalls).where(eq(toolCalls.messageId, m.id));
      expect(call).toMatchObject({ name: "app_message", result: { kind: "follow_up", message_id: m.id } });
      expect((await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, c.leadId), eq(leadEvents.type, "follow_up.sent"))))).toHaveLength(1);
      // Not due yet: untouched.
      expect(await row(later.id)).toMatchObject({ status: "scheduled", sentMessageId: null });
      // A second run sends nothing more.
      await runDueFollowUps(db, null, now());
      expect(await agentMessages(c.conversationId)).toHaveLength(1);
    });

    it("two runs at the same time never send twice", async () => {
      const chats = await Promise.all([mkChat(acc), mkChat(acc), mkChat(acc)]);
      for (const c of chats) await mkFollowUp(c, new Date(Date.now() - 5 * MIN));
      const [a, b] = await Promise.all([runDueFollowUps(db, null, now()), runDueFollowUps(db, null, now())]);
      expect(a.sent + b.sent).toBe(3);
      for (const c of chats) expect(await agentMessages(c.conversationId)).toHaveLength(1);
    });

    it("works through due rows in batches, oldest first", async () => {
      const chats = await Promise.all(Array.from({ length: 5 }, () => mkChat(acc)));
      const rows = [];
      for (const [i, c] of chats.entries()) rows.push(await mkFollowUp(c, new Date(Date.now() - (10 - i) * MIN)));
      const s = await runDueFollowUps(db, null, now(), { batchSize: 2, maxBatches: 2 });
      expect(s.sent).toBe(4);
      // The newest one waits for the next run.
      expect(await row(rows[4].id)).toMatchObject({ status: "scheduled" });
      expect((await runDueFollowUps(db, null, now())).sent).toBe(1);
    });

    it("writes Hebrew with the local names and the agent's gender", async () => {
      const he = await mkAccount({ tradeNameLocal: { he: "פולאר" } });
      await db.update(agentVersions).set({ playbook: { ...he.version.playbook, agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentGender: "female" } })
        .where(eq(agentVersions.id, he.version.id));
      const c = await mkChat(he, { language: "he", fullName: "רינה כהן" });
      await mkFollowUp(c, new Date(Date.now() - MIN), { language: "he", topic: "ההצעה" });
      await runDueFollowUps(db, null, now());
      const [m] = await agentMessages(c.conversationId);
      expect(m.body).toBe("היי רינה, זו מאיה מפולאר. ביקשת שאחזור אליך היום לגבי ההצעה. זה זמן טוב לדבר?");
      expect(m.language).toBe("he");
    });

    describe("cancels instead of sending", () => {
      const expectCancelled = async (c: Chat, reason: string) => {
        const f = await mkFollowUp(c, new Date(Date.now() - MIN));
        const s = await runDueFollowUps(db, null, now());
        expect(await row(f.id)).toMatchObject({ status: "cancelled", reason, sentMessageId: null });
        expect(s.cancelReasons[reason as keyof typeof s.cancelReasons]).toBe(1);
        expect(await agentMessages(c.conversationId)).toHaveLength(0);
      };
      it("the lead opted out", async () => {
        const c = await mkChat(acc);
        await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, c.leadId));
        await expectCancelled(c, "opted_out");
      });
      it("the account is paused", async () => {
        await expectCancelled(await mkChat(await mkAccount({ status: "paused" })), "account_paused");
      });
      it("the account is not live (real WhatsApp chats)", async () => {
        const setup = await mkAccount({ status: "setting_up" });
        await expectCancelled(await mkChat(setup, { channel: "whatsapp", buyerAt: new Date(Date.now() - HOUR) }), "account_not_live");
        // A simulated chat still gets it while the account is set up.
        const sim = await mkChat(setup);
        await mkFollowUp(sim, new Date(Date.now() - MIN));
        await runDueFollowUps(db, null, now());
        expect(await agentMessages(sim.conversationId)).toHaveLength(1);
      });
      it("the order is paid", async () => {
        const c = await mkChat(acc);
        const [cv] = await db.insert(catalogVersions).values({ id: randomUUID(), accountId: c.accountId, version: 1 }).returning();
        const quoteId = randomUUID();
        await db.insert(quotes).values({ id: quoteId, accountId: c.accountId, leadId: c.leadId, number: 1001 + n++, status: "sent" });
        const qvId = randomUUID();
        await db.insert(quoteVersions).values({
          id: qvId, accountId: c.accountId, quoteId, version: 1, catalogVersionId: cv.id, currency: "ILS", pricesIncludeTax: true, taxRateBp: 1800,
          oneTimeSubtotalMinor: 0, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 0, recurringSubtotalMinor: 0, recurringDiscountMinor: 0,
          recurringTaxMinor: 0, recurringTotalMinor: 0, approvalReasons: [], validUntil: new Date(Date.now() + 24 * HOUR), createdByActor: "agent",
        });
        const formId = randomUUID();
        await db.insert(orderForms).values({
          id: formId, accountId: c.accountId, leadId: c.leadId, quoteId, quoteVersionId: qvId, tokenHash: randomUUID(), language: "en", snapshot: {} as never,
          expiresAt: new Date(Date.now() + 24 * HOUR), createdBy: "agent", status: "signed", signedAt: new Date(),
        });
        await db.insert(orders).values({
          id: randomUUID(), accountId: c.accountId, leadId: c.leadId, quoteId, orderFormId: formId, number: 1, currency: "ILS",
          amountDueMinor: 100, recurringMinor: 0, paymentStatus: "paid",
        });
        await expectCancelled(c, "paid");
      });
      it("the buyer wrote after it was scheduled", async () => {
        const c = await mkChat(acc);
        await db.insert(messages).values({ accountId: c.accountId, conversationId: c.conversationId, actor: "buyer", body: "actually, now works", language: "en", createdAt: new Date(Date.now() - 10 * MIN) });
        await expectCancelled(c, "buyer_replied");
      });
      it("the chat is closed", async () => {
        await expectCancelled(await mkChat(acc, { convStatus: "closed" }), "conversation_closed");
      });
      it("a person took over the chat (cancelled at once, and at send time)", async () => {
        await expectCancelled(await mkChat(acc, { convStatus: "human" }), "taken_over");
        const c = await mkChat(acc);
        const f = await mkFollowUp(c, new Date(Date.now() + HOUR));
        expect(await takeOver(db, { userId: me.id, actingAs: false }, c.accountId, c.conversationId)).toMatchObject({ ok: true });
        expect(await row(f.id)).toMatchObject({ status: "cancelled", reason: "taken_over" });
      });
    });

    it("outside contact hours it stays scheduled and goes out at the next run inside hours", async () => {
      const closed = await mkAccount({ contactHours: CLOSED });
      const c = await mkChat(closed);
      const f = await mkFollowUp(c, new Date(Date.now() - MIN));
      const s = await runDueFollowUps(db, null, now());
      expect(s.deferred).toBe(1);
      expect(await row(f.id)).toMatchObject({ status: "scheduled", reason: null, attempts: 0 });
      expect(await agentMessages(c.conversationId)).toHaveLength(0);
      await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, c.accountId));
      await runDueFollowUps(db, null, now());
      expect(await row(f.id)).toMatchObject({ status: "sent" });
    });

    it("WhatsApp outside the 24-hour window: failed (a template is needed), nothing written", async () => {
      const c = await mkChat(acc, { channel: "whatsapp", buyerAt: new Date(Date.now() - 25 * HOUR) });
      const f = await mkFollowUp(c, new Date(Date.now() - MIN));
      const s = await runDueFollowUps(db, null, now());
      expect(s.failed).toBe(1);
      expect(await row(f.id)).toMatchObject({ status: "failed", reason: "whatsapp_window_closed" });
      expect(await agentMessages(c.conversationId)).toHaveLength(0);
      // The same rule in a simulated chat with "Simulate WhatsApp rules" on.
      const rules = await mkAccount({ simulateWhatsappRules: true });
      const sim = await mkChat(rules, { buyerAt: new Date(Date.now() - 25 * HOUR) });
      const g = await mkFollowUp(sim, new Date(Date.now() - MIN));
      await runDueFollowUps(db, null, now());
      expect(await row(g.id)).toMatchObject({ status: "failed", reason: "whatsapp_window_closed" });
    });

    it("a failed send is retried with the same message and stops after 3 attempts", async () => {
      // WhatsApp inside the window, but no provider configured: every send fails.
      const c = await mkChat(acc, { channel: "whatsapp", buyerAt: new Date(Date.now() - 2 * HOUR) });
      const f = await mkFollowUp(c, new Date(Date.now() - MIN));
      expect((await runDueFollowUps(db, null, now())).retrying).toBe(1);
      expect(await row(f.id)).toMatchObject({ status: "scheduled", reason: "send_failed", attempts: 1 });
      expect((await runDueFollowUps(db, null, now())).retrying).toBe(1);
      expect(await row(f.id)).toMatchObject({ status: "scheduled", attempts: 2 });
      expect((await runDueFollowUps(db, null, now())).failed).toBe(1);
      expect(await row(f.id)).toMatchObject({ status: "failed", reason: "send_failed", attempts: 3 });
      expect((await runDueFollowUps(db, null, now())).due).toBe(0);
      const msgs = await agentMessages(c.conversationId);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ deliveryStatus: "not_sent", deliveryError: "not_configured" });
      expect((await row(f.id)).sentMessageId).toBe(msgs[0].id);
    });

    it("a failed follow-up shows in Needs you and on the lead page until dismissed", async () => {
      const own = await mkAccount();
      const c = await mkChat(own, { channel: "whatsapp", buyerAt: new Date(Date.now() - 30 * HOUR) });
      const f = await mkFollowUp(c, new Date(Date.now() - MIN));
      // A test lead's failure is not a "Needs you" item.
      const test = await mkChat(own, { channel: "whatsapp", isTest: true, buyerAt: new Date(Date.now() - 30 * HOUR) });
      await mkFollowUp(test, new Date(Date.now() - MIN));
      await runDueFollowUps(db, null, now());
      const items = await needsYou(db, own.account.id, now());
      expect(items).toEqual([expect.objectContaining({ kind: "follow_up_failed", leadId: c.leadId, followUpId: f.id, reason: "whatsapp_window_closed" })]);
      expect(await needsYouCount(db, own.account.id, now())).toBe(1);
      expect((await leadFollowUp(db, own.account.id, c.leadId))?.id).toBe(f.id);
      const access = { account: own.account, user: me, actingAs: false, role: "seller_admin" as const };
      expect(await cancelFollowUp(db, access, f.id)).toEqual({ ok: true, leadId: c.leadId });
      expect(await row(f.id)).toMatchObject({ status: "cancelled", reason: "dismissed_by_seller" });
      expect(await needsYouCount(db, own.account.id, now())).toBe(0);
      expect(await leadFollowUp(db, own.account.id, c.leadId)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("the seller cancels", () => {
    let mine: Awaited<ReturnType<typeof mkAccount>>, other: Awaited<ReturnType<typeof mkAccount>>;
    beforeAll(async () => { mine = await mkAccount(); other = await mkAccount(); });
    const accessTo = (a: typeof mine, role: string = "seller_admin") => ({ account: a.account, user: me, actingAs: false, role }) as Parameters<typeof cancelFollowUp>[1];

    it("only within the account, only an admin, audited", async () => {
      const c = await mkChat(mine);
      const f = await mkFollowUp(c, new Date(Date.now() + HOUR));
      expect(await cancelFollowUp(db, accessTo(other), f.id)).toEqual({ ok: false, reason: "not_found" });
      expect(await cancelFollowUp(db, accessTo(mine, "viewer"), f.id)).toEqual({ ok: false, reason: "forbidden" });
      expect(await row(f.id)).toMatchObject({ status: "scheduled" });
      expect((await leadFollowUp(db, mine.account.id, c.leadId))?.id).toBe(f.id);
      expect(await leadFollowUp(db, other.account.id, c.leadId)).toBeNull();

      expect(await cancelFollowUp(db, { ...accessTo(mine), actingAs: true }, f.id)).toEqual({ ok: true, leadId: c.leadId });
      expect(await row(f.id)).toMatchObject({ status: "cancelled", reason: "cancelled_by_seller" });
      const [a] = await db.select().from(auditLog).where(and(eq(auditLog.action, "follow_up.cancelled"), eq(auditLog.targetId, f.id)));
      expect(a).toMatchObject({ accountId: mine.account.id, actorUserId: me.id, actingAs: true });
      // Already cancelled: nothing more to do, and the scheduler never sends it.
      expect(await cancelFollowUp(db, accessTo(mine), f.id)).toEqual({ ok: false, reason: "not_found" });
      await db.update(followUps).set({ dueAt: new Date(Date.now() - MIN) }).where(eq(followUps.id, f.id));
      await runDueFollowUps(db, null, new Date());
      expect(await agentMessages(c.conversationId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("the cron route", () => {
    const SECRET = "test-cron-secret-0123456789";
    const call = (auth?: string) => route.GET(new Request("http://x/api/cron/follow-ups", { headers: auth ? { authorization: auth } : {} }));
    beforeEach(() => vi.unstubAllEnvs());

    it("answers 401 without the secret, with a wrong one, or when none is set", async () => {
      vi.stubEnv("CRON_SECRET", SECRET);
      expect((await call()).status).toBe(401);
      expect((await call("Bearer wrong")).status).toBe(401);
      expect((await call(SECRET)).status).toBe(401);
      vi.stubEnv("CRON_SECRET", "");
      expect((await call("Bearer ")).status).toBe(401);
      expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    });

    it("runs the scheduler and answers with counts only", async () => {
      vi.stubEnv("CRON_SECRET", SECRET);
      const acc = await mkAccount();
      const c = await mkChat(acc, { fullName: "Secret Person" });
      await mkFollowUp(c, new Date(Date.now() - MIN), { topic: "private topic" });
      const res = await call(`Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, sent: 1 });
      const text = JSON.stringify(body);
      expect(text).not.toContain("Secret");
      expect(text).not.toContain("private");
      expect(text).not.toContain(c.leadId);
    });
  });
});

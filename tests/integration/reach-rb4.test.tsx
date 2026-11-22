/**
 * RB4 (production review 22 Nov):
 * - Times the agent hands the buyer ("your time") use the buyer's stored zone
 *   (storedBuyerZone), else the lead's market zone: the schedule_follow_up
 *   result, request_callback's time, and the call time the team confirms in
 *   the chat (an app message).
 * - The seller's thread (conversationView: lead page, Conversations, test lab)
 *   shows the agent's line, then the booking card it offered, as the buyer page.
 * ScriptedLlm only; mock SMS; no network, no model calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { agentVersions, consentRecords, conversations, leadEvents, leads, messages, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ScriptedLlm, type Block } from "@/lib/agent/llm";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { conversationView } = await import("@/lib/agent/conversation");
const { startSimulatorConversation } = await import("@/lib/simulator/service");
const { confirmCallback, requestCallback } = await import("@/lib/callbacks/service");
const { storedBuyerZone } = await import("@/lib/team-calls/zone");
const { formatBuyerLocal, formatDueLocal, isoInZone } = await import("@/lib/follow-ups/rules");
const { buyerCallTime } = await import("@/lib/callbacks/rules");

const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const MARKET = "Asia/Jerusalem";
const BUYER = "America/New_York";
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
const step = (...content: Block[]) => () => ({ content });

describe("RB4: the buyer's zone in agent-facing times; the booking card under its line for the seller", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const access = async () => ({
    account: (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc)))[0], user: me, actingAs: false, role: "seller_admin" as const,
  });
  const addLead = async (zone?: string) => {
    const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Dana Demo", phone: `+97250740${String(1000 + ++n)}`, language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId: acc, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    const r = await startSimulatorConversation(db, actor(), acc, lead.id);
    if (!r.ok) throw new Error(r.reason);
    // The buyer opened the chat and the page stored the browser's zone (rememberBuyerZone).
    if (zone) await db.insert(leadEvents).values({ accountId: acc, leadId: lead.id, type: "chat.opened", actor: "buyer", data: { via: "link", buyerTimezone: zone } });
    return { lead, conversationId: r.conversationId };
  };
  const toolCtx = async (leadId: string, conversationId: string) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc), eq(agentVersions.status, "live")));
    return { db, accountId: acc, conversationId, leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  /** Tomorrow at 12:00 in the market's zone, as the agent passes it. */
  const tomorrowNoon = () => `${isoInZone(new Date(Date.now() + 86_400_000), MARKET).slice(0, 10)}T12:00`;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "urb4", email: "dana@rb4.test", firstName: "Dana", lastName: "Cohen", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: MARKET, currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@rb4.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
  }, 120_000);
  afterAll(async () => { await t.close(); });

  for (const [label, zone, expected] of [["a stored zone", BUYER, BUYER], ["no stored zone", undefined, MARKET]] as const) {
    it(`schedule_follow_up's due_local: ${label} → ${expected}`, async () => {
      const { lead, conversationId } = await addLead(zone);
      expect(await storedBuyerZone(db, acc, lead.id)).toBe(zone ?? null);
      const r = await runTool("schedule_follow_up", { due_at: tomorrowNoon(), topic: "pricing" }, await toolCtx(lead.id, conversationId));
      expect(r.outcome).toBe("ok");
      const res = r.result as { due_local: string; due_short: string };
      const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "follow_up.scheduled")));
      const due = new Date(String(ev.data?.dueAt));
      expect(res.due_local).toBe(formatBuyerLocal(due, expected));
      // The zones' hours differ, so the choice is visible.
      expect(formatBuyerLocal(due, BUYER)).not.toBe(formatBuyerLocal(due, MARKET));
      // A local due_at is read in the buyer's stored zone, else the market's (N1b): 12:00 there.
      expect(res.due_local).toContain("at 12:00");
      // due_short (the seller's trace) stays in the market's zone.
      expect(res.due_short).toBe(formatDueLocal(due, MARKET));
    });

    it(`request_callback's time for the buyer and the team's confirmation in the chat: ${label} → ${expected}`, async () => {
      const { lead, conversationId } = await addLead(zone);
      const r = await requestCallback(db, { accountId: acc, leadId: lead.id, conversationId }, { time: tomorrowNoon(), brief: "Pricing for 3 sites" });
      if (!r.ok) throw new Error(r.rule);
      expect(r.timeForBuyer).toBe(formatBuyerLocal(r.request.at, expected));
      expect(r.request.buyerTimezone ?? null).toBeNull();
      expect(await confirmCallback(db, await access(), lead.id, r.request.id, null)).toMatchObject({ ok: true });
      const [told] = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent")))
        .orderBy(asc(messages.createdAt)).then((ms) => ms.filter((m) => m.body.startsWith("Your call is confirmed")));
      expect(told.body).toContain(buyerCallTime(r.request.at, expected, "en"));
    });
  }

  it("the seller's thread shows the agent's line, then the booking card it offered", async () => {
    const { conversationId } = await addLead();
    const line = "Of course. Pick a time that suits you and someone from our team will call you.";
    const llm = new ScriptedLlm([step(use("t1", "request_callback", { brief: "Wants to talk pricing with a person." })), step(say(line))]);
    const r = await runBuyerTurn(db, llm, { accountId: acc, conversationId, text: "I'd like to talk this through with someone on your team." });
    expect(r.status).toBe("replied");
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    const view = await conversationView(db, acc, conv);
    const bodies = view.thread.map(({ message: m }) => m.body);
    const lineAt = bodies.indexOf(line);
    const cardAt = bodies.findIndex((b) => b.startsWith("Pick a time for a 15-minute call"));
    expect(lineAt).toBeGreaterThan(0);
    expect(cardAt).toBe(lineAt + 1);
  });
});

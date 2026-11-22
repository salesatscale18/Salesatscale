/**
 * N1b: the agent's clock and schedule_follow_up read local times in the
 * buyer's stored zone (else the market's), as request_callback does (N1).
 * - "Local time now" in the chat turn's context is in the buyer's stored zone.
 * - schedule_follow_up reads a local due_at in the buyer's zone; an explicit
 *   offset is unaffected; the contact-hours check for a time the agent
 *   proposed still uses the market's hours, on the right instant.
 * A London buyer on a Jerusalem market. ScriptedLlm only: no model calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, consentRecords, followUps, leadEvents, leads, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import { ScriptedLlm } from "@/lib/agent/llm";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { runTool } = await import("@/lib/agent/tools");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { startSimulatorConversation } = await import("@/lib/simulator/service");
const { formatBuyerLocal, formatDueLocal, isoInZone, localNowLine } = await import("@/lib/follow-ups/rules");

const MARKET = "Asia/Jerusalem";
const BUYER = "Europe/London";
// Market contact hours: 09:00 to 17:00 every day, in the market's zone.
const HOURS = Array.from({ length: 7 }, () => ({ on: true, from: "09:00", to: "17:00" }));
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));

describe("N1b: the agent's clock and schedule_follow_up in the buyer's stored zone", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let n = 0;
  const actor = () => ({ userId: me.id, actingAs: false });
  const addLead = async (zone?: string) => {
    const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Lee London", phone: `+44770090${String(1000 + ++n)}`, language: "en", origin: "manual" }).returning();
    await db.insert(consentRecords).values({ accountId: acc, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
    // The conversation starts at any hour of the test run; the market's hours then apply to scheduling.
    await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, acc));
    const r = await startSimulatorConversation(db, actor(), acc, lead.id);
    await db.update(sellerAccounts).set({ contactHours: HOURS }).where(eq(sellerAccounts.id, acc));
    if (!r.ok) throw new Error(r.reason);
    if (zone) await db.insert(leadEvents).values({ accountId: acc, leadId: lead.id, type: "chat.opened", actor: "buyer", data: { via: "link", buyerTimezone: zone } });
    return { lead, conversationId: r.conversationId };
  };
  const toolCtx = async (leadId: string, conversationId: string) => {
    const [v] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc), eq(agentVersions.status, "live")));
    return { db, accountId: acc, conversationId, leadId, playbook: v.playbook, currency: "ILS", callId: `c${n++}`, language: "en" };
  };
  /** A date two days ahead (the market's calendar), as the agent writes it. */
  const day = () => isoInZone(new Date(Date.now() + 2 * 86_400_000), MARKET).slice(0, 10);
  const schedule = async (leadId: string, conversationId: string, input: Record<string, unknown>) =>
    runTool("schedule_follow_up", { topic: "pricing", buyer_named_time: false, ...input }, await toolCtx(leadId, conversationId));
  const dueOf = async (leadId: string) => (await db.select().from(followUps).where(and(eq(followUps.leadId, leadId), eq(followUps.status, "scheduled"))))[0].dueAt;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "un1b", email: "lee@n1b.test", firstName: "Lee", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar N1b", market: "IL", languages: ["en", "he"], timezone: MARKET, currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@n1b.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live", contactHours: HOURS }).where(eq(sellerAccounts.id, acc));
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("Local time now: in the buyer's stored zone; the market's when none is stored", async () => {
    for (const [zone, expected] of [[BUYER, /^Local time now: \w{3} \d{1,2} \w{3} \d{4} \d{2}:\d{2} \(Europe\/London, UTC\+0[01]:00\)$/m], [undefined, /^Local time now: \w{3} \d{1,2} \w{3} \d{4} \d{2}:\d{2} \(Asia\/Jerusalem, UTC\+0[23]:00\)$/m]] as const) {
      const { conversationId } = await addLead(zone);
      const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "Sure." }] })]);
      const before = localNowLine(new Date(), zone ?? MARKET);
      expect((await runBuyerTurn(db, llm, { accountId: acc, conversationId, text: "Thanks" })).status).toBe("replied");
      const after = localNowLine(new Date(), zone ?? MARKET);
      const context = llm.requests[0].system[1];
      expect(context).toMatch(expected);
      // Same format, the zone's clock now (the minute may turn during the turn).
      const shown = context.match(/^Local time now: (.+)$/m)![1];
      expect([before, after]).toContain(shown);
    }
  });

  it("a local due_at is read as London time; due_local is in London time", async () => {
    const { lead, conversationId } = await addLead(BUYER);
    const r = await schedule(lead.id, conversationId, { due_at: `${day()}T10:00`, buyer_named_time: true });
    expect(r.outcome).toBe("ok");
    const due = await dueOf(lead.id);
    expect(isoInZone(due, BUYER).slice(0, 16)).toBe(`${day()}T10:00`);
    const res = r.result as { due_local: string; due_short: string };
    expect(res.due_local).toBe(formatBuyerLocal(due, BUYER));
    expect(res.due_local).toContain("at 10:00");
    // The seller's trace stays in the market's zone (12:00 there).
    expect(res.due_short).toBe(formatDueLocal(due, MARKET));
    expect(res.due_short).toContain("12:00");
  });

  it("no stored zone: a local due_at is read in the market's zone, as before", async () => {
    const { lead, conversationId } = await addLead();
    expect((await schedule(lead.id, conversationId, { due_at: `${day()}T10:00` })).outcome).toBe("ok");
    expect(isoInZone(await dueOf(lead.id), MARKET).slice(0, 16)).toBe(`${day()}T10:00`);
  });

  it("a due_at with an explicit offset is unaffected by the buyer's zone", async () => {
    const { lead, conversationId } = await addLead(BUYER);
    const at = `${day()}T10:00:00${isoInZone(new Date(`${day()}T08:00:00Z`), MARKET).slice(19)}`;
    expect((await schedule(lead.id, conversationId, { due_at: at })).outcome).toBe("ok");
    expect((await dueOf(lead.id)).getTime()).toBe(Date.parse(at));
  });

  it("an agent-proposed time: the market's contact hours, checked on the London instant", async () => {
    const { lead, conversationId } = await addLead(BUYER);
    // 16:00 London is 18:00 in Jerusalem: outside the market's 09:00-17:00 (it would be inside if read in the market's zone).
    const late = await schedule(lead.id, conversationId, { due_at: `${day()}T16:00` });
    expect(late.outcome).not.toBe("ok");
    const extra = late.result as { suggested_due_at: string; suggested_local: string };
    const suggested = new Date(extra.suggested_due_at);
    expect(isWithinContactHours(HOURS, MARKET, suggested)).toBe(true);
    // The time to offer the buyer is in London time.
    expect(extra.suggested_local).toBe(formatBuyerLocal(suggested, BUYER));
    // 14:00 London is 16:00 in Jerusalem: inside the market's hours.
    const ok = await schedule(lead.id, conversationId, { due_at: `${day()}T14:00` });
    expect(ok.outcome).toBe("ok");
    const due = await dueOf(lead.id);
    expect(isoInZone(due, BUYER).slice(0, 16)).toBe(`${day()}T14:00`);
    expect((ok.result as { due_local: string }).due_local).toBe(formatBuyerLocal(due, BUYER));
  });

  it("an invalid due_at: the example is given in the buyer's zone", async () => {
    const { lead, conversationId } = await addLead(BUYER);
    const r = await schedule(lead.id, conversationId, { due_at: "tomorrow at ten" });
    expect(r.outcome).not.toBe("ok");
    expect(JSON.stringify(r.result)).toContain(`the offset of ${BUYER}`);
  });
});

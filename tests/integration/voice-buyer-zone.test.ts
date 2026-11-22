/**
 * A call's context gives times in the buyer's stored zone, as the chat turn
 * does (RB4 / Zone review 3): the follow-up, the call request and the logged
 * team call, and "Local time now" (request_callback reads a local time in the
 * buyer's zone, N1). FREE scripted realtime model and ScriptedLlm only: no
 * paid call.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { followUps, leadEvents, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { ScriptedLlm } from "@/lib/agent/llm";
import { runTool } from "@/lib/agent/tools";
import { runBuyerTurn } from "@/lib/agent/turn";
import { formatBuyerLocal, isoInZone } from "@/lib/follow-ups/rules";
import { VoiceEngine } from "@/lib/voice/engine";
import { ManualClock } from "@/lib/voice/realtime";
import { ScriptedRealtime } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";

const MARKET = "Asia/Jerusalem";
const BUYER = "America/New_York";
const H = 3_600_000;

describe("voice: times in the buyer's stored zone, as in the chat turn", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "uz", email: "z@p.test", firstName: "Zoe", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Zone Co", market: "IL", languages: ["en", "he"], timezone: MARKET, currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "zone@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  });
  afterAll(async () => t.close());

  /** A buyer who opened the chat in their own zone (rememberBuyerZone stores it on chat.opened). */
  const buyer = async () => {
    const v = (await startVoiceTestConversation(db, acc, me.id, {}))!;
    await db.insert(leadEvents).values({ accountId: acc, leadId: v.leadId, type: "chat.opened", actor: "buyer", data: { via: "link", buyerTimezone: BUYER } });
    return v;
  };
  /** The call's first instructions (scripted realtime model). */
  const callInstructions = async (conversationId: string) => {
    const s = await createVoiceSession(db, { accountId: acc, conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
    if (!s.ok) throw new Error(s.reason);
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const e = new VoiceEngine({ db, model, sessionId: s.sessionId, send: () => {}, clock, limits: { standbyAfterQuietMs: 600_000, env: {} } });
    await e.start();
    await e.idle();
    const text = model.connections[0].cfg.instructions;
    await e.stop("user_hangup");
    return text;
  };
  /** The chat turn's per-turn context for the same conversation (ScriptedLlm, no API call). */
  const chatContext = async (conversationId: string) => {
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "Sure." }] })]);
    await runBuyerTurn(db, llm, { accountId: acc, conversationId, text: "Thanks" });
    return llm.requests[0].system[1];
  };

  it("follow-up and call request: the call names the buyer-zone times the chat turn names; Local time now in the buyer's zone", async () => {
    const v = await buyer();
    const { playbook } = await ensureDraftVersion(db, acc);
    const tomorrowNoon = `${isoInZone(new Date(Date.now() + 86_400_000), MARKET).slice(0, 10)}T12:00:00${isoInZone(new Date(), MARKET).slice(19)}`;
    const fu = await runTool("schedule_follow_up", { due_at: tomorrowNoon, topic: "pricing", buyer_named_time: true }, {
      db, accountId: acc, leadId: v.leadId, conversationId: v.conversationId, playbook, currency: "ILS", callId: randomUUID(), language: "en",
    });
    expect(fu.outcome).toBe("ok");
    const [f] = await db.select().from(followUps).where(eq(followUps.leadId, v.leadId));
    const at = new Date(Math.floor((Date.now() + 2 * 86_400_000) / H) * H);
    await db.insert(leadEvents).values({
      accountId: acc, leadId: v.leadId, type: "callback.requested", actor: "agent",
      data: { callbackId: randomUUID(), at: at.toISOString(), timezone: MARKET, brief: "Pricing", conversationId: v.conversationId },
    });
    const voice = await callInstructions(v.conversationId);
    const chat = await chatContext(v.conversationId);
    for (const time of [formatBuyerLocal(f.dueAt, BUYER), formatBuyerLocal(at, BUYER)]) {
      expect(chat, time).toContain(time);
      expect(voice, time).toContain(time);
    }
    expect(voice).toContain(`waiting for the team to confirm: ${formatBuyerLocal(at, BUYER)}.`);
    expect(voice).not.toContain(formatBuyerLocal(f.dueAt, MARKET));
    expect(voice).not.toContain(formatBuyerLocal(at, MARKET));
    // request_callback reads a local time in the buyer's zone (N1): the call's clock is the buyer's.
    expect(voice).toMatch(/^Local time now: .+ \(America\/New_York, UTC-0[45]:00\)$/m);
  });

  it("the logged team call: the call names its time in the buyer's zone, as the chat turn does", async () => {
    const v = await buyer();
    const callbackId = randomUUID();
    const at = new Date(Math.floor((Date.now() - 3 * H) / H) * H);
    await db.insert(leadEvents).values([
      { accountId: acc, leadId: v.leadId, type: "callback.requested", actor: "buyer", createdAt: new Date(at.getTime() - 86_400_000), data: { callbackId, at: at.toISOString(), timezone: MARKET, booked: true, brief: "Pricing" } },
      { accountId: acc, leadId: v.leadId, type: "team_call.logged", actor: "human", createdAt: new Date(at.getTime() + H), data: { callbackId, outcome: "spoke", startedAt: at.toISOString(), lengthMin: 12, note: "Wants 3 sites" } },
    ]);
    const voice = await callInstructions(v.conversationId);
    const chat = await chatContext(v.conversationId);
    const line = `The team spoke with the buyer on the phone on ${formatBuyerLocal(at, BUYER)} (12 min).`;
    expect(chat).toContain(line);
    expect(voice).toContain(line);
    expect(voice).not.toContain(formatBuyerLocal(at, MARKET));
  });
});

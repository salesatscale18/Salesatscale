/**
 * The pipeline proof against the one-agent block (lib/voice/one-agent.ts), with the real block and the real chat
 * turn: while the pipeline call's session is live, its own chat turn passes (runCallTurn sends callSessionId, which
 * the chat turn hands to textTurnBlocked as exceptSessionId) and stamps the reply with the session; a turn naming
 * any other session (unknown, or an earlier call on the same conversation) is still refused as in_call.
 * And the after-call reply (lib/voice/after-call.ts unansweredCallTurn) never answers a pipeline line a second time:
 * the stamped agent reply follows the buyer's line.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { ScriptedLlm } from "@/lib/agent/llm";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { unansweredCallTurn } from "@/lib/voice/after-call";
import { PipelineVoiceEngine } from "@/lib/voice-pipeline/engine";
import { ManualListener } from "@/lib/voice-pipeline/listener";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { runCallTurn } from "@/lib/voice-pipeline/turn";
import { createTestDb, type TestDb } from "../helpers/db";

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "q", email: "q@p.test", firstName: "Quinn", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "q-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await flushAsync(4);
    await new Promise((r) => setTimeout(r, 3));
  }
};

describe("pipeline proof and the one-agent block", () => {
  it("the call's own chat turn passes and is stamped; a turn for any other session is refused as in_call; after-call does not answer twice", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    // An earlier call on the same conversation (ended): its id does not open the block for the live one.
    const earlier = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "pipeline" });
    if (!earlier.ok) throw new Error(earlier.reason);
    await db.update(voiceSessions).set({ status: "ended", endedAt: new Date(), endReason: "user_hangup", durationSec: 0 }).where(eq(voiceSessions.id, earlier.sessionId));
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "pipeline" });
    if (!s.ok) throw new Error(s.reason);
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "It is 59 shekels per site." }] })]);
    const clock = new ManualClock();
    const lines: string[] = [];
    const engine = new PipelineVoiceEngine({
      db, sessionId: s.sessionId, mode: "scripted", send: () => {}, clock, log: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
      listener: () => new ManualListener(), speaker: new ScriptedSpeaker(), llm, limits: { env: {} },
    });
    await engine.start();
    await settle();
    await clock.advance(3_000, settle);
    expect((await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId)))[0].status).toBe("live");

    // Other sessions: refused (the model is not called).
    const base = { accountId: acc, conversationId: conv.conversationId, leadId: conv.leadId, text: "Hello?" };
    expect(await runCallTurn(db, llm, { ...base, callSessionId: randomUUID() })).toEqual({ status: "in_call" });
    expect(await runCallTurn(db, llm, { ...base, callSessionId: earlier.sessionId })).toEqual({ status: "in_call" });
    expect(llm.requests).toHaveLength(0);

    // The call's own turn, through the engine: answered and spoken.
    engine.onClientMessage({ t: "text", text: "How much is it?" });
    await settle();
    await clock.advance(3_000, settle);
    expect(llm.requests).toHaveLength(1);
    expect(lines.some((l) => l.includes("one-agent block"))).toBe(false);
    expect(lines.some((l) => /pipeline turn=1 listen=-ms think=\d+ms tools=0 speak=\d+ms total=\d+ms/.test(l))).toBe(true);
    engine.onClientMessage({ t: "end" });
    await settle();

    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.conversationId)).orderBy(asc(messages.createdAt));
    expect(rows.map((m) => [m.actor, m.actor === "system" ? "end" : m.body.startsWith("It is") || m.actor === "buyer" ? m.body : "opener"])).toEqual([
      ["agent", "opener"], ["buyer", "How much is it?"], ["agent", "It is 59 shekels per site."], ["system", "end"],
    ]);
    // The chat turn stamped the reply with this call; the engine gave it its spoken time and answer time.
    expect(rows[2]).toMatchObject({ voiceSessionId: s.sessionId });
    expect(rows[2].spokenAtMs).not.toBeNull();
    expect(rows[2].answerMs).not.toBeNull();

    // After the call: the buyer's line is answered (a stamped reply follows it), so the after-call reply never
    // answers it again, also for a session that is not a test (that check would otherwise apply).
    await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s.sessionId));
    const [ended] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId));
    expect(ended).toMatchObject({ status: "ended", endReason: "user_hangup" });
    expect(await unansweredCallTurn(db, ended)).toBeNull();
    // The control: without that reply the same line would be the after-call's to answer.
    await db.delete(messages).where(and(eq(messages.id, rows[2].id)));
    expect(await unansweredCallTurn(db, ended)).toMatchObject({ messageId: rows[1].id, claimed: false });
  });

  it("a reply never spoken (the call ends while the chat turn thinks) still gets its spoken time, logged", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "pipeline" });
    if (!s.ok) throw new Error(s.reason);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text", text: "A reply nobody hears." }] })]);
    const slow = { create: async (req: Parameters<typeof llm.create>[0]) => { await gate; return llm.create(req); } };
    const clock = new ManualClock();
    const lines: string[] = [];
    const engine = new PipelineVoiceEngine({
      db, sessionId: s.sessionId, mode: "scripted", send: () => {}, clock, log: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
      listener: () => new ManualListener(), speaker: new ScriptedSpeaker(), llm: slow, limits: { env: {} },
    });
    await engine.start();
    await settle();
    await clock.advance(3_000, settle);
    engine.onClientMessage({ t: "text", text: "Anything new?" });
    await settle();
    const stopped = engine.stop("user_hangup");
    release();
    await stopped;
    const [reply] = await db.select().from(messages).where(and(eq(messages.conversationId, conv.conversationId), eq(messages.body, "A reply nobody hears.")));
    expect(reply).toMatchObject({ voiceSessionId: s.sessionId, answerMs: null });
    expect(reply.spokenAtMs).not.toBeNull();
    expect(lines.some((l) => /pipeline reply not spoken \(the call ended while thinking\): spoken_at_ms set to \d+/.test(l))).toBe(true);
  });
});

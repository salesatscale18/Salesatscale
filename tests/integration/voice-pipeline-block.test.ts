/**
 * Documents TODAY's behaviour of the pipeline proof against the one-agent block (lib/voice/one-agent.ts), with the
 * real block (no stand-in): while the pipeline call's session is live, its own chat turn (replyToBuyer → runBuyerTurn)
 * is refused as in_call, the chat model is never called, the buyer's line stays stored and the engine says so in one
 * log line. Flips once the chat lane's `callSessionId` (→ textTurnBlocked `exceptSessionId`) is passed in
 * lib/voice-pipeline/turn.ts (the PIPELINE-HOOK line): then this test must be changed to expect a reply.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { messages, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { ScriptedLlm } from "@/lib/agent/llm";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
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

describe("pipeline proof and the one-agent block, today", () => {
  it("a real chat turn during the live pipeline call is refused as in_call (the model is not called)", async () => {
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" }, engine: "pipeline" });
    if (!s.ok) throw new Error(s.reason);
    const llm = new ScriptedLlm([]);
    const clock = new ManualClock();
    const lines: string[] = [];
    const engine = new PipelineVoiceEngine({
      db, sessionId: s.sessionId, mode: "scripted", send: () => {}, clock, log: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
      listener: () => new ManualListener(), speaker: new ScriptedSpeaker(), llm, limits: { env: {} },
    });
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 3));
      }
    };
    await engine.start();
    await settle();
    await clock.advance(3_000, settle);
    // The session is live now; the chat turn itself refuses (in_call).
    expect((await db.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId)))[0].status).toBe("live");
    expect(await runCallTurn(db, llm, { accountId: acc, conversationId: conv.conversationId, leadId: conv.leadId, text: "Hello?", callSessionId: s.sessionId }))
      .toEqual({ status: "in_call" });
    // Through the engine: the buyer's typed line is stored once, nothing answers it, the log says why.
    engine.onClientMessage({ t: "text", text: "How much is it?" });
    await settle();
    expect(lines.some((l) => l.includes("pipeline turn refused by the one-agent block (in_call)"))).toBe(true);
    expect(lines.some((l) => /pipeline turn=1 no reply status=in_call/.test(l))).toBe(true);
    expect(llm.requests).toHaveLength(0);
    engine.onClientMessage({ t: "end" });
    await settle();
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.conversationId)).orderBy(asc(messages.createdAt));
    expect(rows.map((m) => [m.actor, m.body.startsWith("Voice call ended") ? "end" : m.actor === "agent" ? "opener" : m.body])).toEqual([
      ["agent", "opener"], ["buyer", "How much is it?"], ["system", "end"],
    ]);
  });
});

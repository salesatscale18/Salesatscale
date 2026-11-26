/**
 * The spoken opener (owner, 26 Nov 2026): "Talk now" on the lead page hand-over opens an EMPTY conversation and the
 * call speaks the opener from its first word (the same text the chat would post, with the recording line after the
 * introduction); a conversation that already has the written opener gets the pick-up line, unchanged. If a call ends
 * with nothing said, the written opener is posted after it (lib/voice/written-opener.ts) on every end path: the
 * engine's end (hang-up before the first word, not started after the 15 s hold, model connect failure, error), a call
 * that ended before its engine started (endUnstartedVoiceSession) and the stale close. Never while a call is live, and
 * never when the opener (or a cut opener) was stored or the call continued a chat.
 * The New engine (guarded profile), the FREE scripted model, a hand-moved clock and PGlite. No paid call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { conversations, leadEvents, messages, rateLimits, sellerAccounts, users, voiceSessions, type ContactHours, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { createSimulatedBuyer } = await import("@/lib/simulator/service");
const { ensureChatStarted, ensureWrittenOpener } = await import("@/lib/chat/start");
const { VoiceEngine, VOICE_HOLD_GREETING_MS } = await import("@/lib/voice/engine");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { micPcm, ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { closeStaleVoiceSessions, createVoiceSession, endUnstartedVoiceSession, startVoiceTestConversation } = await import("@/lib/voice/service");
const { MemoryRecordingStore } = await import("@/lib/voice/recording");
const { recordingNoticeText, saveRecordingSettings, withRecordingNotice } = await import("@/lib/voice/recording-settings");
const { openerInstruction } = await import("@/lib/voice-classic/instructions");
const { GUARDED_PROFILE } = await import("@/lib/voice-guarded/profile");
type VoiceLimits = import("@/lib/voice/engine").VoiceLimits;
type RealtimeModel = import("@/lib/voice/realtime").RealtimeModel;
type WrittenOpenerFn = import("@/lib/voice/written-opener").WrittenOpenerFn;

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET = { standbyAfterQuietMs: 3_600_000 };
const HOLD: VoiceLimits = { waitForClientAudio: true, holdGreeting: true };
const ALWAYS: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const POSTED_YES = "written opener posted after the call: yes";
const POSTED_NO = "written opener posted after the call: no";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
  holder.db = db;
  [me] = await db.insert(users).values({ clerkId: "so", email: "so@p.test", firstName: "Owen", role: "user" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "so@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
  await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, acc);
  await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
  await db.update(sellerAccounts).set({ status: "live", allowSimulatedBuyers: true, contactHours: ALWAYS }).where(eq(sellerAccounts.id, acc));
  await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: true, recordingNotice: true, keepDays: 180 });
});
afterAll(async () => tdb.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const agentLines = (conversationId: string) => db.select().from(messages)
  .where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent"))).orderBy(asc(messages.createdAt));

let n = 0;
/**
 * A buyer conversation as the hand-over leaves it: `empty` (no message: "Talk now"), or with the written opener
 * ("Chat in writing", a later call). `topic`: what the lead asked about on the lead page. Returns the written opener
 * the chat posts for this lead (taken from the chat's own start, then removed for an empty one).
 */
async function buyerConversation(o: { empty: boolean; topic?: string }) {
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
  const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, { ...account, allowSimulatedBuyers: true }, { fullName: `Dana Buyer${++n}`, company: "Shop", language: "en", country: "IL" });
  if (!made.ok) throw new Error("buyer");
  if (o.topic) await db.insert(leadEvents).values({ accountId: acc, leadId: made.lead.id, type: "lead_page.submitted", actor: "system", data: { topic: o.topic } });
  const r = await ensureChatStarted(db, { accountId: acc, leadId: made.lead.id });
  if (!r.started) throw new Error(`chat not started: ${r.reason}`);
  const [written] = await agentLines(r.conversationId);
  if (o.empty) await db.delete(messages).where(eq(messages.conversationId, r.conversationId));
  return { conversationId: r.conversationId, leadId: made.lead.id, written: written.body };
}

/** A buyer call on the New engine. `model`: in place of the scripted one (a connect failure). */
async function call(conversationId: string, o: { limits?: VoiceLimits; model?: (scripted: InstanceType<typeof ScriptedRealtime>) => RealtimeModel; writtenOpener?: WrittenOpenerFn; isTest?: boolean } = {}) {
  const s = await createVoiceSession(db, { accountId: acc, conversationId, userId: o.isTest ? me.id : null, isTest: !!o.isTest }, { env: SCRIPTED });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock(Date.UTC(2026, 10, 26, 10, 0, 0));
  const scripted = new ScriptedRealtime({ clock, wordMs: 250 });
  const lines: string[] = [];
  const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l) };
  const sent: unknown[] = [];
  const engine = new VoiceEngine({
    db, model: o.model ? o.model(scripted) : scripted, sessionId: s.sessionId, send: (m) => void sent.push(m), clock, log,
    limits: { env: {}, ...QUIET, ...o.limits }, profile: GUARDED_PROFILE, recording: { store: new MemoryRecordingStore(), reason: "test store" },
    ...(o.writtenOpener ? { writtenOpener: o.writtenOpener } : {}),
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  await engine.start();
  await settle();
  const conn = () => scripted.connections.at(-1)!;
  const has = (l: string) => lines.filter((x) => x.endsWith(l)).length;
  return { ...s, engine, lines, run, settle, conn, has, sent };
}

/** The opener prompt the New engine asks for on a fresh conversation (recorded, first call: the line after the introduction). */
const spokenOpenerPrompt = (written: string) => withRecordingNotice(openerInstruction(written, "en"), recordingNoticeText("en"), { position: "opener", languageName: null });

describe("a call on an empty conversation speaks the opener (New engine)", () => {
  it("without holdGreeting: continuing=no, the first model turn is the chat's own opener with the recording line after the introduction; it is stored as the first message; nothing written after", async () => {
    const c0 = await buyerConversation({ empty: true });
    expect(await agentLines(c0.conversationId)).toHaveLength(0);
    const c = await call(c0.conversationId);
    expect(c.has("opener: spoken (fresh conversation)")).toBe(1);
    expect(c.lines.some((l) => /inherited: agentMessages=0 continuing=no /.test(l))).toBe(true);
    const prompt = c.conn().sent.responses[0]!;
    expect(c.conn().sent.responses).toHaveLength(1);
    expect(prompt).toBe(spokenOpenerPrompt(c0.written));
    // The introduction first, then the recording line, then the rest of the opener.
    const intro = c0.written.slice(0, c0.written.indexOf(".") + 1);
    expect(prompt.indexOf(intro)).toBeLessThan(prompt.indexOf(recordingNoticeText("en")));
    expect(prompt).toMatch(/Say your opening line now/);
    await c.run(30_000);
    await c.engine.stop("user_hangup");
    const stored = await agentLines(c0.conversationId);
    expect(stored).toHaveLength(1);
    expect(stored[0].voiceSessionId).toBe(c.sessionId);
    expect(stored[0].body).toContain(intro);
    expect(c.has(POSTED_NO)).toBe(1);
    expect(c.has(POSTED_YES)).toBe(0);
  });

  it("with holdGreeting (the hand-over): the same opener at the page's release; a pick-up line never", async () => {
    const c0 = await buyerConversation({ empty: true });
    const c = await call(c0.conversationId, { limits: HOLD });
    await c.run(4_000);
    expect(c.conn().sent.responses).toHaveLength(0);
    c.engine.onClientMessage({ t: "ready" });
    await c.settle();
    expect(c.has("opener: spoken (fresh conversation)")).toBe(1);
    expect(c.conn().sent.responses).toEqual([spokenOpenerPrompt(c0.written)]);
    await c.run(30_000);
    await c.engine.stop("user_hangup");
    expect(await agentLines(c0.conversationId)).toHaveLength(1);
    expect(c.has(POSTED_NO)).toBe(1);
  });

  it("the spoken opener is the chat's word for word when the lead asked about something on the lead page", async () => {
    const c0 = await buyerConversation({ empty: true, topic: "Kitchen sensors" });
    expect(c0.written).toMatch(/Kitchen sensors/i);
    const c = await call(c0.conversationId);
    expect(c.conn().sent.responses[0]).toBe(spokenOpenerPrompt(c0.written));
    await c.engine.stop("user_hangup");
  });

  it("a conversation that already has the written opener (a real continuation) gets the pick-up line, unchanged; nothing written after", async () => {
    const c0 = await buyerConversation({ empty: false });
    const fn = vi.fn<WrittenOpenerFn>(async () => ({ posted: false }));
    const c = await call(c0.conversationId, { writtenOpener: fn });
    expect(c.has("opener: pick-up (continuing)")).toBe(1);
    expect(c.has("opener: spoken (fresh conversation)")).toBe(0);
    expect(c.lines.some((l) => /continuing=yes/.test(l))).toBe(true);
    const prompt = c.conn().sent.responses[0]!;
    expect(prompt).not.toMatch(/Say your opening line now/);
    expect(prompt).not.toContain(c0.written);
    await c.run(30_000);
    await c.engine.stop("user_hangup");
    expect(fn).not.toHaveBeenCalled();
    expect(c.has(POSTED_NO)).toBe(1);
  });
});

describe("the written opener after a call that said nothing", () => {
  it("hang-up before the first word (held greeting, buyer gone): the written opener is posted, once, after the row ended", async () => {
    const c0 = await buyerConversation({ empty: true });
    let liveWhenCalled: string | null = null;
    let endedSentBefore: boolean | null = null;
    let sentRef: unknown[] = [];
    const fn: WrittenOpenerFn = async (d, a, conv) => {
      liveWhenCalled = (await db.select({ status: voiceSessions.status }).from(voiceSessions).where(eq(voiceSessions.conversationId, conv)))[0]?.status ?? null;
      endedSentBefore = sentRef.some((m) => (m as { t?: string }).t === "ended");
      return ensureWrittenOpener(d, a, conv);
    };
    const c = await call(c0.conversationId, { limits: HOLD, writtenOpener: fn });
    sentRef = c.sent;
    await c.run(2_000);
    await c.engine.onClientGone({ code: 1001, reason: "gone" });
    await c.settle();
    expect(liveWhenCalled).toBe("ended");
    const stored = await agentLines(c0.conversationId);
    expect(stored).toHaveLength(1);
    expect(stored[0].body).toBe(c0.written);
    expect(stored[0].voiceSessionId).toBeNull();
    expect(c.has(POSTED_YES)).toBe(1);
    // Before `ended` goes to the browser (the chat it shows next has the opener).
    expect(endedSentBefore).toBe(false);
    expect(c.sent.some((m) => (m as { t?: string }).t === "ended")).toBe(true);
  });

  it("not started after the 15 s hold: the written opener is posted", async () => {
    const c0 = await buyerConversation({ empty: true });
    const c = await call(c0.conversationId, { limits: HOLD });
    await c.run(VOICE_HOLD_GREETING_MS + 200);
    await c.engine.idle();
    expect((await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.sessionId)))[0].endReason).toBe("not_started");
    expect((await agentLines(c0.conversationId)).map((m) => m.body)).toEqual([c0.written]);
    expect(c.has(POSTED_YES)).toBe(1);
  });

  it("model connect failure (refused): the written opener is posted", async () => {
    const c0 = await buyerConversation({ empty: true });
    const c = await call(c0.conversationId, { model: (s) => ({ modelId: s.modelId, mode: "scripted", connect: async () => { throw new Error("refused"); } }) });
    await c.settle();
    expect(c.engine.isEnded).toBe(true);
    expect((await db.select().from(voiceSessions).where(eq(voiceSessions.id, c.sessionId)))[0].errorCode).toBe("model_unavailable");
    expect((await agentLines(c0.conversationId)).map((m) => m.body)).toEqual([c0.written]);
    expect(c.has(POSTED_YES)).toBe(1);
  });

  it("an error stop before the first word: the written opener is posted", async () => {
    const c0 = await buyerConversation({ empty: true });
    const c = await call(c0.conversationId, { limits: HOLD });
    await c.engine.stop("error", "internal");
    expect((await agentLines(c0.conversationId)).map((m) => m.body)).toEqual([c0.written]);
    expect(c.has(POSTED_YES)).toBe(1);
  });

  it("the buyer cut into the opener (hung up mid-line): the cut line is stored, nothing is posted", async () => {
    const c0 = await buyerConversation({ empty: true });
    const c = await call(c0.conversationId);
    await c.run(1_200);
    await c.engine.stop("user_hangup");
    const stored = await agentLines(c0.conversationId);
    expect(stored).toHaveLength(1);
    expect(stored[0].voiceSessionId).toBe(c.sessionId);
    expect(stored[0].body).not.toBe(c0.written);
    expect(c.has(POSTED_NO)).toBe(1);
  });

  it("the buyer talked over the opener (barge-in): the cut line is stored, nothing is posted at the end", async () => {
    const c0 = await buyerConversation({ empty: true });
    const c = await call(c0.conversationId);
    await c.run(1_000);
    for (let x = 0; x < 1_000; x += 100) { c.engine.onClientAudio(micPcm(100, true)); await c.run(100); }
    for (let x = 0; x < 800; x += 100) { c.engine.onClientAudio(micPcm(100, false)); await c.run(100); }
    await c.engine.stop("user_hangup");
    const stored = await agentLines(c0.conversationId);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored.every((m) => m.voiceSessionId === c.sessionId)).toBe(true);
    expect(c.has(POSTED_NO)).toBe(1);
  });

  it("a test-lab call is left alone: nothing posted, the function not called", async () => {
    const lab = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
    const fn = vi.fn<WrittenOpenerFn>(async () => ({ posted: true }));
    const c = await call(lab.conversationId, { isTest: true, writtenOpener: fn, limits: HOLD });
    await c.engine.stop("user_hangup");
    expect(fn).not.toHaveBeenCalled();
    expect(c.has(POSTED_NO)).toBe(1);
  });

  it("a call that ended before its engine started (endUnstartedVoiceSession: socket-level failures): posted; a test call or an already-ended row: not", async () => {
    const c0 = await buyerConversation({ empty: true });
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c0.conversationId, userId: null, isTest: false }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const lines: string[] = [];
    const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l) };
    await endUnstartedVoiceSession(db, s.sessionId, "model_unavailable", new Date(), { log });
    expect((await agentLines(c0.conversationId)).map((m) => m.body)).toEqual([c0.written]);
    expect(lines.filter((l) => l.endsWith(POSTED_YES))).toHaveLength(1);
    // Again (the row is ended already): nothing more.
    const fn = vi.fn<WrittenOpenerFn>(async () => ({ posted: true }));
    await endUnstartedVoiceSession(db, s.sessionId, "connection_lost", new Date(), { log, writtenOpener: fn });
    expect(fn).not.toHaveBeenCalled();
    // A test-lab session: skipped.
    const lab = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
    const t = await createVoiceSession(db, { accountId: acc, conversationId: lab.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!t.ok) throw new Error(t.reason);
    await endUnstartedVoiceSession(db, t.sessionId, "model_unavailable", new Date(), { log, writtenOpener: fn });
    expect(fn).not.toHaveBeenCalled();
  });

  it("the stale close: a pending or live call that died before its first word gets the written opener; not on the conversation a new call is starting on; not for a continuation", async () => {
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    // Pending (the socket never redeemed its ticket).
    const p0 = await buyerConversation({ empty: true });
    const ps = await createVoiceSession(db, { accountId: acc, conversationId: p0.conversationId, userId: null, isTest: false }, { env: SCRIPTED });
    // Live with a stale heartbeat, nothing said.
    const l0 = await buyerConversation({ empty: true });
    const ls = await createVoiceSession(db, { accountId: acc, conversationId: l0.conversationId, userId: null, isTest: false }, { env: SCRIPTED });
    // A continuation (the written opener is there).
    const k0 = await buyerConversation({ empty: false });
    const ks = await createVoiceSession(db, { accountId: acc, conversationId: k0.conversationId, userId: null, isTest: false }, { env: SCRIPTED });
    if (!ps.ok || !ls.ok || !ks.ok) throw new Error("session");
    await db.update(voiceSessions).set({ status: "live", connectedAt: new Date(), durationSec: 0 }).where(eq(voiceSessions.id, ls.sessionId));
    const lines: string[] = [];
    const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l) };
    // A new call starting on p0's conversation: that one is left empty (the new call speaks the opener).
    expect(await closeStaleVoiceSessions(db, acc, later(10), { keepEmpty: p0.conversationId, log })).toBe(3);
    expect(await agentLines(p0.conversationId)).toHaveLength(0);
    expect((await agentLines(l0.conversationId)).map((m) => m.body)).toEqual([l0.written]);
    expect((await agentLines(k0.conversationId)).map((m) => m.body)).toEqual([k0.written]);
    expect(lines.filter((l) => l.endsWith(POSTED_YES))).toHaveLength(1);
    expect(lines.filter((l) => l.endsWith(POSTED_NO))).toHaveLength(1);
    // The cron (no conversation kept): a pending one on an empty conversation gets it.
    const q0 = await buyerConversation({ empty: true });
    const qs = await createVoiceSession(db, { accountId: acc, conversationId: q0.conversationId, userId: null, isTest: false }, { env: SCRIPTED });
    if (!qs.ok) throw new Error(qs.reason);
    await closeStaleVoiceSessions(db, null, later(20), { log });
    expect((await agentLines(q0.conversationId)).map((m) => m.body)).toEqual([q0.written]);
  });

  it("ensureWrittenOpener: idempotent, never on a closed conversation", async () => {
    const c0 = await buyerConversation({ empty: true });
    expect(await ensureWrittenOpener(db, acc, c0.conversationId)).toEqual({ posted: true });
    expect(await ensureWrittenOpener(db, acc, c0.conversationId)).toEqual({ posted: false });
    expect(await agentLines(c0.conversationId)).toHaveLength(1);
    const c1 = await buyerConversation({ empty: true });
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, c1.conversationId));
    expect(await ensureWrittenOpener(db, acc, c1.conversationId)).toEqual({ posted: false });
  });
});

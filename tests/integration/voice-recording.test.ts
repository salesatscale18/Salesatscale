/**
 * Call recordings end to end on PGlite with the FREE scripted model, a hand-moved clock and an in-memory store:
 * the row's recording state, chunks while the call runs, a function that dies mid-call (playable chunks, the stale
 * close), the spoken notice (once, in the call's language), the switches, and playback (other account 404,
 * signed-out, Range). No paid call, no Blob call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, rateLimits, sellerAccounts, users, voiceSessions, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as null | ((slug: string) => unknown) }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async (slug: string) => holder.access!(slug),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { scenarioById } = await import("@/lib/agent/scenarios");
const { VoiceEngine } = await import("@/lib/voice/engine");
const { flushAsync, ManualClock } = await import("@/lib/voice/realtime");
const { micPcm, ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { closeStaleVoiceSessions, createVoiceSession, startVoiceTestConversation } = await import("@/lib/voice/service");
const { MemoryRecordingStore, RECORDING_CHUNK_SEC, RECORDING_RATE } = await import("@/lib/voice/recording");
const { recordingResponse } = await import("@/lib/voice/recording-playback");
const { RECORDING_ASKED_REPLY, RECORDING_NOTICE, RECORDING_WRITING_OFFER, saveRecordingSettings } = await import("@/lib/voice/recording-settings");
const { expectBuyer, say } = await import("@/lib/voice/scripted-realtime");
const route = await import("@/app/app/[account]/calls/[sessionId]/recording/route");

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const CHUNK_BYTES = RECORDING_CHUNK_SEC * RECORDING_RATE * 4;

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;
let other: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  holder.db = db;
  [me] = await db.insert(users).values({ clerkId: "rec", email: "rec@p.test", firstName: "Rae", role: "user" }).returning();
  const mk = async (name: string, email: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: email });
    if (!p.ok) throw new Error();
    return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  };
  acc = await mk("Acme", "rec-acme@x.test");
  await seedCatalog(db, acc, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
  await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  other = await mk("Other", "rec-other@x.test");
});
afterAll(async () => t.close());
beforeEach(async () => {
  await db.delete(rateLimits);
  await db.update(sellerAccounts).set({ voiceSettings: null }).where(eq(sellerAccounts.id, acc));
});

async function newCall(o: { scenario?: string | null; store?: InstanceType<typeof MemoryRecordingStore> | null; conversationId?: string; script?: import("@/lib/voice/scripted-realtime").Script } = {}) {
  const scenario = o.scenario ?? null;
  const c = o.conversationId ? { conversationId: o.conversationId } : (await startVoiceTestConversation(db, acc, me.id, { scenario, language: scenarioById(scenario)?.language ?? "en" }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock, ...(o.script ? { defaultScript: o.script } : {}) });
  const store = o.store === undefined ? new MemoryRecordingStore() : o.store;
  const lines: string[] = [];
  const engine = new VoiceEngine({
    db, model, sessionId: s.sessionId, send: () => undefined, clock, limits: { env: {}, standbyAfterQuietMs: 600_000 },
    recording: { store, reason: store ? "test store" : "no store (test)" },
    log: { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) },
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  const speak = async (ms = 1_000) => {
    for (let x = 0; x < ms; x += 100) { engine.onClientAudio(micPcm(100, true)); await run(100); }
    for (let x = 0; x < 800; x += 100) { engine.onClientAudio(micPcm(100, false)); await run(100); }
  };
  await engine.start();
  await settle();
  return { ...s, conversationId: c.conversationId, engine, clock, model, store, run, speak, settle, lines };
}
const row = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];
const agentLines = async (conversationId: string, sessionId: string) => (await db.select().from(messages)
  .where(and(eq(messages.conversationId, conversationId), eq(messages.voiceSessionId, sessionId), eq(messages.actor, "agent"))).orderBy(asc(messages.createdAt))).map((m) => m.body);
const end = async (c: Awaited<ReturnType<typeof newCall>>) => {
  c.engine.onClientMessage({ t: "end" });
  await c.settle();
};

describe("recording a call", () => {
  it("on by default: chunks while the call runs, the row's progress at each heartbeat, saved at the end; one log line each way", async () => {
    const c = await newCall();
    expect(await row(c.sessionId)).toMatchObject({ recordingState: "recording", recordingNoticeSaid: true, recordingRef: `voice/development/${acc}/${c.sessionId}/` });
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    // 46 s in: the first 30 s chunk is stored, and the 40 s heartbeat put it on the row.
    expect((await c.store!.list(`voice/development/${acc}/${c.sessionId}/`)).map((x) => x.size)).toEqual([CHUNK_BYTES]);
    expect(await row(c.sessionId)).toMatchObject({ status: "live", recordingChunks: 1, recordingBytes: CHUNK_BYTES, recordingSec: 30 });
    await end(c);
    const r = await row(c.sessionId);
    expect(r.recordingState).toBe("saved");
    expect(r.recordingChunks).toBe(2);
    expect(r.recordingSec).toBe(r.durationSec);
    expect(c.lines.filter((l) => /recording (on|off|saved|failed)/.test(l))).toEqual([
      expect.stringMatching(/recording on: test store, kept 180 days, line said$/), expect.stringMatching(/recording saved: chunks=2 bytes=\d+ sec=\d+$/),
    ]);
    expect(c.lines.join("\n")).not.toContain("voice/");
  });

  it("the notice: right after the greeting and introduction of the agent's first line, once per call (not again after a reconnect)", async () => {
    const c = await newCall();
    await c.run(15_000);
    c.model.connections.at(-1)!.simulateGoAway();
    await c.run(15_000);
    await c.speak();
    await c.run(15_000);
    await end(c);
    const said = await agentLines(c.conversationId, c.sessionId);
    expect(said[0]).toMatch(new RegExp(`^Hi Test, this is [^.]+, the automated assistant of Acme\\. ${RECORDING_NOTICE.en.replace(/\./g, "\\.")} \\S`));
    expect(said.join(" ").split(RECORDING_NOTICE.en)).toHaveLength(2);
    expect(c.model.connections).toHaveLength(2);
  });

  it("the opening instruction carries the exact recording line and nothing else about recording (new call and pick-up)", async () => {
    const c = await newCall();
    const opener = c.model.connections[0].sent.responses[0]!;
    expect(opener).toContain(RECORDING_NOTICE.en);
    expect(opener).not.toContain("I don't control");
    expect(opener).not.toMatch(/recording notice|answer for when/);
    // The on-request answer is one rule inside the voice block, never a section at the end of the instructions.
    const instructions = c.model.connections[0].cfg.instructions;
    expect(instructions).not.toContain("### This call is recorded");
    expect(instructions.endsWith("Conversation language: en.")).toBe(true);
    expect(instructions.indexOf("If the buyer asks whether this call is recorded")).toBeLessThan(instructions.indexOf("### Deal-state fields"));
    expect(instructions.indexOf("If the buyer asks whether this call is recorded")).toBeGreaterThan(instructions.indexOf("### On a voice call (always)"));
    await c.run(15_000);
    await end(c);
    // A call that picks up a chat (no greeting): the exact line comes first, then the pick-up line; nothing else about recording.
    const chat = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: "en" }))!;
    await db.insert(messages).values({ accountId: acc, conversationId: chat.conversationId, actor: "agent", body: "Thanks. How many fridges do you need to cover?", language: "en" });
    const pick = await newCall({ conversationId: chat.conversationId });
    const prompt = pick.model.connections[0].sent.responses[0]!;
    expect(prompt).toContain(`"${RECORDING_NOTICE.en} So, how many fridges do you need to cover?"`);
    expect(prompt).not.toContain("I don't control");
    await pick.run(15_000);
    await end(pick);
    expect((await agentLines(chat.conversationId, pick.sessionId))[0]).toBe(`${RECORDING_NOTICE.en} So, how many fridges do you need to cover?`);
  });

  it("a Hebrew call says the Hebrew notice", async () => {
    const c = await newCall({ scenario: "hebrew_buyer" });
    await c.run(15_000);
    await end(c);
    const said = await agentLines(c.conversationId, c.sessionId);
    // After the Hebrew greeting and introduction, before the first question.
    expect(said[0]).toContain(` ${RECORDING_NOTICE.he} `);
    expect(said[0].indexOf(RECORDING_NOTICE.he)).toBeGreaterThan(0);
    expect(said[0]).not.toContain(RECORDING_NOTICE.en);
  });

  it("switches: recording off (no notice, nothing stored); notice off (recorded, no notice); no store (off)", async () => {
    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: false, recordingNotice: true, keepDays: 180 });
    const off = await newCall();
    await off.run(15_000);
    await end(off);
    expect(await row(off.sessionId)).toMatchObject({ recordingState: "off", recordingNoticeSaid: false, recordingRef: null });
    expect(off.store!.files.size).toBe(0);
    expect((await agentLines(off.conversationId, off.sessionId))[0]).not.toContain(RECORDING_NOTICE.en);
    expect(off.lines.some((l) => l.endsWith("recording off: turned off in Settings › Voice"))).toBe(true);

    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: true, recordingNotice: false, keepDays: 180 });
    const quiet = await newCall();
    await quiet.run(15_000);
    await end(quiet);
    expect(await row(quiet.sessionId)).toMatchObject({ recordingState: "saved", recordingNoticeSaid: false });
    expect((await agentLines(quiet.conversationId, quiet.sessionId))[0]).not.toContain(RECORDING_NOTICE.en);

    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: true, recordingNotice: true, keepDays: 180 });
    const none = await newCall({ store: null });
    await none.run(15_000);
    await end(none);
    expect(await row(none.sessionId)).toMatchObject({ recordingState: "off", recordingNoticeSaid: false });
    expect((await agentLines(none.conversationId, none.sessionId))[0]).not.toContain(RECORDING_NOTICE.en);
  });

  it("a function that dies mid-call: its chunks play back; the stale close marks the recording saved", async () => {
    const c = await newCall();
    await c.run(15_000);
    await c.speak();
    await c.run(50_000);
    // The function is gone: nothing more runs. Two chunks were written; the row's count (the last heartbeat, at
    // 60 s, while the second was being written) says 1. Playback lists the store, so both play.
    const live = await row(c.sessionId);
    expect(live).toMatchObject({ status: "live", recordingState: "recording", recordingChunks: 1 });
    expect(await c.store!.list(live.recordingRef!)).toHaveLength(2);
    const res = await recordingResponse(db, acc, c.sessionId, null, { store: c.store });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(44 + 2 * CHUNK_BYTES);
    expect(await closeStaleVoiceSessions(db, acc, new Date(live.connectedAt!.getTime() + live.durationSec! * 1000 + 100_000))).toBeGreaterThanOrEqual(1);
    expect(await row(c.sessionId)).toMatchObject({ status: "ended", recordingState: "saved" });
  });
});

describe("playing a recording back (seller side)", () => {
  const access = (slug: string) => {
    if (slug === "signed-out") throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" });
    if (slug !== "acme") throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    return { account: { id: acc, slug: "acme" }, user: { id: me.id }, actingAs: false };
  };
  const get = (slug: string, sessionId: string, range?: string) =>
    route.GET(new Request(`http://x/app/${slug}/calls/${sessionId}/recording`, { headers: range ? { range } : {} }) as never, { params: Promise.resolve({ account: slug, sessionId }) });

  it("the route: this account's call as a WAV with Range; another account's call, a call with no recording or a bad id is 404; signed out redirects", async () => {
    holder.access = access;
    const c = await newCall();
    await c.run(15_000);
    await end(c);
    // The scripted call recorded to the process's in-memory store? No: this test injected its own. Copy it there.
    const { memoryRecordingStore } = await import("@/lib/voice/recording");
    for (const [p, b] of c.store!.files) await memoryRecordingStore().put(p, b);
    const whole = await get("acme", c.sessionId);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/wav");
    expect(whole.headers.get("cache-control")).toBe("private, no-store");
    const size = Number(whole.headers.get("content-length"));
    expect(size).toBe(44 + (await row(c.sessionId)).recordingBytes!);
    const part = await get("acme", c.sessionId, "bytes=0-99");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-99/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    // Another account's call: the session exists, but not for this account.
    await db.update(voiceSessions).set({ accountId: other }).where(eq(voiceSessions.id, c.sessionId));
    expect((await get("acme", c.sessionId)).status).toBe(404);
    await db.update(voiceSessions).set({ accountId: acc }).where(eq(voiceSessions.id, c.sessionId));
    // Someone without access to the account: requireAccount's 404 (thrown, as notFound()).
    await expect(get("other-co", c.sessionId)).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    await expect(get("signed-out", c.sessionId)).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect((await get("acme", "not-a-uuid")).status).toBe(404);
    const offCall = await newCall({ store: null });
    await end(offCall);
    expect((await get("acme", offCall.sessionId)).status).toBe(404);
  });
});

describe("the buyer raises the recording", () => {
  /** The buyer asks; the scripted agent answers with what its instructions give for it (or asks again when nothing). */
  const ASKS = [
    expectBuyer("Are you recording this?"), say((ctx) => ctx.recordingReply ?? "Sorry, could you say that again?"),
    expectBuyer("I don't want to be recorded."), say((ctx) => ctx.recordingWritingOffer ?? "Sorry, could you say that again?"),
    expectBuyer("Okay, go on."), say("Great. How many sites do you have?"),
  ];

  it("a recorded call: the instruction is there; asked → the line; objects → the writing offer once; the recording goes on", async () => {
    const c = await newCall({ script: ASKS });
    const instructions = c.model.connections[0].cfg.instructions;
    expect(instructions).toContain(`- If the buyer asks whether this call is recorded, say: "${RECORDING_ASKED_REPLY.en}"`);
    expect(instructions).toContain(RECORDING_ASKED_REPLY.he);
    expect(instructions).toContain(`If they object, offer once: "${RECORDING_WRITING_OFFER.en}"`);
    expect(instructions).toContain(RECORDING_WRITING_OFFER.he);
    expect(instructions).toContain("Otherwise never mention recording.");
    // One line, once.
    expect(instructions.split(RECORDING_ASKED_REPLY.en)).toHaveLength(2);
    await c.run(15_000);
    await c.speak();
    await c.run(10_000);
    expect((await agentLines(c.conversationId, c.sessionId)).at(-1)).toBe(RECORDING_ASKED_REPLY.en);
    await c.speak();
    await c.run(10_000);
    expect((await agentLines(c.conversationId, c.sessionId)).at(-1)).toBe(RECORDING_WRITING_OFFER.en);
    await c.speak();
    await c.run(10_000);
    const said = await agentLines(c.conversationId, c.sessionId);
    expect(said.filter((l) => l === RECORDING_WRITING_OFFER.en)).toHaveLength(1);
    expect(said.at(-1)).toBe("Great. How many sites do you have?");
    // Recording never stops on request: still recording, then saved with the whole call.
    expect(await row(c.sessionId)).toMatchObject({ status: "live", recordingState: "recording" });
    await c.run(10_000);
    await end(c);
    const r = await row(c.sessionId);
    expect(r.recordingState).toBe("saved");
    expect(r.recordingSec).toBe(r.durationSec);
  });

  it("a call that is not recorded (switched off, or no store): no instruction, and the agent never says it is recorded", async () => {
    const none = await newCall({ script: ASKS, store: null });
    expect(none.model.connections[0].cfg.instructions).not.toContain("whether this call is recorded");
    expect(none.model.connections[0].cfg.instructions).not.toContain(RECORDING_ASKED_REPLY.en);
    expect(none.model.connections[0].cfg.instructions).not.toContain(RECORDING_WRITING_OFFER.en);
    await none.run(15_000);
    await none.speak();
    await none.run(10_000);
    await end(none);
    expect((await agentLines(none.conversationId, none.sessionId)).join(" ")).not.toContain("recorded");
    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: false, recordingNotice: true, keepDays: 180 });
    const off = await newCall({ script: ASKS });
    expect(off.model.connections[0].cfg.instructions).not.toContain("whether this call is recorded");
    await end(off);
  });

  it("the instruction is on every connection of a recorded call (a reconnect keeps it)", async () => {
    const c = await newCall();
    await c.run(15_000);
    c.model.connections.at(-1)!.simulateGoAway();
    await c.run(5_000);
    expect(c.model.connections).toHaveLength(2);
    expect(c.model.connections[1].cfg.instructions).toContain("- If the buyer asks whether this call is recorded");
    await end(c);
  });
});

describe("once per conversation, keep period, delete, download, expiry", () => {
  it("the line is said on a conversation's first recorded call only; a new conversation says it again", async () => {
    const first = await newCall();
    await first.run(15_000);
    await end(first);
    const second = await newCall({ conversationId: first.conversationId });
    await second.run(15_000);
    await end(second);
    expect(await row(first.sessionId)).toMatchObject({ recordingNoticeSaid: true });
    expect(await row(second.sessionId)).toMatchObject({ recordingState: "saved", recordingNoticeSaid: false });
    const said = await agentLines(first.conversationId, second.sessionId);
    expect(said.join(" ")).not.toContain(RECORDING_NOTICE.en);
    expect(second.lines.some((l) => l.endsWith("line said on an earlier call"))).toBe(true);
    const fresh = await newCall();
    await fresh.run(15_000);
    await end(fresh);
    expect(await row(fresh.sessionId)).toMatchObject({ recordingNoticeSaid: true });
  });

  it("until deleted: no expiry on upload, never expired by the cron", async () => {
    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: true, recordingNotice: true, keepDays: 0 });
    const store = new MemoryRecordingStore();
    const opts: unknown[] = [];
    const put = store.put.bind(store);
    store.put = async (p: string, b: Uint8Array, o?: { ttlDays?: number }) => { opts.push(o); await put(p, b, o); };
    const c = await newCall({ store });
    await c.run(15_000);
    await end(c);
    expect(opts).toEqual([{}]);
    const r = await row(c.sessionId);
    expect(r).toMatchObject({ recordingState: "saved", recordingKeepDays: 0 });
    const { expireRecordings } = await import("@/lib/voice/recording-playback");
    await expireRecordings(db, new Date(r.endedAt!.getTime() + 5 * 365 * 86_400_000));
    expect((await row(c.sessionId)).recordingState).toBe("saved");
  });

  it("the account's keep period goes to the store and the row; the cron marks expired recordings deleted", async () => {
    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: true, recordingNotice: true, keepDays: 30 });
    const store = new MemoryRecordingStore();
    const ttls: (number | undefined)[] = [];
    const put = store.put.bind(store);
    store.put = async (p: string, b: Uint8Array, o?: { ttlDays?: number }) => { ttls.push(o?.ttlDays); await put(p, b, o); };
    const c = await newCall({ store });
    await c.run(15_000);
    await end(c);
    expect(ttls).toEqual([30]);
    const r = await row(c.sessionId);
    expect(r).toMatchObject({ recordingState: "saved", recordingKeepDays: 30 });
    const { expireRecordings } = await import("@/lib/voice/recording-playback");
    expect(await expireRecordings(db, new Date(r.endedAt!.getTime() + 29 * 86_400_000))).toBe(0);
    expect(store.files.size).toBeGreaterThan(0);
    expect(await expireRecordings(db, new Date(r.endedAt!.getTime() + 31 * 86_400_000), { store })).toBeGreaterThanOrEqual(1);
    // Blob has no expiry of its own: the cron deleted the audio.
    expect(store.files.size).toBe(0);
    expect(await row(c.sessionId)).toMatchObject({ recordingState: "deleted", recordingKeepDays: 30 });
  });

  it("delete: the audio goes, the row says deleted, the lines stay, audited; download is an attachment; a store that lost the chunks marks it deleted", async () => {
    const { deleteRecording } = await import("@/lib/voice/recording-playback");
    const c = await newCall();
    await c.run(15_000);
    await end(c);
    const dl = await recordingResponse(db, acc, c.sessionId, null, { store: c.store, download: true });
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="call-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.wav"$/);
    const admin = { role: "seller_admin", actor: { userId: me.id, actingAs: false } };
    // A role that is not an account admin: forbidden, nothing deleted.
    expect(await deleteRecording(db, { role: "seller_member", actor: { userId: me.id, actingAs: false } }, acc, c.sessionId, { store: c.store })).toBe("forbidden");
    expect(c.store!.files.size).toBeGreaterThan(0);
    expect(await deleteRecording(db, admin, other, c.sessionId, { store: c.store })).toBe("not_found");
    expect(await deleteRecording(db, admin, acc, c.sessionId, { store: c.store })).toBe("deleted");
    expect(c.store!.files.size).toBe(0);
    // Deleted by someone (not the keep period): no "kept N days".
    expect(await row(c.sessionId)).toMatchObject({ recordingState: "deleted", recordingChunks: 0, recordingKeepDays: null });
    expect((await agentLines(c.conversationId, c.sessionId)).length).toBeGreaterThan(0);
    expect((await recordingResponse(db, acc, c.sessionId, null, { store: c.store })).status).toBe(404);
    const { auditLog } = await import("@/db/schema");
    expect(await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc), eq(auditLog.action, "voice.recording_deleted")))).toHaveLength(1);
    // The lead's timeline: "Recording deleted by Rae".
    const { leadEvents, conversations } = await import("@/db/schema");
    const [cv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, cv.leadId), eq(leadEvents.type, "voice.recording_deleted")));
    expect(ev).toMatchObject({ actor: "human", actorUserId: me.id, data: { voiceSessionId: c.sessionId, by: "Rae" } });
    const { leadEventIcon, leadEventTitle } = await import("@/lib/leads/event-icons");
    const { t: tr } = await import("@/lib/i18n");
    expect(leadEventTitle(ev.type, ev.data, tr)).toBe("Recording deleted by Rae");
    expect(leadEventIcon(ev.type, { data: ev.data })).toBe("trash");
    // The store's keep period ran out before the cron saw it: playback finds no chunks and marks the row.
    const d = await newCall();
    await d.run(15_000);
    await end(d);
    await d.store!.deleteAll(`voice/development/${acc}/${d.sessionId}/`);
    expect((await recordingResponse(db, acc, d.sessionId, null, { store: d.store })).status).toBe(404);
    expect(await row(d.sessionId)).toMatchObject({ recordingState: "deleted" });
  });
});

describe("the call block in the seller's thread (board RecThread)", () => {
  it("recorded: header, Recorded pill, player and lines with play-from-here; not recorded and deleted: header and lines, no player", async () => {
    const { voiceMarkers } = await import("@/lib/agent/thread-markers");
    const { CallBlockEntry, isCallBlock } = await import("@/app/app/[account]/leads/[leadId]/call-block-entry");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const at = new Date("2026-11-22T10:42:00Z");
    const base = { connectedAt: at, endedAt: new Date(at.getTime() + 228_000), status: "ended", durationSec: 228, buyerTurns: 2, model: "openai/gpt-realtime-2.1" };
    const sid = "11111111-1111-1111-1111-111111111111";
    const lines = [
      { id: "l1", actor: "agent", body: "Hi Dana, it's Maya again. Shall we go over the quote?", spokenAtMs: 2_000, typedInCall: false },
      { id: "l2", actor: "buyer", body: "Yes. Does the price include installation?", spokenAtMs: 9_000, typedInCall: false },
      { id: "l3", actor: "buyer", body: "Send me the order form", spokenAtMs: 111_000, typedInCall: true },
    ];
    const render = (state: string | null, keepDays: number | null = 90, canDelete = true) => {
      const markers = voiceMarkers([{ ...base, id: sid, recordingState: state, recordingSec: 228, recordingKeepDays: keepDays }]);
      const mk = markers.find((m) => m.kind === "voice_ended")!;
      expect(markers).toHaveLength(isCallBlock(mk) ? 1 : 2);
      if (!isCallBlock(mk)) return null;
      const cards = [{ id: "card-q", at: new Date(at.getTime() + 12_000), node: createElement("div", { className: "qcard" }, "Quote Q-1003") }];
      return renderToStaticMarkup(createElement(CallBlockEntry, { marker: mk, lines, cards, slug: "acme", back: "/app/acme/leads/x", buyer: "Dana Demo", zone: "Asia/Jerusalem", canDelete }));
    };
    const saved = render("saved")!;
    expect(saved).toContain("Voice call · 3 min 48 s");
    expect(saved).toContain('data-call-recorded="">');
    expect(saved).toContain(">Recorded<");
    expect(saved).toContain("GPT-Realtime 2.1");
    expect(saved).toContain(`src="/app/acme/calls/${sid}/recording"`);
    expect(saved).toContain(`href="/app/acme/calls/${sid}/recording?download=1"`);
    expect(saved).toMatch(/type="range"[^>]*aria-label="Position"[^>]*aria-valuetext="0 seconds of 3 minutes 48 seconds"/);
    expect(saved).toContain('aria-label="Play"');
    expect(saved).toContain("Copy transcript");
    expect(saved).toContain("Delete recording…");
    // A card posted during the call sits at its time: after the 0:09 line, before the 1:51 one.
    expect(saved.indexOf("Does the price include installation?")).toBeLessThan(saved.indexOf("Quote Q-1003"));
    expect(saved.indexOf("Quote Q-1003")).toBeLessThan(saved.indexOf("Send me the order form"));
    // Not an account admin: no delete item (the action refuses it too).
    const member = render("saved", 90, false)!;
    expect(member).not.toContain("Delete recording…");
    expect(member).toContain("Copy transcript");
    // Play from here on spoken lines only; the typed line keeps its keyboard mark.
    expect(saved.match(/aria-label="Play from here [0-9:]+"/g)).toEqual(['aria-label="Play from here 0:02"', 'aria-label="Play from here 0:09"']);
    expect(saved).toContain('aria-label="Typed during the call"');
    // A tick per spoken turn: agent violet, buyer grey.
    expect(saved.match(/sas-callblock__tick--(agent|buyer)/g)).toEqual(["sas-callblock__tick--agent", "sas-callblock__tick--buyer"]);
    const off = render("off")!;
    expect(off).toContain("Not recorded");
    expect(off).not.toContain("<audio");
    expect(off).toContain("Hi Dana, it&#x27;s Maya again");
    const gone = render("deleted", 90)!;
    expect(gone).toContain("Recording deleted · kept 90 days");
    expect(gone).toContain("The lines stay; only the audio is gone.");
    expect(gone).not.toContain("<audio");
    // A call from before recordings: no block, the old start and summary rows.
    expect(render(null)).toBeNull();
    const dir = process.env.VOICE_RENDER_DIR;
    if (dir) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
      fs.mkdirSync(dir, { recursive: true });
      const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} body{margin:0}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:flex;flex-direction:column;gap:16px;padding:24px;max-width:760px">${body}</div></div></body></html>`;
      fs.writeFileSync(path.join(dir, "thread-call-block.html"), page([saved, off, gone].join("")));
    }
  });
});

describe("the call block keeps what the thread showed (lead page and Conversations)", () => {
  it("each agent line keeps its step chips, and a card posted during the call sits at its place in the block", async () => {
    const { conversationView } = await import("@/lib/agent/conversation");
    const { ConversationPanel } = await import("@/app/app/[account]/leads/[leadId]/conversation");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { tool } = await import("@/lib/voice/scripted-realtime");
    const c = await newCall({ script: [
      expectBuyer("Can someone from your team call me about pricing?"),
      say("One moment."),
      tool("update_deal_state", { updates: [], next_step: "call", objection: null, recommendation_confirmed: null, price_asked: true, asked: null }),
      tool("request_callback", { brief: "Pricing for the buyer's sites" }),
      say((ctx) => (ctx.last("request_callback")?.ok === true ? "Done: I've put a link in the chat where you can pick a time." : "Sorry.")),
    ] });
    await c.run(15_000);
    await c.speak();
    await c.run(20_000);
    await end(c);
    const { conversations, users: usersT } = await import("@/db/schema");
    const [cv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    const view = await conversationView(db, acc, cv);
    const [u] = await db.select().from(usersT).where(eq(usersT.id, me.id));
    const html = renderToStaticMarkup(createElement(ConversationPanel, {
      slug: "acme", view, me: u, buyerName: "Test buyer", leadOptedOut: false, canDeleteRecordings: true, timezone: "Asia/Jerusalem",
    }));
    const block = html.slice(html.indexOf('data-call-block="saved"'));
    // The agent's steps under its line, inside the block (the same chips as the thread).
    expect(block).toContain("sas-callblock__steps");
    expect(block.match(/class="sas-msg__trace"/g)?.length).toBeGreaterThan(0);
    // The booking card posted during the call is in the block (placed by its time in the call: the test's call clock is
    // a hand-moved one, so its order against the lines is checked with explicit times in the block test above).
    expect(block.indexOf("data-call-card=")).toBeGreaterThan(0);
    expect(block).toContain("One moment.");
    // Nothing of the call is left outside the block (no lines, no card twice).
    const outside = html.slice(0, html.indexOf('data-call-block="saved"'));
    expect(outside).not.toContain("One moment.");
    expect(block).toContain("Delete recording…");
    const member = renderToStaticMarkup(createElement(ConversationPanel, { slug: "acme", view, me: u, buyerName: "Test buyer", leadOptedOut: false, timezone: "Asia/Jerusalem" }));
    expect(member).not.toContain("Delete recording…");
  });

  it("a ready buyer's call on the lead page: the quote card, the order form and the steps all inside the block", async () => {
    const { conversationView } = await import("@/lib/agent/conversation");
    const { ConversationPanel } = await import("@/app/app/[account]/leads/[leadId]/conversation");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const c = await newCall({ scenario: "ready_buyer" });
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await c.speak();
    await c.run(30_000);
    await end(c);
    const { conversations, users: usersT } = await import("@/db/schema");
    const [cv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    const view = await conversationView(db, acc, cv);
    const [u] = await db.select().from(usersT).where(eq(usersT.id, me.id));
    const html = renderToStaticMarkup(createElement(ConversationPanel, { slug: "acme", view, me: u, buyerName: "Test buyer", leadOptedOut: false, canDeleteRecordings: true, timezone: "Asia/Jerusalem" }));
    const block = html.slice(html.indexOf('data-call-block="saved"'));
    expect(block).toMatch(/Quote Q-\d+/);
    expect(block).toContain("sas-callblock__steps");
    expect(html.slice(0, html.indexOf('data-call-block="saved"'))).not.toMatch(/Quote Q-\d+/);
    const dir = process.env.VOICE_RENDER_DIR;
    if (dir) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "lead-call-block.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} body{margin:0}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block;max-width:760px">${html}</div></div></body></html>`);
    }
  });
});

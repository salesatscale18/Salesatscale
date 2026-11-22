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
const { RECORDING_NOTICE, saveRecordingSettings } = await import("@/lib/voice/recording-settings");
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
  other = await mk("Other", "rec-other@x.test");
});
afterAll(async () => t.close());
beforeEach(async () => {
  await db.delete(rateLimits);
  await db.update(sellerAccounts).set({ voiceSettings: null }).where(eq(sellerAccounts.id, acc));
});

async function newCall(o: { scenario?: string | null; store?: InstanceType<typeof MemoryRecordingStore> | null } = {}) {
  const scenario = o.scenario ?? null;
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario, language: scenarioById(scenario)?.language ?? "en" }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock();
  const model = new ScriptedRealtime({ clock });
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
      expect.stringMatching(/recording on: test store, notice said$/), expect.stringMatching(/recording saved: chunks=2 bytes=\d+ sec=\d+$/),
    ]);
    expect(c.lines.join("\n")).not.toContain("voice/");
  });

  it("the notice: the first sentence of the agent's first line, once per call (not again after a reconnect)", async () => {
    const c = await newCall();
    await c.run(15_000);
    c.model.connections.at(-1)!.simulateGoAway();
    await c.run(15_000);
    await c.speak();
    await c.run(15_000);
    await end(c);
    const said = await agentLines(c.conversationId, c.sessionId);
    expect(said[0].startsWith(`${RECORDING_NOTICE.en} Hi Test, this is `)).toBe(true);
    expect(said.join(" ").split(RECORDING_NOTICE.en)).toHaveLength(2);
    expect(c.model.connections).toHaveLength(2);
  });

  it("a Hebrew call says the Hebrew notice", async () => {
    const c = await newCall({ scenario: "hebrew_buyer" });
    await c.run(15_000);
    await end(c);
    const said = await agentLines(c.conversationId, c.sessionId);
    expect(said[0].startsWith(RECORDING_NOTICE.he)).toBe(true);
    expect(said[0]).not.toContain(RECORDING_NOTICE.en);
  });

  it("switches: recording off (no notice, nothing stored); notice off (recorded, no notice); no store (off)", async () => {
    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: false, recordingNotice: true });
    const off = await newCall();
    await off.run(15_000);
    await end(off);
    expect(await row(off.sessionId)).toMatchObject({ recordingState: "off", recordingNoticeSaid: false, recordingRef: null });
    expect(off.store!.files.size).toBe(0);
    expect((await agentLines(off.conversationId, off.sessionId))[0]).not.toContain(RECORDING_NOTICE.en);
    expect(off.lines.some((l) => l.endsWith("recording off: turned off in Settings › Voice"))).toBe(true);

    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: true, recordingNotice: false });
    const quiet = await newCall();
    await quiet.run(15_000);
    await end(quiet);
    expect(await row(quiet.sessionId)).toMatchObject({ recordingState: "saved", recordingNoticeSaid: false });
    expect((await agentLines(quiet.conversationId, quiet.sessionId))[0]).not.toContain(RECORDING_NOTICE.en);

    await saveRecordingSettings(db, { userId: me.id, actingAs: false }, acc, { recordCalls: true, recordingNotice: true });
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

describe("the player in the seller's thread", () => {
  it("a saved recording plays under the call's summary row; none for a call without one, or on the buyer side", async () => {
    const { voiceMarkers } = await import("@/lib/agent/thread-markers");
    const { MarkerEntry } = await import("@/app/app/[account]/leads/[leadId]/conversation");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const at = new Date("2026-11-22T10:00:00Z");
    const base = { connectedAt: at, endedAt: new Date(at.getTime() + 95_000), status: "ended", durationSec: 95, buyerTurns: 2 };
    const [, saved] = voiceMarkers([{ ...base, id: "11111111-1111-1111-1111-111111111111", recordingState: "saved", recordingSec: 95 }]);
    expect(saved).toMatchObject({ kind: "voice_ended", recording: { sessionId: "11111111-1111-1111-1111-111111111111", sec: 95 } });
    const html = renderToStaticMarkup(createElement(MarkerEntry, { marker: saved, meId: null, time: "10:01", timeTitle: "", recordingBase: "/app/acme/calls" }));
    expect(html).toContain('<audio controls="" preload="none" src="/app/acme/calls/11111111-1111-1111-1111-111111111111/recording"');
    expect(html).toContain("Recording · 1:35");
    for (const state of ["off", "failed", "recording", null]) {
      expect(voiceMarkers([{ ...base, id: "x", recordingState: state, recordingSec: 95 }])[1]).not.toHaveProperty("recording");
    }
    // Without the seller's route base (the buyer's thread) there is no player.
    expect(renderToStaticMarkup(createElement(MarkerEntry, { marker: saved, meId: null, time: "10:01", timeTitle: "" }))).not.toContain("<audio");
  });
});

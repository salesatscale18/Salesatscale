/**
 * "Protect the opening line" (Voice settings › Conversation › More options; test calls only for now:
 * OPENER_PROTECTION_FOR_BUYER_CALLS off), end to end on PGlite with the FREE scripted realtime model and a hand-moved
 * clock: from the call's start until the opener's audio has played (or 20 s), the buyer's microphone audio is not sent
 * to the model and nothing counts as a barge-in; then everything is as before. Off (the version's switch, or a buyer
 * call): the call behaves exactly as before. The text-output path (ElevenLabs speaks) too. No paid call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentVersions, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { VoiceEngine } from "@/lib/voice/engine";
import { VOICE_SAMPLE_RATE, type ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock } from "@/lib/voice/realtime";
import { expectBuyer, micPcm, say, ScriptedRealtime, type Script, type ScriptedConnection } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { OPENER_PROTECT_CAP_MS } from "@/lib/voice/settings";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { createTestDb, type TestDb } from "../helpers/db";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
/** After the opener (the scripted model speaks the opener prompt's line, a word per `wordMs`), the agent waits for the buyer. */
const SHORT: Script = [expectBuyer("anything"), say("Sure, happy to help.")];

describe("protect the opening line (scripted realtime model, fake clock)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-op", email: "op@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "op-acme@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  });
  afterAll(async () => t.close());
  beforeEach(async () => void (await db.delete(rateLimits)));

  async function newCall(o: { script?: Script; buyerCall?: boolean; protect?: boolean; wordMs?: number; text?: boolean } = {}) {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const [v] = await db.select().from(agentVersions).where(eq(agentVersions.id, c.version.id));
    // Every call starts from the version's settings without the key (a version that never stored it), or with it off.
    const { openerProtected: _old, ...rest } = (v.voiceSettings ?? {}) as Record<string, unknown>;
    void _old;
    await db.update(agentVersions).set({ voiceSettings: { ...rest, ...(o.protect === false ? { openerProtected: false } : {}) } as never }).where(eq(agentVersions.id, v.id));
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    if (o.buyerCall) await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s.sessionId));
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock, defaultScript: o.script ?? SHORT, wordMs: o.wordMs ?? 250 });
    const sent: (ServerMessage | Uint8Array)[] = [];
    const lines: string[] = [];
    const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l) };
    const engine = new VoiceEngine({
      db, model, sessionId: s.sessionId, send: (m) => sent.push(m), clock, limits: { env: {} }, log,
      ...(o.text ? { speaker: new ScriptedSpeaker("scripted", { voice: "Rachel (ElevenLabs)" }) } : {}),
    });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    const run = (ms: number) => clock.advance(ms, settle);
    /** Loud mic audio in 100 ms frames, the clock moving with it. */
    const speak = async (ms: number) => {
      const pcm = micPcm(ms, true);
      const bytes = (VOICE_SAMPLE_RATE * 2 * 100) / 1000;
      for (let at = 0; at < pcm.byteLength; at += bytes) {
        engine.onClientAudio(pcm.subarray(at, Math.min(pcm.byteLength, at + bytes)));
        await run(100);
      }
    };
    await engine.start();
    await settle();
    const conn = () => model.connections.at(-1)! as ScriptedConnection;
    const json = () => sent.filter((m): m is ServerMessage => !(m instanceof Uint8Array));
    const agentAudioMs = () => sent.filter((m): m is Uint8Array => m instanceof Uint8Array).reduce((n, b) => n + b.byteLength / 48, 0);
    return { engine, clock, model, lines, run, speak, conn, json, agentAudioMs, sessionId: s.sessionId };
  }

  const protectLines = (lines: string[]) => lines.filter((l) => l.includes("opener protected"));

  it("a test call (the default): the buyer's audio does not reach the model while the opener plays; nothing is a barge-in; then it does", async () => {
    const c = await newCall();
    expect(protectLines(c.lines)).toEqual([expect.stringMatching(/^\[voice\] \S+ opener protected: on$/)]);
    // The buyer talks over the opener (echo, noise): nothing is sent, no flush, no cut.
    await c.speak(1_000);
    expect(c.conn().sent.audioMs).toBe(0);
    expect(c.json().some((m) => m.t === "flush")).toBe(false);
    expect(c.lines.some((l) => /barge-in/.test(l))).toBe(false);
    // The opener ends and its audio plays out: protection ends, one line, and the buyer is heard again.
    for (let i = 0; i < 25 && protectLines(c.lines).length < 2; i++) await c.run(500);
    const off = protectLines(c.lines).at(-1)!;
    expect(off).toMatch(/opener protected: off after \d+ms$/);
    const ms = Number(/after (\d+)ms/.exec(off)![1]);
    // Not before the opener's audio has played (at least its whole length after the call started).
    expect(ms).toBeGreaterThanOrEqual(c.agentAudioMs());
    expect(c.agentAudioMs()).toBeGreaterThan(1_000);
    expect(ms).toBeLessThan(OPENER_PROTECT_CAP_MS);
    await c.speak(1_000);
    expect(c.conn().sent.audioMs).toBeGreaterThan(0);
    await c.engine.stop("user_hangup");
  });

  it("released at the cap (20 s) when the opener is still playing", async () => {
    // 30 words at 1 s each: 30 s of opener.
    // A word every 2 s: the opener plays far longer than 20 s.
    const c = await newCall({ wordMs: 2_000 });
    await c.run(OPENER_PROTECT_CAP_MS - 1_000);
    expect(protectLines(c.lines)).toHaveLength(1);
    await c.speak(500);
    expect(c.conn().sent.audioMs).toBe(0);
    await c.run(1_000);
    expect(protectLines(c.lines).at(-1)).toMatch(/opener protected: off after 20000ms$/);
    // From now on the buyer can cut in as before (a barge-in counts again).
    await c.speak(600);
    expect(c.conn().sent.audioMs).toBeGreaterThan(0);
    expect(c.json().some((m) => m.t === "flush")).toBe(true);
    await c.engine.stop("user_hangup");
  });

  it("switched off on the version: as before (the buyer's audio reaches the model at once and can cut in)", async () => {
    const c = await newCall({ protect: false, wordMs: 1_000 });
    expect(protectLines(c.lines)).toEqual([]);
    // The opener is playing: the buyer cuts in.
    await c.run(2_000);
    await c.speak(600);
    expect(c.conn().sent.audioMs).toBeGreaterThan(0);
    expect(c.json().some((m) => m.t === "flush")).toBe(true);
    await c.engine.stop("user_hangup");
  });

  it("a buyer call (OPENER_PROTECTION_FOR_BUYER_CALLS off): unaffected, even with the switch on", async () => {
    const c = await newCall({ buyerCall: true, wordMs: 1_000 });
    expect(protectLines(c.lines)).toEqual([]);
    await c.run(2_000);
    await c.speak(600);
    expect(c.conn().sent.audioMs).toBeGreaterThan(0);
    expect(c.json().some((m) => m.t === "flush")).toBe(true);
    await c.engine.stop("user_hangup");
  });

  it("text output (ElevenLabs speaks): the same, released once our speaker's opener has played", async () => {
    const c = await newCall({ text: true });
    expect(protectLines(c.lines)).toHaveLength(1);
    await c.speak(800);
    expect(c.conn().sent.audioMs).toBe(0);
    for (let i = 0; i < 15 && protectLines(c.lines).length < 2; i++) await c.run(1_000);
    expect(protectLines(c.lines).at(-1)).toMatch(/opener protected: off after \d+ms$/);
    await c.speak(500);
    expect(c.conn().sent.audioMs).toBeGreaterThan(0);
    await c.engine.stop("user_hangup");
  });
});

/**
 * Standby and stop rules (lib/voice/call-rules.ts), end to end on PGlite with
 * the FREE scripted realtime model and a hand-moved clock: a quiet call closes
 * the model (standby), our detector wakes it on speech (the buffered audio goes
 * first), typed text and a tap wake it too, a long quiet ends it (`idle`) unless
 * the order form is open, the total limit counts standby, and only the
 * model-connected time is paid. No paid call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { conversations, messages, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { estimatedRealtimeUsage, estimateRealtimeCostMicros, type VoiceCallUsageRecord } from "@/lib/ai/models";
import { CALL_RULES } from "@/lib/voice/call-rules";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { unansweredCallTurn } from "@/lib/voice/after-call";
import { VOICE_SAMPLE_RATE, type ServerMessage } from "@/lib/voice/protocol";
import { flushAsync, ManualClock, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { micPcm, ScriptedRealtime, type ScriptedConnection } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation, voiceSessionSummary } from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };

/** `ms` of a steady tone at this RMS level (0..1): noise or a quiet voice. */
function tonePcm(ms: number, level: number): Uint8Array {
  const n = Math.round((VOICE_SAMPLE_RATE * ms) / 1000);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  const amp = level * Math.SQRT2 * 32768;
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 300 * i) / VOICE_SAMPLE_RATE) * amp), true);
  return out;
}

describe("voice standby (scripted realtime model, fake clock)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-sb", email: "sb@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "sb-acme@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
    await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
    const { saveLegalSection } = await import("@/lib/orders/settings");
    await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  });
  afterAll(async () => t.close());
  // More test calls than the hourly limit allows.
  beforeEach(async () => void (await db.delete(rateLimits)));

  type Call = {
    conversationId: string; sessionId: string; engine: VoiceEngine; clock: ManualClock; model: ScriptedRealtime;
    sent: (ServerMessage | Uint8Array)[]; json: () => ServerMessage[]; conn: () => ScriptedConnection;
    run: (ms: number) => Promise<void>; settle: () => Promise<void>; audio: (pcm: Uint8Array, stepMs?: number) => Promise<void>;
  };

  async function newCall(scenario: string | null, o: { limits?: VoiceLimits; model?: RealtimeModel & { connections?: ScriptedConnection[] }; clock?: ManualClock; log?: import("@/lib/voice/log").VoiceLog } = {}): Promise<Call> {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED });
    if (!s.ok) throw new Error(s.reason);
    const clock = o.clock ?? new ManualClock();
    const model = (o.model ?? new ScriptedRealtime({ clock })) as ScriptedRealtime;
    const sent: (ServerMessage | Uint8Array)[] = [];
    const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, send: (m) => sent.push(m), clock, limits: { env: {}, ...o.limits }, ...(o.log ? { log: o.log } : {}) });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await engine.idle();
      }
    };
    const run = (ms: number) => clock.advance(ms, settle);
    /** Mic audio in 100 ms frames, the clock moving with it. */
    const audio = async (pcm: Uint8Array, stepMs = 100) => {
      const bytes = (VOICE_SAMPLE_RATE * 2 * stepMs) / 1000;
      for (let at = 0; at < pcm.byteLength; at += bytes) {
        engine.onClientAudio(pcm.subarray(at, Math.min(pcm.byteLength, at + bytes)));
        await run(stepMs);
      }
    };
    await engine.start();
    await settle();
    return {
      conversationId: c.conversationId, sessionId: s.sessionId, engine, clock, model, sent,
      json: () => sent.filter((m): m is ServerMessage => !(m instanceof Uint8Array)),
      conn: () => model.connections.at(-1)!, run, settle, audio,
    };
  }

  const thread = (conversationId: string) =>
    db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
  const sessionRow = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];
  const states = (c: Call) => c.json().filter((m): m is Extract<ServerMessage, { t: "state" }> => m.t === "state").map((m) => m.state);
  const usageOf = async (id: string) => (await sessionRow(id)).usage as unknown as VoiceCallUsageRecord;
  /** The opener is done by 15 s; standby comes 30 s after the agent finished. Returns the clock time it began (±1 s). */
  const toStandby = async (c: Call): Promise<number> => {
    await c.run(15_000);
    for (let i = 0; i < CALL_RULES.standbyAfterQuietMs / 1000 + 1 && !c.engine.onStandby; i++) await c.run(1_000);
    expect(c.engine.onStandby).toBe(true);
    return c.clock.now();
  };

  it("a quiet buyer: standby 30 s after the agent finished (not at 2 s), the model closed, no message stored", async () => {
    const c = await newCall(null);
    await c.run(15_000); // opener spoken (ends at or before 15 s)
    const rowsBefore = (await thread(c.conversationId)).length;
    await c.run(2_000);
    expect(c.engine.onStandby).toBe(false);
    await c.run(12_000); // 29 s: less than 30 s after the opener ended
    expect(c.engine.onStandby).toBe(false);
    expect(c.conn().closed).toBe(false);
    await c.run(17_000); // 46 s: more than 30 s after it
    expect(c.engine.onStandby).toBe(true);
    expect(c.conn().closed).toBe(true);
    expect(states(c).at(-1)).toBe("standby");
    expect((await thread(c.conversationId)).length).toBe(rowsBefore);
    // No spoken "are you still there?" any more.
    expect(c.json().some((m) => m.t === "notice" && m.kind === "silence_check")).toBe(false);
    expect(c.conn().sent.responses.some((r) => /still there/i.test(r ?? ""))).toBe(false);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    expect((await sessionRow(c.sessionId)).endReason).toBe("user_hangup");
  });

  it("never mid-turn: a long agent line keeps the model connected until 30 s after it ends", async () => {
    const clock = new ManualClock();
    // 2 s a word: the opener takes about half a minute.
    const c = await newCall(null, { clock, model: new ScriptedRealtime({ clock, wordMs: 2_000 }) });
    await c.run(31_000);
    expect(c.engine.onStandby).toBe(false);
    expect(states(c)).toContain("speaking");
    await c.run(70_000);
    expect(c.engine.onStandby).toBe(true);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("never while a tool's turn is open or work is queued", async () => {
    const c = await newCall(null, { limits: { standbyAfterQuietMs: 1_000 } });
    await c.run(15_000);
    expect(c.engine.onStandby).toBe(true); // short quiet: on standby already
    c.engine.onClientMessage({ t: "wake" });
    await c.settle();
    expect(c.engine.onStandby).toBe(false);
    // The model calls a tool: queued, then the turn waits for the model to go on after the result.
    (c.conn() as unknown as { emit: (e: RealtimeEvent) => void }).emit({ type: "tool-call", callId: "t1", name: "search_catalog", args: { query: "" } });
    await c.clock.advance(5_000);
    expect(c.engine.onStandby).toBe(false);
    await c.run(60_000);
    expect(c.engine.onStandby).toBe(false);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("speech wakes it: the buffered audio goes to the model first, nothing is lost; latency stored per wake", async () => {
    const c = await newCall(null);
    await toStandby(c);
    const first = c.conn();
    // The buyer speaks 1 s, then is quiet.
    await c.audio(micPcm(1_000, true));
    await c.audio(micPcm(800, false));
    expect(c.engine.onStandby).toBe(false);
    const woke = c.conn();
    expect(woke).not.toBe(first);
    // Every frame since the detector's pre-roll reached the new model (1.8 s), in order.
    expect(woke.sent.audioMs).toBe(1_800);
    expect(states(c).slice(-3)).toContain("listening");
    await c.run(10_000);
    const rows = await thread(c.conversationId);
    expect(rows.some((m) => m.actor === "buyer" && m.body === "Hi, I'm looking for a quote for my business.")).toBe(true);
    expect(rows.some((m) => m.actor === "agent" && m.body.startsWith("Happy to help."))).toBe(true);
    // The new model got fresh instructions saying the call comes back from standby.
    expect(woke.cfg.instructions).toContain("The call was on standby while the buyer was quiet");
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    const u = await usageOf(c.sessionId);
    expect(u.wakes).toBe(1);
    expect(u.standbys).toBe(1);
    expect(u.wakeLog![0]).toMatchObject({ by: "speech", heard: true });
    expect(u.wakeLog![0].readyMs).toBeGreaterThanOrEqual(0);
    expect(u.wakeLog![0].firstAudioMs).toBeGreaterThanOrEqual(u.wakeLog![0].readyMs!);
  });

  it("a click does not wake it (shorter than 250 ms)", async () => {
    const c = await newCall(null);
    await toStandby(c);
    await c.audio(micPcm(200, true));
    await c.audio(micPcm(1_000, false));
    expect(c.engine.onStandby).toBe(true);
    expect(c.model.connections).toHaveLength(1);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
  });

  it("typed text wakes it: the message is stored, the model reconnects and gets the text", async () => {
    const c = await newCall(null);
    await toStandby(c);
    c.engine.onClientMessage({ t: "text", text: "Hi, I'm looking for a quote for my business." });
    await c.settle();
    expect(c.engine.onStandby).toBe(false);
    expect(c.conn().sent.texts).toEqual(["Hi, I'm looking for a quote for my business."]);
    await c.run(10_000);
    const rows = await thread(c.conversationId);
    expect(rows.filter((m) => m.actor === "buyer").map((m) => m.typedInCall)).toEqual([true]);
    expect(rows.some((m) => m.actor === "agent" && m.body.startsWith("Happy to help."))).toBe(true);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    expect((await usageOf(c.sessionId)).wakeLog![0]).toMatchObject({ by: "typed", heard: true });
  });

  it("a tap wakes it (no message stored), and 30 s of quiet puts it back on standby", async () => {
    const c = await newCall(null);
    await toStandby(c);
    const rows = (await thread(c.conversationId)).length;
    c.engine.onClientMessage({ t: "wake" });
    await c.settle();
    expect(c.engine.onStandby).toBe(false);
    expect(c.model.connections).toHaveLength(2);
    expect((await thread(c.conversationId)).length).toBe(rows);
    await c.run(29_000);
    expect(c.engine.onStandby).toBe(false);
    await c.run(2_000);
    expect(c.engine.onStandby).toBe(true);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    const u = await usageOf(c.sessionId);
    expect(u).toMatchObject({ wakes: 1, standbys: 2 });
    expect(u.wakeLog![0].by).toBe("tap");
  });

  it("3 minutes of standby with no speech ends the call (idle); figures stored; the after-call reply has nothing to answer", async () => {
    const c = await newCall(null);
    await toStandby(c);
    await c.run(CALL_RULES.standbyIdleEndMs - 2_000);
    expect(c.engine.isEnded).toBe(false);
    await c.run(3_000);
    expect(c.engine.isEnded).toBe(true);
    const row = await sessionRow(c.sessionId);
    expect(row.endReason).toBe("idle");
    expect(c.json().find((m) => m.t === "ended")).toMatchObject({ reason: "idle" });
    const u = row.usage as unknown as VoiceCallUsageRecord;
    expect(u.standbySec).toBeGreaterThanOrEqual(180);
    expect(u.activeSec! + u.standbySec!).toBe(row.durationSec);
    expect(u.activeSec).toBeLessThan(50);
    // Only the opener and the closing note in the thread (nothing for standby).
    expect((await thread(c.conversationId)).map((m) => m.actor)).toEqual(["agent", "system"]);
    // The review shows both times.
    expect(await voiceSessionSummary(db, acc, c.conversationId)).toMatchObject({ activeSec: u.activeSec, standbySec: u.standbySec, wakes: 0 });
    // As a buyer call, the agent spoke last: nothing to answer after the call.
    expect(await unansweredCallTurn(db, { ...row, isTest: false })).toBeNull();
    // A buyer line the model never answered would still get its reply (idle is an after-call reason).
    await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body: "Hello?", language: "en", voiceSessionId: c.sessionId, createdAt: new Date(Date.now() + 1_000) });
    expect(await unansweredCallTurn(db, { ...row, isTest: false })).toMatchObject({ body: "Hello?" });
  });

  it("order form sent in the call: no idle end on standby, only the call's limit (8 minutes by default, standby included)", async () => {
    const c = await newCall("ready_buyer");
    await c.run(15_000);
    // The ready buyer speaks twice; the agent sends the quote, then the order form.
    for (let i = 0; i < 2; i++) {
      await c.audio(micPcm(1_000, true));
      await c.audio(micPcm(800, false));
      await c.run(30_000);
    }
    expect((await thread(c.conversationId)).some((m) => m.body.startsWith("Your order form:"))).toBe(true);
    await c.run(CALL_RULES.standbyAfterQuietMs);
    expect(c.engine.onStandby).toBe(true);
    await c.run(CALL_RULES.standbyIdleEndMs + 60_000);
    expect(c.engine.isEnded).toBe(false);
    await c.run(CALL_RULES.defaultMaxCallSec * 1000);
    expect(c.engine.isEnded).toBe(true);
    const row = await sessionRow(c.sessionId);
    expect(row.endReason).toBe("limit");
    expect(row.durationSec).toBe(CALL_RULES.defaultMaxCallSec);
    // No limit announcement on standby (nobody to hear it).
    expect(c.json().some((m) => m.t === "notice" && m.kind === "limit_soon")).toBe(false);
  });

  it("the bubble's form context (noteOrderFormOpen) also stops the idle end", async () => {
    const c = await newCall(null, { limits: { env: { VOICE_MAX_CALL_SECONDS: "400" } } });
    await toStandby(c);
    c.engine.noteOrderFormOpen();
    await c.run(CALL_RULES.standbyIdleEndMs + 30_000);
    expect(c.engine.isEnded).toBe(false);
    await c.run(400_000);
    expect((await sessionRow(c.sessionId)).endReason).toBe("limit");
  });

  it("limit reached while on standby: the call just ends (limit)", async () => {
    const c = await newCall(null, { limits: { env: { VOICE_MAX_CALL_SECONDS: "120" } } });
    await toStandby(c);
    await c.run(120_000);
    expect(c.engine.isEnded).toBe(true);
    expect((await sessionRow(c.sessionId)).endReason).toBe("limit");
    expect(c.json().some((m) => m.t === "notice" && m.kind === "limit_soon")).toBe(false);
  });

  it("false wakes: noise the model does not transcribe goes back to standby; after 3 the detector needs more; idle still counts", async () => {
    const clock = new ManualClock();
    // A model that hears nothing below a loud voice: the noise wakes our detector but produces no words.
    const c = await newCall(null, { clock, model: new ScriptedRealtime({ clock, speechRms: 0.5 }) });
    const standbyAt = await toStandby(c);
    const noise = () => c.audio(tonePcm(400, 0.03));
    for (let i = 1; i <= 3; i++) {
      await noise();
      expect(c.engine.onStandby).toBe(false);
      await c.run(CALL_RULES.falseWakeMs + 500);
      expect(c.engine.onStandby).toBe(true);
    }
    expect(c.model.connections).toHaveLength(4);
    // After 3 false wakes the threshold doubled: the same noise no longer wakes it; a real voice does.
    await noise();
    expect(c.engine.onStandby).toBe(true);
    expect(c.model.connections).toHaveLength(4);
    // The idle end counts from the first standby (false wakes are no speech).
    const left = standbyAt + CALL_RULES.standbyIdleEndMs - c.clock.now();
    await c.run(left - 2_000);
    expect(c.engine.isEnded).toBe(false);
    await c.run(3_000);
    expect(c.engine.isEnded).toBe(true);
    const u = await usageOf(c.sessionId);
    expect((await sessionRow(c.sessionId)).endReason).toBe("idle");
    expect(u).toMatchObject({ wakes: 3, falseWakes: 3 });
    expect(u.wakeLog!.every((w) => w.by === "speech" && !w.heard)).toBe(true);
  });

  it("transcription markers (\"<no speech detected>\"): never sent, stored or a buyer turn; a wake that only produced a marker is a false wake", async () => {
    const { SCRIPTED_MARKER } = await import("@/lib/voice/scripted-realtime");
    // The agent's lines come with a marker in front; every buyer turn is a marker and nothing else (noise).
    const clock = new ManualClock();
    const c = await newCall(null, { clock, model: new ScriptedRealtime({ clock, markers: "with_text" }) });
    await c.run(15_000);
    const voice = () => tonePcm(1_200, 0.3);
    await c.audio(voice());
    await c.audio(tonePcm(1_000, 0));
    await c.run(20_000);
    const said = JSON.stringify(c.json());
    expect(said).not.toContain("no speech");
    const rows = await thread(c.conversationId);
    expect(rows.some((r) => r.body.includes("no speech"))).toBe(false);
    // The agent's line is there without the marker; the buyer's turn (its real words) too.
    expect(rows.some((r) => r.actor === "agent" && r.voiceSessionId)).toBe(true);
    expect(SCRIPTED_MARKER).toBe("<no speech detected>");

    const clock2 = new ManualClock();
    const d = await newCall(null, { clock: clock2, model: new ScriptedRealtime({ clock: clock2, markers: "only" }) });
    await toStandby(d);
    const before = (await thread(d.conversationId)).filter((r) => r.actor === "buyer").length;
    // A real-sounding voice wakes the detector, but the model only transcribes a marker: no words heard.
    await d.audio(tonePcm(1_200, 0.3));
    expect(d.engine.onStandby).toBe(false);
    await d.audio(tonePcm(1_000, 0));
    await d.run(CALL_RULES.falseWakeMs + 500);
    expect(d.engine.onStandby).toBe(true);
    expect((await thread(d.conversationId)).filter((r) => r.actor === "buyer").length).toBe(before);
    expect(JSON.stringify(d.json())).not.toContain("no speech");
    d.engine.onClientMessage({ t: "end" });
    await d.run(5_000);
    const u = await usageOf(d.sessionId);
    expect(u).toMatchObject({ falseWakes: 1 });
  });

  it("order_form_status: the buyer asks \"what do I put here?\", the agent looks up the form's step and names it (no values)", async () => {
    const { FORM_QUESTION_SCRIPT } = await import("@/lib/voice/scripted-realtime");
    const clock = new ManualClock();
    const c = await newCall(null, { clock, model: new ScriptedRealtime({ clock, defaultScript: FORM_QUESTION_SCRIPT }), limits: { standbyAfterQuietMs: 600_000 } });
    await c.run(15_000);
    c.engine.onClientMessage({ t: "context", kind: "order_form", step: "company", label: "Your company", event: "opened" });
    await c.audio(tonePcm(1_200, 0.3));
    await c.audio(tonePcm(1_000, 0));
    await c.run(20_000);
    const said = c.json().filter((m): m is Extract<ServerMessage, { t: "transcript" }> => m.t === "transcript" && m.role === "agent" && m.final).map((m) => m.text);
    expect(said.some((t) => t.includes("You're on Company details"))).toBe(true);
    // The test lab shows the chip; the result has the fixed step name only.
    expect(c.json().some((m) => m.t === "tool" && m.name === "order_form_status" && m.label === "Checking the order form")).toBe(true);
    const r = c.conn().sent.toolResults.find((x) => x.name === "order_form_status")!.result as Record<string, unknown>;
    expect(r).toMatchObject({ open: true, step: "Company details", submitted: false });
    expect(JSON.stringify(r)).not.toContain("Your company");
  });

  it("model per version: saved on the draft (a Gemini voice dropped on the switch), recorded on the session, used for the whole call", async () => {
    const { saveDraftVoiceSettings } = await import("@/lib/voice/service");
    const { agentVersions } = await import("@/db/schema");
    const GPT = "openai/gpt-realtime-2.1";
    const before = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, acc), eq(agentVersions.status, "draft")));
    await saveDraftVoiceSettings(db, acc, { voice: "Kore" }, {});
    const saved = await saveDraftVoiceSettings(db, acc, { model: GPT, voice: "Kore", style: "balanced", pauseMs: "1100", interrupt: "low" }, {});
    expect(saved).toEqual({ ok: true, settings: { model: GPT, style: "balanced", pauseMs: 1100, interrupt: "low" } });
    try {
      const clock = new ManualClock();
      // The scripted model stands in for GPT-Realtime 2.1 (its id), so the engine builds the OpenAI session.
      const model = new ScriptedRealtime({ clock });
      Object.defineProperty(model, "modelId", { value: GPT });
      const c = await newCall(null, { clock, model, limits: { standbyAfterQuietMs: 600_000 } });
      const cfg = c.conn().cfg;
      expect(cfg.voice).toBe("alloy");
      expect(cfg.turnTaking).toEqual({ silenceMs: 1100, threshold: 0.7, prefixPaddingMs: 300 });
      expect(cfg.tools.find((t) => t.name === "search_catalog")!.parameters).toMatchObject({ type: "object", additionalProperties: false });
      await c.run(15_000);
      const row = await sessionRow(c.sessionId);
      // A scripted stand-in keeps the version's model on the row (mode says scripted); the snapshot names it too.
      expect(row).toMatchObject({ model: GPT, mode: "scripted" });
      expect((row.settings as Record<string, unknown>).model).toBe(GPT);
      const sum = await voiceSessionSummary(db, acc, c.conversationId);
      expect(sum).toMatchObject({ model: GPT });
    } finally {
      await db.update(agentVersions).set({ voiceSettings: before[0]?.voiceSettings ?? null }).where(and(eq(agentVersions.accountId, acc), eq(agentVersions.status, "draft")));
    }
  });

  describe("OpenAI refusing the session setup (GPT-Realtime, 22 Nov 2026)", () => {
    const GPT = "openai/gpt-realtime-2.1";
    const PROMPT_ERR = "invalid_value: The 'prompt' parameter is not supported for this model.";
    type Sdk = ReturnType<typeof import("@/lib/voice/gateway-realtime").toSdkSessionConfig>;
    /**
     * Stands in for GPT-Realtime through the Gateway: the session config as the adapter builds it; when `reject`
     * names a reason, the whole setup is refused like the real one (an error event right after connect), and the
     * session runs on without it. The scripted model plays the call.
     */
    async function rejectingModel(clock: ManualClock, reject: (sdk: Sdk) => string | null) {
      const { toSdkSessionConfig } = await import("@/lib/voice/gateway-realtime");
      const inner = new ScriptedRealtime({ clock });
      const sent: Sdk[] = [];
      const model = {
        modelId: GPT, mode: "scripted" as const, connections: inner.connections,
        async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void) {
          const sdk = toSdkSessionConfig(cfg, GPT);
          sent.push(sdk);
          const conn = await inner.connect(cfg, onEvent);
          const why = reject(sdk);
          if (why) queueMicrotask(() => onEvent({ type: "provider-event", kind: "error", name: "error:invalid_value", message: why }));
          return Object.assign(conn, { sessionFields: Object.keys(sdk) });
        },
      };
      return { model, sent };
    }
    const logs = () => {
      const lines: { level: string; line: string }[] = [];
      return { lines, log: { info: (line: string) => lines.push({ level: "info", line }), warn: (line: string) => lines.push({ level: "warn", line }), error: (line: string) => lines.push({ level: "error", line }) } };
    };
    const hasPrompt = (sdk: Sdk) => (JSON.stringify(sdk.inputAudioTranscription ?? {}).includes('"prompt"') ? PROMPT_ERR : null);

    it("the first connect sends no transcription prompt, so a model that rejects one accepts it: one connection, the opener spoken", async () => {
      const clock = new ManualClock();
      const { model, sent } = await rejectingModel(clock, hasPrompt);
      const l = logs();
      const c = await newCall(null, { clock, model: model as never, log: l.log, limits: { standbyAfterQuietMs: 600_000 } });
      await c.run(15_000);
      expect(sent).toHaveLength(1);
      expect(hasPrompt(sent[0])).toBeNull();
      expect(sent[0]).toMatchObject({ instructions: expect.any(String), voice: "alloy", inputAudioTranscription: {}, tools: expect.any(Array) });
      expect(l.lines.some((x) => x.level === "error")).toBe(false);
      expect(c.json().some((m) => m.t === "transcript" && m.role === "agent" && m.final)).toBe(true);
      expect(c.engine.isEnded).toBe(false);
    });

    it("a setup error before the first audio is logged at error level with the fields sent, and ONE retry carries instructions and tools only", async () => {
      const clock = new ManualClock();
      // Refuses anything beyond the smallest config (as an unknown future refusal would).
      const { model, sent } = await rejectingModel(clock, (sdk) => (sdk.inputAudioTranscription || sdk.voice || sdk.turnDetection ? PROMPT_ERR : null));
      const l = logs();
      const c = await newCall(null, { clock, model: model as never, log: l.log, limits: { standbyAfterQuietMs: 600_000 } });
      await c.run(15_000);
      const err = l.lines.find((x) => x.level === "error")!;
      expect(err.line).toContain(`provider rejected the session setup: ${PROMPT_ERR}`);
      expect(err.line).toMatch(/sent=instructions,voice,outputModalities,inputAudioFormat,outputAudioFormat,inputAudioTranscription,outputAudioTranscription,turnDetection,tools$/);
      expect(err.line).not.toContain("Be brief");
      expect(sent).toHaveLength(2);
      expect(Object.keys(sent[1])).toEqual(["instructions", "outputModalities", "inputAudioFormat", "outputAudioFormat", "tools"]);
      expect(sent[1].instructions).toBe(sent[0].instructions);
      expect(sent[1].tools).toEqual(sent[0].tools);
      // The retried session says the opener and the call goes on.
      expect(c.json().some((m) => m.t === "transcript" && m.role === "agent" && m.final)).toBe(true);
      expect(c.engine.isEnded).toBe(false);
    });

    it("refused again: the call ends (model_rejected_session, the provider's error kept) instead of running without its playbook", async () => {
      const clock = new ManualClock();
      const { model, sent } = await rejectingModel(clock, () => PROMPT_ERR);
      const l = logs();
      const c = await newCall(null, { clock, model: model as never, log: l.log, limits: { standbyAfterQuietMs: 600_000 } });
      await c.run(15_000);
      expect(sent).toHaveLength(2);
      expect(c.engine.isEnded).toBe(true);
      const row = await sessionRow(c.sessionId);
      expect(row).toMatchObject({ endReason: "error", errorCode: "model_closed_early" });
      const u = (await usageOf(c.sessionId)) as VoiceCallUsageRecord;
      expect(u.endDetail).toMatchObject({ by: "model_rejected_session", lastError: PROMPT_ERR });
      expect(l.lines.filter((x) => x.level === "error")).toHaveLength(2);
    });
  });

  it("a wake whose model connection fails is retried once; two failures end the call (connection_lost)", async () => {
    const clock = new ManualClock();
    const inner = new ScriptedRealtime({ clock });
    let failures = 0;
    const flaky: RealtimeModel & { connections: ScriptedConnection[] } = {
      modelId: "scripted", mode: "scripted", connections: inner.connections,
      connect: (cfg: RealtimeSessionConfig, on: (e: RealtimeEvent) => void) => {
        if (failures > 0) {
          failures--;
          return Promise.reject(new Error("down"));
        }
        return inner.connect(cfg, on);
      },
    };
    const c = await newCall(null, { clock, model: flaky });
    await toStandby(c);
    failures = 1;
    c.engine.onClientMessage({ t: "wake" });
    await c.settle();
    expect(c.engine.onStandby).toBe(false);
    expect(c.engine.isEnded).toBe(false);
    expect(inner.connections).toHaveLength(2);
    await c.run(CALL_RULES.standbyAfterQuietMs + 1_000);
    expect(c.engine.onStandby).toBe(true);
    failures = 2;
    c.engine.onClientMessage({ t: "wake" });
    await c.settle();
    expect(c.engine.isEnded).toBe(true);
    expect(await sessionRow(c.sessionId)).toMatchObject({ endReason: "connection_lost", errorCode: "connection_lost" });
    expect(c.json()).toContainEqual({ t: "error", code: "connection_lost" });
  });

  it("the page closes on standby: the call ends at once (connection_lost)", async () => {
    const c = await newCall(null);
    await toStandby(c);
    c.engine.onClientGone();
    await c.settle();
    expect((await sessionRow(c.sessionId)).endReason).toBe("connection_lost");
  });

  it("money: the duration floor counts only model-connected seconds; usage adds up across model sessions", async () => {
    const clock = new ManualClock();
    const inner = new ScriptedRealtime({ clock });
    // The last usage snapshot each model session reported (each session counts from 0).
    const lastSnap = new Map<number, number>();
    const live: RealtimeModel & { connections: ScriptedConnection[] } = {
      modelId: "google/gemini-3.8-live", mode: "live", connections: inner.connections,
      connect: (cfg, on) => {
        const n = inner.connections.length;
        return inner.connect(cfg, (e) => {
          if (e.type === "usage") lastSnap.set(n, e.usage.audioOutTokens);
          on(e);
        });
      },
    };
    const c = await newCall(null, { clock, model: live });
    await toStandby(c);
    await c.run(100_000); // long standby: not paid
    c.engine.onClientMessage({ t: "text", text: "Hi, I'm looking for a quote for my business." });
    await c.settle();
    await c.run(10_000);
    c.engine.onClientMessage({ t: "end" });
    await c.settle();
    const row = await sessionRow(c.sessionId);
    const u = row.usage as unknown as VoiceCallUsageRecord;
    expect(row.durationSec).toBeGreaterThan(130);
    expect(u.activeSec).toBeLessThan(70);
    expect(u.standbySec).toBe(row.durationSec! - u.activeSec!);
    expect(u.durationCostMicros).toBe(estimateRealtimeCostMicros("google/gemini-3.8-live", estimatedRealtimeUsage(u.activeSec!)));
    expect(row.costMicros).toBe(Math.max(u.usageCostMicros ?? 0, u.durationCostMicros));
    // Two model sessions, each with counters from 0: the total is the sum of their last snapshots.
    expect(lastSnap.size).toBe(2);
    expect(u.audioOutTokens).toBe([...lastSnap.values()].reduce((a, b) => a + b, 0));
    await db.delete(voiceSessions).where(and(eq(voiceSessions.id, c.sessionId)));
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, c.conversationId));
  });
});

/**
 * "Classic + guards" (lib/voice-guarded: today's engine with the Classic model side and today's guards) on PGlite
 * with free fake models and a hand-moved clock. No paid call.
 * (b) Everything sent to the model on a scripted call (session config, tool results, notes, response requests,
 *     typed lines) equals the Classic engine's for the same call, except the listed differences.
 * (c) Each guard fires on its case and is silent otherwise (K1-K4); the quote's spoken summary in English and Hebrew
 *     (K5/K6); the hand-off keeps the call (K7); recording and its notice once (K8); the opener waits for the
 *     browser (K9); one agent at a time (K10).
 * (d) Transcripts are stored as said (no cleaner); Current still cleans them.
 * The relay runs the guarded engine for a guarded session (logs engine=guarded, keeps it on the session).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { and, asc, eq } from "drizzle-orm";
import { conversations, messages, rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, readDealState } from "@/lib/agent/service";
import { ClassicVoiceEngine } from "@/lib/voice-classic/engine";
import { formNotSentMessage, HANDOFF_RESULT_MESSAGE, refusedQuoteMessage, VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { GUARDED_PROFILE, guardedQuoteMessage } from "@/lib/voice-guarded/profile";
import { guardedInstructions } from "@/lib/voice-guarded/instructions";
import { realtimeTools as currentTools } from "@/lib/voice/tool-schema";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { micPcm, SCRIPTED_MARKER, ScriptedRealtime, type ScriptedConnection } from "@/lib/voice/scripted-realtime";
import { createVoiceSession, startVoiceTestConversation, voiceSessionSummary } from "@/lib/voice/service";
import { textTurnBlocked } from "@/lib/voice/one-agent";
import { handleVoiceSocket, type VoiceSocket } from "@/lib/voice/socket";
import { MemoryRecordingStore } from "@/lib/voice/recording";
import { RECORDING_NOTICE, recordedCallRule } from "@/lib/voice/recording-settings";
import { ServerEventMapper } from "@/lib/voice/gateway-realtime";
import type { VoiceLog } from "@/lib/voice/log";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };

const memLog = () => {
  const lines: string[] = [];
  const log: VoiceLog = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  return { lines, log };
};

/** A model whose events the test emits by hand; records everything the engine sends it. */
class FakeModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  readonly modelId = "google/gemini-3.8-live";
  readonly conns: { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { name: string; result: Record<string, unknown> }[]; responses: (string | undefined)[]; notes: string[] }[] = [];
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c = { cfg, emit: onEvent, results: [] as { name: string; result: Record<string, unknown> }[], responses: [] as (string | undefined)[], notes: [] as string[] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined,
      requestResponse: (t) => void c.responses.push(t), sendNote: (n) => void c.notes.push(n),
      sendToolResult: (_id, name, result) => void c.results.push({ name, result: result as Record<string, unknown> }),
    };
  }
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let acc: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "g", email: "g@p.test", firstName: "Gil", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "g-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [
    { sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" },
    { sku: "SENSOR", name: "Temperature sensor", unit: "unit" },
    { sku: "GATEWAY", name: "Gateway", unit: "unit" },
  ]);
  // The sensor: ₪450 once and ₪17.70 a month each (VAT included): six of them are ₪106.20 a month.
  await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }, { sku: "SENSOR", oneTime: 45_000, recurring: 1_770 }, { sku: "GATEWAY", oneTime: 90_000 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const thread = (id: string) => db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
const sessionRow = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];

/** A scripted call on Classic, guarded or Current (same account, same scenario, same driving). */
async function scriptedCall(engine: "classic" | "guarded" | "current", o: { scenario?: string | null; markers?: "with_text" | "only"; store?: MemoryRecordingStore | null; conversationId?: string; waitAudio?: boolean } = {}) {
  const conversationId = o.conversationId ?? (await startVoiceTestConversation(db, acc, me.id, { scenario: o.scenario ?? null, language: "en" }))!.conversationId;
  const s = await createVoiceSession(db, { accountId: acc, conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, ...(engine === "current" ? {} : { engine }) });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock(Date.UTC(2026, 10, 23, 10, 0, 0));
  const model = new ScriptedRealtime({ clock, ...(o.markers ? { markers: o.markers } : {}) });
  const sent: unknown[] = [];
  const { lines, log } = memLog();
  const limits = { ...QUIET, ...(o.waitAudio ? { waitForClientAudio: true } : {}) };
  const deps = { db, model, sessionId: s.sessionId, send: (m: unknown) => void sent.push(m), clock, limits, log };
  const store = o.store === undefined ? null : o.store;
  const e = engine === "classic" ? new ClassicVoiceEngine(deps)
    : new VoiceEngine({ ...deps, recording: { store, reason: store ? "test store" : "no store (test)" }, ...(engine === "guarded" ? { profile: GUARDED_PROFILE } : {}) });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await e.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  const speak = async (ms = 1000) => {
    for (let x = 0; x < ms; x += 100) { e.onClientAudio(micPcm(100, true)); await run(100); }
    for (let x = 0; x < 800; x += 100) { e.onClientAudio(micPcm(100, false)); await run(100); }
  };
  await e.start();
  await settle();
  const end = async () => { e.onClientMessage({ t: "end" }); await settle(); };
  return { ...s, conversationId, engine: e, clock, model, lines, run, speak, settle, end };
}

/** Everything a scripted call sent to the model, per connection. */
function modelStream(model: ScriptedRealtime) {
  return model.connections.map((c: ScriptedConnection) => ({
    cfg: { ...c.cfg }, responses: [...c.sent.responses], texts: [...c.sent.texts], notes: [...c.notes],
    toolResults: c.sent.toolResults.map((r) => ({ callId: r.callId, name: r.name, result: structuredClone(r.result) as Record<string, unknown> })),
  }));
}
type Stream = ReturnType<typeof modelStream>;

/** Ids and quote numbers differ between two calls; nothing else may. */
const normalize = (v: unknown) => JSON.parse(JSON.stringify(v)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
  .replace(/Q-\d+/g, "Q-N")
  .replace(/\/f\/[A-Za-z0-9_-]+/g, "/f/<token>"));

describe("Classic + guards", () => {
  it("(b) the model-facing stream equals Classic's for the same scripted call, except the listed differences", async () => {
    const drive = async (c: Awaited<ReturnType<typeof scriptedCall>>) => {
      c.engine.onClientMessage({ t: "ready" });
      await c.run(15_000);
      await c.speak();
      await c.run(30_000);
      await c.speak();
      await c.run(30_000);
      await c.end();
    };
    const classic = await scriptedCall("classic", { scenario: "ready_buyer" });
    await drive(classic);
    const guarded = await scriptedCall("guarded", { scenario: "ready_buyer" });
    await drive(guarded);
    const a = modelStream(classic.model);
    const g = modelStream(guarded.model);
    expect(a).toHaveLength(1);
    expect(g).toHaveLength(1);

    // The listed differences (and only these):
    const expected: Stream = structuredClone(a);
    const gq = g[0].toolResults.find((r) => r.name === "create_quote")!.result;
    for (const conn of expected) {
      // 1. Instructions: Classic's plus the guarded lines (tests/unit/voice-guarded-instructions.test.ts lists them).
      conn.cfg.instructions = guardedInstructions(conn.cfg.instructions, { recorded: false });
      // 2. Tools: Classic's plus order_form_status (K12).
      conn.cfg.tools = [...conn.cfg.tools, currentTools("openai").find((x) => x.name === "order_form_status")!];
      for (const r of conn.toolResults) {
        // 3. create_quote, a ready quote: the spoken summary (say_this) and the message asking to say it (K5/K6).
        if (r.name === "create_quote") r.result = { ...r.result, say_this: gq.say_this, message: guardedQuoteMessage(String(r.result.quote)) };
      }
    }
    expect(normalize(g)).toEqual(normalize(expected));

    // What was compared: the opener request, four tool results (update_deal_state with its full stage block, T1),
    // no notes, no typed lines. The guards stayed silent (the buyer asked for the form; nothing lowered or removed).
    expect(g[0].responses).toHaveLength(1);
    expect(g[0].responses[0]).toMatch(/^The call has just connected\. Say your opening line now/);
    expect(g[0].toolResults.map((r) => r.name)).toEqual(["update_deal_state", "search_catalog", "create_quote", "send_order_form"]);
    expect(String(g[0].toolResults[0].result.stage)).toMatch(/^## Stage now: /);
    expect(g[0].toolResults[3].result).toMatchObject({ ok: true, link: "shown in the chat" });
    expect(g[0].toolResults[0].result.kept_as_buyer_said).toBeUndefined();
    expect(String(gq.say_this)).toMatch(/^One User seat\. That's one hundred shekels today, including VAT\./);
    // The stored threads have the same shape.
    const shape = async (id: string) => (await thread(id)).map((m) => `${m.actor}${m.voiceSessionId ? ":call" : ""}`);
    expect(await shape(guarded.conversationId)).toEqual(await shape(classic.conversationId));
    // The engine is on the session and in the logs; the call is recorded per the account (here: no store).
    const row = await sessionRow(guarded.sessionId);
    expect(row.settings).toMatchObject({ engine: "guarded" });
    expect((await voiceSessionSummary(db, acc, guarded.conversationId))?.engine).toBe("guarded");
    expect(guarded.lines.some((l) => /^\[voice\] \w{8} engine=guarded$/.test(l))).toBe(true);
    expect(guarded.lines.some((l) => / ended reason=user_hangup .* engine=guarded$/.test(l))).toBe(true);
  });

  describe("(c) the guards", () => {
    async function fakeCall(lines: { actor: "agent" | "buyer"; body: string; ageMs: number }[] = [], limits: VoiceLimits = {}) {
      const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
      for (const l of lines) await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: l.actor, body: l.body, language: "en", createdAt: new Date(Date.now() - l.ageMs) });
      const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "guarded" });
      if (!s.ok) throw new Error(s.reason);
      const clock = new ManualClock();
      const model = new FakeModel();
      const { lines: logs, log } = memLog();
      const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, send: () => undefined, log, limits: { ...QUIET, ...limits }, recording: { store: null, reason: "test" }, profile: GUARDED_PROFILE });
      const settle = async () => {
        for (let i = 0; i < 4; i++) {
          await flushAsync();
          await engine.idle();
        }
      };
      const run = (ms: number) => clock.advance(ms, settle);
      return {
        ...s, conversationId: c.conversationId, leadId: c.leadId, clock, model, engine, logs, settle, run,
        startNow: async () => { await engine.start(); await settle(); },
        emit: (e: RealtimeEvent) => model.conns.at(-1)!.emit(e),
        said: async (text: string) => {
          model.conns.at(-1)!.emit({ type: "audio", pcm: new Uint8Array(480) });
          model.conns.at(-1)!.emit({ type: "agent-transcript", text, final: true });
          model.conns.at(-1)!.emit({ type: "turn-done" });
          await run(300);
        },
        buyer: async (text: string) => { engine.onClientMessage({ t: "text", text }); await run(300); },
        tool: async (callId: string, name: string, args: unknown) => {
          model.conns.at(-1)!.emit({ type: "tool-call", callId, name, args });
          await run(500);
          return model.conns.at(-1)!.results.filter((r) => r.name === name).at(-1)!.result;
        },
        end: async () => { engine.onClientMessage({ t: "end" }); await settle(); },
      };
    }
    const noUpdate = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };
    const quoteArgs = (lines: { sku: string; qty: number }[], extra: Record<string, unknown> = {}) => ({ lines, discount_percent: 0, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null, ...extra });

    it("K1: send_order_form held on a vague yes (Current's refusal); sent after the buyer asks for it", async () => {
      const c = await fakeCall();
      await c.startNow();
      await c.said("If the price worked, is anything else in the way?");
      await c.buyer("Yeah, I guess so. I need a solution.");
      const held = await c.tool("f1", "send_order_form", { quote: "Q-1" });
      expect(held).toMatchObject({ ok: false, rule: "Not agreed yet" });
      expect(held.message).toBe(formNotSentMessage({ rule: "Not agreed yet", message: "The buyer has not agreed to the order form. Offer it in one short sentence and wait for their yes; if they raised the price or another concern, answer that first." }));
      expect(c.logs.some((l) => l.endsWith("tool send_order_form held: the buyer has not agreed to it yet"))).toBe(true);
      // Silent otherwise: the buyer asks for it; the tool runs (its own result, unchanged: no quote yet here).
      await c.buyer("Please send me the order form.");
      const ran = await c.tool("f2", "send_order_form", { quote: "Q-1" });
      expect(ran.rule).not.toBe("Not agreed yet");
      expect(String(ran.message ?? "")).not.toContain("The order form was NOT sent");
      await c.end();
      // Both calls are recorded with the call's line; the held one as refused.
      const rows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));
      expect(rows.filter((x) => x.name === "send_order_form").map((x) => x.outcome)[0]).toBe("refused");
    });

    it("K2: a number the buyer stated is not lowered on an ambiguous yes; it is when the buyer says it; silent otherwise", async () => {
      const c = await fakeCall();
      await c.startNow();
      const sites = async () => (await readDealState(db, acc, c.leadId))?.fields?.sites?.value;
      const upd = (id: string, value: string) => c.tool(id, "update_deal_state", { ...noUpdate, updates: [{ key: "sites", value, provenance: "buyer" }] });
      await c.buyer("I have two sites.");
      const first = await upd("u1", "2");
      expect(first.kept_as_buyer_said).toBeUndefined();
      expect(first.kept_message).toBeUndefined();
      await c.buyer("Yeah, I guess so. I need a solution.");
      const held = await upd("u2", "1");
      expect(await sites()).toBe("2");
      expect(held.kept_as_buyer_said).toEqual([{ key: "sites", label: "Number of sites", value: "2" }]);
      expect(String(held.kept_message)).toContain("Number of sites stays 2");
      // T1: the full result, with Classic's stage block.
      expect(String(held.stage)).toMatch(/^## Stage now: /);
      await c.buyer("OK, let's start with one site.");
      const lowered = await upd("u3", "1");
      expect(await sites()).toBe("1");
      expect(lowered.kept_as_buyer_said).toBeUndefined();
      await c.end();
    });

    it("K3: create_quote removing an auto-added line is held unless the buyer asked; K4: a refused quote forbids a total", async () => {
      const c = await fakeCall();
      await c.startNow();
      await c.buyer("A restaurant. How much does it cost?");
      // K4: no quote yet (facts missing): what is missing, and no total (Current's message).
      const refused = await c.tool("q0", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 2 }]));
      expect(refused).toMatchObject({ ok: false, rule: "Before-quote fields missing" });
      expect(refused.message).toBe(refusedQuoteMessage(["Business type", "Number of sites"]));
      await c.tool("u1", "update_deal_state", { ...noUpdate, updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }] });
      await c.buyer("It is more than we plan to spend.");
      const held = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 2 }], { remove_auto_added: ["INST-1"] }));
      expect(held).toMatchObject({ ok: false, rule: "Removal not asked" });
      expect(String(held.message)).toContain("The buyer did not ask to remove INST-1");
      expect(c.logs.some((l) => l.endsWith("tool create_quote held: removes a line the buyer did not ask to remove"))).toBe(true);
      await c.buyer("Can we do it without the installation?");
      const ran = await c.tool("q2", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 2 }], { remove_auto_added: ["INST-1"] }));
      expect(ran.rule).not.toBe("Removal not asked");
      // Silent otherwise: a quote made normally carries no refusal wording.
      const ok = await c.tool("q3", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 3 }]));
      expect(ok.ok).toBe(true);
      expect(String(ok.message)).not.toContain("No quote was made");
      await c.end();
    });

    it("K5/K6: a quote made on the call gives the spoken summary, every amount in words (English, then Hebrew)", async () => {
      for (const he of [false, true]) {
        const c = await fakeCall();
        await c.startNow();
        await c.tool("u1", "update_deal_state", { ...noUpdate, updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "2", provenance: "buyer" }] });
        await c.buyer(he ? "כמה זה עולה לשישה חיישנים ושני גייטוויי?" : "How much for six sensors and two gateways?");
        const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }, { sku: "GATEWAY", qty: 2 }]));
        expect(q).toMatchObject({ ok: true, status: "ready" });
        expect(q.message).toBe(guardedQuoteMessage(String(q.quote)));
        // Classic's result otherwise: the totals as the tool gives them (digits), ids kept, no per-line walkthrough.
        expect(q.totals).toMatchObject({ total_today_including_vat: "₪4,500.00", recurring_total_including_vat: "₪106.20/month" });
        expect(q.lines_for_call).toBeUndefined();
        const say = String(q.say_this);
        if (!he) {
          expect(say).toMatch(/^Six Temperature sensors and two Gateways\. That's four thousand five hundred shekels today and one hundred and six shekels and twenty agorot a month, including VAT\./);
          expect(say).not.toContain("forty");
        } else {
          expect(say).toMatch(/^שש יחידות Temperature sensor ושתי יחידות Gateway\. זה ארבעת אלפים וחמש מאות שקלים היום ומאה ושישה שקלים ועשרים אגורות לחודש, כולל מע״מ\./);
        }
        expect(say.replace(/\d+ (December|January|בדצמבר|בינואר)/g, "")).not.toMatch(/\d/);
        await c.end();
      }
    });

    it("K7: the hand-off keeps the call (Current's result); Classic's 'the call ends there' is not in the instructions", async () => {
      const c = await fakeCall();
      await c.startNow();
      expect(c.model.conns[0].cfg.instructions).not.toContain("the call ends there");
      await c.buyer("This is not working for me. Get me a person.");
      const r = await c.tool("h1", "hand_off_to_human", { reason: "upset", summary: "The buyer wants a person.", suggested_reply: "" });
      expect(r.message).toBe(HANDOFF_RESULT_MESSAGE);
      await c.said("Someone from the team will get back to you. Is there anything else I can help with?");
      await c.run(10_000);
      expect(c.engine.isEnded).toBe(false);
      await c.buyer("No, that's fine.");
      expect(c.engine.isEnded).toBe(false);
      const [conv] = await db.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, c.conversationId));
      expect(conv.status).toBe("human");
      await c.end();
    });

    it("K9: the opening line waits for the browser's ready (the Classic opener), at most 3 s", async () => {
      const c = await fakeCall([], { waitForClientAudio: true });
      await c.startNow();
      expect(c.model.conns[0].responses).toHaveLength(0);
      c.engine.onClientMessage({ t: "ready" });
      await c.settle();
      expect(c.model.conns[0].responses).toEqual([expect.stringMatching(/^The call has just connected\. Say your opening line now, in your own voice: "/)]);
      await c.end();
      const late = await fakeCall([], { waitForClientAudio: true });
      await late.startNow();
      await late.run(2_900);
      expect(late.model.conns[0].responses).toHaveLength(0);
      await late.run(200);
      expect(late.model.conns[0].responses).toHaveLength(1);
      expect(late.logs.some((l) => /opening waited \d+ms for the browser's audio \(timeout\)$/.test(l))).toBe(true);
      await late.end();
    });

    it("K10: one agent at a time: the start waits for a chat turn in flight; a live call blocks chat turns", async () => {
      const c = await fakeCall([{ actor: "agent", body: "Hi, this is Ava. How many sites do you have?", ageMs: 30_000 }, { actor: "buyer", body: "Two sites.", ageMs: 10_000 }]);
      const flush = async () => { for (let i = 0; i < 20; i++) await flushAsync(); };
      const started = c.engine.start();
      await c.clock.advance(1_500, flush);
      expect(c.model.conns).toHaveLength(0);
      await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "agent", body: "Got it. What kind of business is it?", language: "en" });
      await c.clock.advance(1_000, flush);
      await started;
      await c.settle();
      expect(c.model.conns).toHaveLength(1);
      expect(c.logs.some((l) => /voice start waited \d+ms for a text turn$/.test(l))).toBe(true);
      expect(await textTurnBlocked(db, acc, c.conversationId, "test")).toBe(true);
      await c.end();
      expect(await textTurnBlocked(db, acc, c.conversationId, "test")).toBe(false);
    });

    it("notes: an order-form note goes in as a note (Classic), never into the instructions; no language note", async () => {
      const c = await fakeCall();
      await c.startNow();
      c.engine.onClientMessage({ t: "context", kind: "order_form", step: "company", label: "Company", event: "opened" });
      await c.run(6_000);
      expect(c.model.conns[0].notes).toEqual([expect.stringContaining("Company details")]);
      await c.buyer("שלום, אני מדבר עברית.");
      expect(c.model.conns[0].notes.some((n) => /now speaks/.test(n))).toBe(false);
      expect(c.model.conns[0].cfg.instructions).not.toContain("### The order form (a note from the app");
      await c.end();
    });
  });

  it("K8: recorded per the account: the rule in the voice block, the notice in the opener once per conversation, rows written", async () => {
    const store = new MemoryRecordingStore();
    const c = await scriptedCall("guarded", { store });
    const cfg = c.model.connections[0].cfg;
    expect(cfg.instructions).toContain(`\n${recordedCallRule()}\n\n### Deal-state fields\n`);
    const opener = c.model.connections[0].sent.responses[0]!;
    expect(opener.split(RECORDING_NOTICE.en)).toHaveLength(2);
    expect(await sessionRow(c.sessionId)).toMatchObject({ recordingState: "recording", recordingNoticeSaid: true });
    await c.run(15_000);
    await c.speak();
    await c.run(30_000);
    await c.end();
    const row = await sessionRow(c.sessionId);
    expect(row.recordingState).toBe("saved");
    expect(row.recordingChunks).toBeGreaterThan(0);
    expect(row.settings).toMatchObject({ engine: "guarded" });
    // A second call on the same conversation: no notice again.
    const again = await scriptedCall("guarded", { store, conversationId: c.conversationId });
    expect(again.model.connections[0].sent.responses[0]).not.toContain(RECORDING_NOTICE.en);
    expect(await sessionRow(again.sessionId)).toMatchObject({ recordingState: "recording", recordingNoticeSaid: false });
    await again.end();
  });

  it("(d) transcripts are stored as said in guarded (a stray marker stays); Current still cleans them", async () => {
    const run = async (engine: "guarded" | "current", markers: "with_text" | "only") => {
      const c = await scriptedCall(engine, { markers });
      await c.run(15_000);
      await c.speak();
      await c.run(15_000);
      await c.end();
      return (await thread(c.conversationId)).filter((m) => m.voiceSessionId);
    };
    const guarded = await run("guarded", "with_text");
    const current = await run("current", "with_text");
    expect(guarded[0].actor).toBe("agent");
    expect(guarded[0].body.startsWith(`${SCRIPTED_MARKER} Hi `)).toBe(true);
    expect(current[0].body.startsWith("Hi ")).toBe(true);
    expect(current.some((m) => m.body.includes(SCRIPTED_MARKER))).toBe(false);
    // The buyer side: noise transcribed as a marker only is stored as heard in guarded, dropped by Current.
    const g2 = await run("guarded", "only");
    const c2 = await run("current", "only");
    expect(g2.filter((m) => m.actor === "buyer").map((m) => m.body)).toContain(SCRIPTED_MARKER);
    expect(c2.filter((m) => m.actor === "buyer")).toHaveLength(0);
    // The live mapper too: raw for guarded, cleaned by default.
    const map = (raw: boolean) => {
      const m = new ServerEventMapper(raw ? { rawTranscripts: true } : {});
      return [...m.map({ type: "audio-transcript-delta", delta: "<no speech detected> Hello", responseId: "r1" } as never), ...m.map({ type: "response-done", responseId: "r1" } as never)]
        .filter((e) => e.type === "agent-transcript").map((e) => (e as { text: string }).text);
    };
    expect(map(true).at(-1)).toBe("<no speech detected> Hello");
    expect(map(false).at(-1)).toBe("Hello");
  });

  it("the relay runs the guarded engine for a guarded session (Current's model, any family), and keeps it on the session", async () => {
    class FakeSocket extends EventEmitter implements VoiceSocket {
      bufferedAmount = 0;
      sent: (string | Uint8Array)[] = [];
      closed: { code?: number } | null = null;
      send(d: string | Uint8Array) { this.sent.push(d); }
      close(code?: number) {
        if (this.closed) return;
        this.closed = { code };
        setImmediate(() => this.emit("close", code, ""));
      }
    }
    const conv = (await startVoiceTestConversation(db, acc, me.id, { scenario: null }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: conv.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "guarded" });
    if (!s.ok) throw new Error(s.reason);
    expect((await sessionRow(s.sessionId)).settings).toEqual({ engine: "guarded" });
    const ws = new FakeSocket();
    const clock = new ManualClock();
    const { lines, log } = memLog();
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await flushAsync(4);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const model = new ScriptedRealtime({ clock });
    const done = handleVoiceSocket(ws, { db, deadlineSec: null, env: SCRIPTED, clock, model, limits: QUIET, log });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: s.sessionId, ticket: s.ticket, waitAudio: true })), false);
    await settle();
    ws.emit("message", Buffer.from(JSON.stringify({ t: "ready" })), false);
    await clock.advance(5_000, settle);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(100, settle);
    await done;
    expect(lines.some((l) => l.endsWith("engine=guarded"))).toBe(true);
    const row = await sessionRow(s.sessionId);
    expect(row.status).toBe("ended");
    expect(row.settings).toMatchObject({ engine: "guarded" });
    // The guarded model side: order_form_status is offered, Classic's voice block is there.
    expect(model.connections[0].cfg.tools.map((x) => x.name)).toContain("order_form_status");
    expect(model.connections[0].cfg.instructions).toContain("- Record each objection while the call is on");
    // A buyer session (not a test) never runs it, even if the field were stored.
    await db.update(voiceSessions).set({ isTest: false }).where(and(eq(voiceSessions.id, s.sessionId)));
  });
});

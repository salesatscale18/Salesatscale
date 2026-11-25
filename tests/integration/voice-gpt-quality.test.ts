/**
 * Voice (test calls): the quote-quantities guard, the GPT tool rules and several tools in one step, through the engine
 * on PGlite with a fake text-output model (GPT-Realtime 2.1 + the ElevenLabs path, the "New" engine's profile) and
 * the scripted speaker. No paid call, no network.
 * - create_quote with a quantity the buyer never gave is refused before the tool runs (refused chip, one log line,
 *   no quote); grounded by the buyer's number, the saved sites, a product ("three in each" × 2 sites), the agent's
 *   number with a yes, or after one refusal the agent's number said aloud (no dead-lock); a buyer call is unaffected;
 * - one response with several calls: every call runs (guards applied to each), every result is sent, the engine asks
 *   for no response itself, the text before the tools is dropped once, nothing is spoken twice, `rt turn` counts one
 *   tool round;
 * - the session: GPT tool rules at the top of the instructions (2.1 and mini), parallel tool calls asked for on 2.1
 *   only, the provider's session-updated logged; none of it on a buyer call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, quotes, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine, type VoiceLimits } from "@/lib/voice/engine";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import type { VoiceLog } from "@/lib/voice/log";
import { quantityNotGiven } from "@/lib/voice/quote-quantities";
import { GPT_TOOL_RULES } from "@/lib/voice-guarded/instructions";
import { rtElevenProfile } from "@/lib/voice-rt-eleven/profile";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };

type Conn = { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { id: string; name: string; result: Record<string, unknown> }[]; responses: (string | undefined)[] };

/** A text-output model whose events the test emits by hand; records everything the engine sends it. */
class FakeTextModel implements RealtimeModel {
  readonly conns: Conn[] = [];
  constructor(readonly modelId: string, readonly mode: "scripted" | "live" = "scripted") {}
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c: Conn = { cfg, emit: onEvent, results: [], responses: [] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined, requestResponse: (t) => void c.responses.push(t), sendNote: () => undefined,
      cancelResponse: () => undefined, sendToolResult: (id, name, result) => void c.results.push({ id, name, result: result as Record<string, unknown> }),
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
  [me] = await db.insert(users).values({ clerkId: "q", email: "q@p.test", firstName: "Quin", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "q-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [{ sku: "SENSOR", name: "Temperature sensor", unit: "unit", plainName: "fridge sensor" }]);
  await seedPricing(db, acc, [{ sku: "SENSOR", oneTime: 45_000, recurring: 1_770 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const memLog = () => {
  const lines: string[] = [];
  const log: VoiceLog = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  return { lines, log };
};
const noUpdate = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };
const facts = (sites: string) => ({ ...noUpdate, updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: sites, provenance: "buyer" }] });
const quoteArgs = (qty: number) => ({ lines: [{ sku: "SENSOR", qty }], discount_percent: 0, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null });

async function call(o: { engine?: "rt_eleven" | "rt_eleven_mini"; buyerCall?: boolean; chat?: string[]; language?: "en" | "he" } = {}) {
  const engineName = o.engine ?? "rt_eleven";
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: o.language ?? "en" }))!;
  for (const body of o.chat ?? []) await db.insert(messages).values({ accountId: acc, conversationId: c.conversationId, actor: "buyer", body, language: "en", createdAt: new Date(Date.now() - 60_000) });
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: engineName });
  if (!s.ok) throw new Error(s.reason);
  // A buyer call: the same engine and model, on a session that is not a test call.
  if (o.buyerCall) await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s.sessionId));
  const clock = new ManualClock(Date.UTC(2026, 10, 25, 10, 0, 0));
  const model = new FakeTextModel(engineName === "rt_eleven" ? "openai/gpt-realtime-2.1" : "openai/gpt-realtime-mini");
  const speaker = new ScriptedSpeaker("elevenlabs/eleven-v4-turbo");
  const { lines: logs, log } = memLog();
  const sent: unknown[] = [];
  const engine = new VoiceEngine({
    db, model, sessionId: s.sessionId, clock, send: (m) => void sent.push(m), log, limits: { ...QUIET, waitForClientAudio: true },
    recording: { store: null, reason: "no store (test)" }, profile: rtElevenProfile(engineName), speaker,
  });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  const conn = () => model.conns.at(-1)!;
  const respond = async (text: string, toolCalls = 0, ms = 100) => {
    conn().emit({ type: "response-started" });
    conn().emit({ type: "response-text", text, toolCalls });
    conn().emit({ type: "turn-done" });
    await run(ms);
  };
  const buyerSays = async (text: string) => {
    conn().emit({ type: "speech-started" });
    conn().emit({ type: "trace", what: "buyer speech stopped" });
    conn().emit({ type: "buyer-transcript", text, final: true });
    await run(50);
  };
  /** One response with these tool calls (and text before them), then the results. */
  const tools = async (calls: { id: string; name: string; args: unknown }[], preText = "") => {
    for (const x of calls) conn().emit({ type: "tool-call", callId: x.id, name: x.name, args: x.args });
    await respond(preText, calls.length, 500);
    return calls.map((x) => conn().results.find((r) => r.id === x.id)?.result);
  };
  const tool = async (id: string, name: string, args: unknown) => (await tools([{ id, name, args }]))[0]!;
  await engine.start();
  await settle();
  engine.onClientMessage({ t: "ready" } as never);
  await run(10);
  await respond("Hello, this is Ava from Acme.");
  await run(2_000);
  return { ...s, conversationId: c.conversationId, leadId: c.leadId, engine, model, speaker, logs, sent, run, conn, respond, buyerSays, tools, tool, end: async () => { engine.onClientMessage({ t: "end" }); await settle(); } };
}

const quoteCount = async (leadId: string) => (await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.accountId, acc), eq(quotes.leadId, leadId)))).length;
const chips = (sent: unknown[], id: string) => sent.filter((m) => (m as { t?: string; id?: string }).t === "tool" && (m as { id?: string }).id === id).map((m) => (m as { status: string }).status);
const qtyLines = (logs: string[]) => logs.filter((l) => / quote quantities: /.test(l)).map((l) => l.replace(/^\[voice\] \S+ /, ""));

describe("quote quantities guard (test calls)", () => {
  it("refused: 1 sensor for 2 sites, the buyer never said how many: no quote, a refused chip, one log line, the item named", async () => {
    const c = await call();
    await c.buyerSays("We run two restaurants and need temperature monitoring.");
    await c.tool("u1", "update_deal_state", facts("2"));
    const r = await c.tool("q1", "create_quote", quoteArgs(1));
    expect(r).toEqual({ ok: false, rule: "Quantity not given", message: quantityNotGiven("fridge sensor", "en").message });
    expect(await quoteCount(c.leadId)).toBe(0);
    expect(chips(c.sent, "q1")).toEqual(["running", "refused"]);
    expect(qtyLines(c.logs)).toEqual(["quote quantities: refused item=SENSOR qty=1"]);
    expect(c.logs.join("\n")).not.toContain("temperature monitoring");
    // The buyer gives the number: the quote goes.
    await c.buyerSays("Three in each.");
    const ok = await c.tool("q2", "create_quote", quoteArgs(6));
    expect(ok).toMatchObject({ ok: true, status: "ready" });
    expect(qtyLines(c.logs)).toEqual(["quote quantities: refused item=SENSOR qty=1", "quote quantities: ok"]);
    await c.end();
  });

  it("grounded by the inherited chat, by the saved sites, by the agent's number with a yes", async () => {
    const chat = await call({ chat: ["Hi, we have 4 fridges at our place."] });
    await chat.tool("u1", "update_deal_state", facts("1"));
    expect(await chat.tool("q1", "create_quote", quoteArgs(4))).toMatchObject({ ok: true });
    // One site grounds 1.
    expect(await chat.tool("q2", "create_quote", quoteArgs(1))).toMatchObject({ ok: true });
    await chat.end();
    const agreed = await call();
    await agreed.buyerSays("We have two sites.");
    await agreed.tool("u1", "update_deal_state", facts("2"));
    await agreed.respond("Most kitchens your size need five sensors. Shall I quote five?");
    await agreed.run(3_000);
    await agreed.buyerSays("Yes, that sounds right.");
    expect(await agreed.tool("q1", "create_quote", quoteArgs(5))).toMatchObject({ ok: true });
    expect(qtyLines(agreed.logs)).toEqual(["quote quantities: ok"]);
    await agreed.end();
  });

  it("no dead-lock: refused once, then the agent's number said aloud and any buyer line: the quote goes", async () => {
    const c = await call();
    await c.buyerSays("We have two sites.");
    await c.tool("u1", "update_deal_state", facts("2"));
    expect(await c.tool("q1", "create_quote", quoteArgs(5))).toMatchObject({ ok: false, rule: "Quantity not given" });
    await c.respond("How many fridges do you have? Most places your size take five sensors.");
    await c.run(3_000);
    await c.buyerSays("I'm not sure, whatever you think is best.");
    expect(await c.tool("q2", "create_quote", quoteArgs(5))).toMatchObject({ ok: true });
    expect(qtyLines(c.logs)).toEqual(["quote quantities: refused item=SENSOR qty=5", "quote quantities: ok"]);
    await c.end();
  });

  it("Hebrew: the refusal in Hebrew; Hebrew number words ground", async () => {
    const c = await call({ language: "he" });
    await c.buyerSays("יש לנו שני סניפים");
    await c.tool("u1", "update_deal_state", facts("2"));
    const r = await c.tool("q1", "create_quote", quoteArgs(1));
    expect(String(r.message)).toContain(quantityNotGiven("fridge sensor", "he").message);
    await c.buyerSays("שלושה בכל סניף");
    expect(await c.tool("q2", "create_quote", quoteArgs(6))).toMatchObject({ ok: true });
    await c.end();
  });

  it("a buyer (non-test) call is unaffected: the same quote runs, no log line", async () => {
    const c = await call({ buyerCall: true });
    await c.buyerSays("We run two restaurants.");
    await c.tool("u1", "update_deal_state", facts("2"));
    expect(await c.tool("q1", "create_quote", quoteArgs(1))).toMatchObject({ ok: true });
    expect(qtyLines(c.logs)).toEqual([]);
    await c.end();
  });
});

describe("several tools in one step", () => {
  it("one response with three calls: all run (guards on each), all results sent, no response asked by the engine, text dropped once, one tool round", async () => {
    const c = await call();
    await c.buyerSays("We have two sites, three fridges in each. Can I get a quote?");
    const before = c.conn().responses.length;
    const [u, f, q] = await c.tools([
      { id: "u1", name: "update_deal_state", args: facts("2") },
      { id: "f1", name: "check_fit", args: { lines: [{ sku: "SENSOR", qty: 6 }], sites: 2 } },
      // Ungrounded in the same batch: refused by its guard while the others run.
      { id: "q1", name: "create_quote", args: quoteArgs(7) },
    ], "One moment, let me check that for you.");
    expect(u).toMatchObject({ ok: true });
    expect(f).toBeTruthy();
    expect(q).toMatchObject({ ok: false, rule: "Quantity not given" });
    expect(c.conn().results.map((r) => r.id)).toEqual(["u1", "f1", "q1"]);
    // The adapter asks for the next response once the batch is done (ToolResponseGate); the engine asks for none.
    expect(c.conn().responses.length).toBe(before);
    expect(c.logs.filter((l) => l.endsWith("rt text before tool dropped len=38 tools=3"))).toHaveLength(1);
    expect(c.speaker.said.some((x) => x.text.includes("One moment"))).toBe(false);
    await c.respond("Six sensors for your two sites, I'll prepare that now.");
    await c.run(4_000);
    expect(c.speaker.said.filter((x) => x.text.startsWith("Six sensors"))).toHaveLength(1);
    expect(c.logs.filter((l) => /trace t=\d+ rt turn think=\d+ms toolRounds=1 /.test(l))).toHaveLength(1);
    await c.end();
  });
});

describe("the session on GPT test calls", () => {
  it("GPT tool rules at the very top (2.1 and mini); parallel tool calls on 2.1 only; session-updated logged", async () => {
    const full = await call();
    const cfg = full.conn().cfg;
    expect(cfg.instructions.startsWith(`${GPT_TOOL_RULES}\n\n`)).toBe(true);
    expect(cfg.parallelToolCalls).toBe(true);
    expect(cfg.logSessionAck).toBe(true);
    expect(full.logs.some((l) => / model connected in \d+ms .* parallelTools=on$/.test(l))).toBe(true);
    await full.end();
    const mini = await call({ engine: "rt_eleven_mini" });
    expect(mini.conn().cfg.instructions.startsWith(`${GPT_TOOL_RULES}\n\n`)).toBe(true);
    expect(mini.conn().cfg.parallelToolCalls).toBeUndefined();
    expect(mini.conn().cfg.logSessionAck).toBe(true);
    await mini.end();
  });

  it("a buyer call: none of it", async () => {
    const c = await call({ buyerCall: true });
    const cfg = c.conn().cfg;
    expect(cfg.instructions).not.toContain(GPT_TOOL_RULES);
    expect(cfg.parallelToolCalls).toBeUndefined();
    expect(cfg.logSessionAck).toBeUndefined();
    await c.end();
  });
});

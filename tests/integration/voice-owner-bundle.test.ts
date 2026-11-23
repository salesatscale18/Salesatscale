/**
 * The owner's voice bundle of 23 Nov 2026 on the engine (Current; the guarded engines run the same code), on PGlite
 * with a fake Gemini-family model the test drives by hand and a hand-moved clock. No paid call.
 * - S1: tools write in the language being spoken (an English call on a Hebrew lead gets an English quote card);
 * - S2: a line at no charge is "free" in lines_for_call, never "₪0.00";
 * - S3: one buyer utterance is one row: a partial closed when the agent started is updated by the whole line; a
 *   running transcript sent again updates it; a new call never touches an earlier call's rows;
 * - S4: the time-limit warning 60 s before and never over the agent's words; at the limit an agent mid-response
 *   finishes (at most 8 s), then the call ends;
 * - S5: a quote for fewer sites or units is held until the buyer asks for it or says yes to the agent's offer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, quotes, rateLimits, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { VoiceEngine, smallerQuoteNotAsked, type VoiceLimits } from "@/lib/voice/engine";
import { ServerEventMapper } from "@/lib/voice/gateway-realtime";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

type Conn = { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; mapper: ServerEventMapper; results: { name: string; result: Record<string, unknown> }[]; responses: (string | undefined)[] };

class FakeModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  /** A Gemini-family stand-in (any "google/" id): non-blocking-capable, no response requests after tool results. */
  readonly modelId = "google/test-live";
  readonly conns: Conn[] = [];
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c: Conn = { cfg, emit: onEvent, mapper: new ServerEventMapper(), results: [], responses: [] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined, sendNote: () => undefined,
      requestResponse: (t) => void c.responses.push(t),
      sendToolResult: (_id, name, result) => void c.results.push({ name, result: structuredClone(result) as Record<string, unknown> }),
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
  [me] = await db.insert(users).values({ clerkId: "ob", email: "ob@p.test", firstName: "Ori", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "ob-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [
    { sku: "SEAT-M", name: "User seat", unit: "seat" },
    { sku: "GUIDE", name: "Setup guide", unit: "item" },
  ]);
  await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }, { sku: "GUIDE", oneTime: 0 }], { userId: me.id });
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const noUpdate = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };
const facts = (sites: string) => ({ ...noUpdate, updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: sites, provenance: "buyer" }] });
const quoteArgs = (lines: { sku: string; qty: number }[], extra: Record<string, unknown> = {}) => ({ lines, discount_percent: 0, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null, ...extra });

async function fakeCall(o: { language?: string; conversationId?: string; limits?: VoiceLimits } = {}) {
  const conversationId = o.conversationId ?? (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: o.language ?? "en" }))!.conversationId;
  const s = await createVoiceSession(db, { accountId: acc, conversationId, userId: me.id, isTest: true }, { env: { VOICE_REALTIME: "scripted" } });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock();
  const model = new FakeModel();
  const logs: string[] = [];
  const sent: unknown[] = [];
  const engine = new VoiceEngine({
    db, model, sessionId: s.sessionId, clock, send: (m) => void sent.push(m), log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(l), error: (l) => void logs.push(l) },
    limits: { env: {}, standbyAfterQuietMs: 600_000, ...o.limits }, recording: { store: null, reason: "test" },
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
  const conn = () => model.conns.at(-1)!;
  const rows = async () => (await db.select({ actor: messages.actor, body: messages.body }).from(messages)
    .where(and(eq(messages.voiceSessionId, s.sessionId), eq(messages.accountId, acc))).orderBy(asc(messages.createdAt))).map((m) => [m.actor, m.body]);
  return {
    ...s, conversationId, engine, model, clock, logs, sent, settle, run, conn, rows,
    emit: (e: RealtimeEvent) => conn().emit(e),
    sdk: (e: Record<string, unknown>) => { for (const x of conn().mapper.map({ raw: null, ...e } as never)) conn().emit(x); },
    said: async (text: string) => {
      conn().emit({ type: "audio", pcm: new Uint8Array(480) });
      conn().emit({ type: "agent-transcript", text, final: true });
      conn().emit({ type: "turn-done" });
      await run(300);
    },
    buyer: async (text: string) => { engine.onClientMessage({ t: "text", text }); await run(300); },
    tool: async (callId: string, name: string, args: unknown) => {
      conn().emit({ type: "tool-call", callId, name, args });
      await run(500);
      return conn().results.filter((r) => r.name === name).at(-1)!.result;
    },
    end: async () => { engine.onClientMessage({ t: "end" }); await settle(); },
  };
}

describe("S1: tools write in the language being spoken", () => {
  it("an English call on a Hebrew lead: the quote card is stored in English; a Hebrew line brings Hebrew back", async () => {
    const c = await fakeCall({ language: "he" });
    await c.buyer("We are a restaurant with two sites. How much for two seats?");
    await c.tool("u1", "update_deal_state", facts("2"));
    const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 2 }]));
    expect(q.ok).toBe(true);
    const card = (await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent")))).filter((m) => !m.voiceSessionId);
    expect(card.map((m) => m.language)).toEqual(["en"]);
    await c.buyer("תוסיף עוד מושב אחד בבקשה");
    await c.tool("q2", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 3 }]));
    const cards = (await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent"))).orderBy(asc(messages.createdAt))).filter((m) => !m.voiceSessionId);
    expect(cards.map((m) => m.language)).toEqual(["en", "he"]);
    await c.end();
  });
});

describe("S2: a line at no charge is free", () => {
  it("lines_for_call says free (Hebrew: חינם), never ₪0.00", async () => {
    for (const [he, word] of [[false, "free"], [true, "חינם"]] as const) {
      const c = await fakeCall({ language: he ? "he" : "en" });
      await c.buyer(he ? "מסעדה עם שני סניפים" : "A restaurant with two sites.");
      await c.tool("u1", "update_deal_state", facts("2"));
      const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 2 }, { sku: "GUIDE", qty: 1 }]));
      const lines = q.lines_for_call as { item: string; unit_price: string; line_total: string }[];
      const guide = lines.find((l) => l.item === "Setup guide")!;
      expect(guide).toMatchObject({ unit_price: word, line_total: word });
      expect(JSON.stringify(lines)).not.toMatch(/₪0\.00/);
      expect(lines.find((l) => l.item === "User seat")!.line_total).toMatch(/₪/);
      await c.end();
    }
  });
});

describe("S3: one buyer utterance, one row", () => {
  it("partial then whole: the row closed when the agent started is updated by the completed transcript", async () => {
    const c = await fakeCall();
    await c.said("How do you check the fridges today?");
    c.sdk({ type: "transcript-fragment", speaker: "user", delta: "I check them by hand", startMs: 0, endMs: 1 });
    // The agent starts: the streamed part is closed as the buyer's line.
    c.sdk({ type: "audio-delta", responseId: "r2", itemId: "i2", delta: "AAAA" });
    await c.run(300);
    expect((await c.rows()).filter((r) => r[0] === "buyer")).toEqual([["buyer", "I check them by hand"]]);
    // Six seconds later the whole line (17:46:43 and 17:46:49 on the live call).
    await c.run(6_000);
    c.sdk({ type: "input-transcription-completed", itemId: "u1", transcript: "I check them by hand every morning." });
    await c.run(300);
    c.sdk({ type: "audio-transcript-delta", responseId: "r2", itemId: "i2", delta: "Got it." });
    c.sdk({ type: "response-done", responseId: "r2", status: "completed" });
    await c.run(300);
    expect((await c.rows()).filter((r) => r[0] === "buyer")).toEqual([["buyer", "I check them by hand every morning."]]);
    expect(c.logs.some((l) => l.endsWith("buyer line revised: a later transcript of the same line updated its row"))).toBe(true);
    // The browser got the update on the same line id.
    const ids = c.sent.filter((m): m is { t: string; role: string; final: boolean; id: string } => (m as { t?: string }).t === "transcript" && (m as { role?: string }).role === "buyer" && (m as { final?: boolean }).final === true).map((m) => m.id);
    expect(new Set(ids).size).toBe(1);
    await c.end();
  });

  it("a cumulative transcript (the same item, or the line grown moments later) is one row; a repeated short answer is two", async () => {
    const c = await fakeCall();
    await c.said("How many sites?");
    c.sdk({ type: "input-transcription-completed", itemId: "u1", transcript: "Two sites." });
    await c.run(300);
    c.sdk({ type: "input-transcription-completed", itemId: "u1", transcript: "Two sites. Three fridges in each." });
    await c.run(300);
    // Another item id, the same line grown a moment later: still that line.
    c.sdk({ type: "input-transcription-completed", itemId: "u2", transcript: "Two sites. Three fridges in each. And a freezer." });
    await c.run(300);
    expect((await c.rows()).filter((r) => r[0] === "buyer")).toEqual([["buyer", "Two sites. Three fridges in each. And a freezer."]]);
    await c.said("Shall I prepare the quote?");
    c.sdk({ type: "input-transcription-completed", itemId: "u3", transcript: "Yes." });
    await c.run(300);
    await c.said("And the order form?");
    c.sdk({ type: "input-transcription-completed", itemId: "u4", transcript: "Yes." });
    await c.run(300);
    expect((await c.rows()).filter((r) => r[0] === "buyer").map((r) => r[1])).toEqual(["Two sites. Three fridges in each. And a freezer.", "Yes.", "Yes."]);
    await c.end();
  });

  it("a new call never re-stores or changes the lines of an earlier call", async () => {
    const one = await fakeCall();
    one.sdk({ type: "input-transcription-completed", itemId: "u1", transcript: "Two sites." });
    await one.run(300);
    await one.end();
    const two = await fakeCall({ conversationId: one.conversationId });
    await two.run(1_000);
    expect(await two.rows()).toEqual([]);
    // The same words grown, on the new call: a row of the new call; the earlier call's row is as it was.
    two.sdk({ type: "input-transcription-completed", itemId: "u1", transcript: "Two sites. Three fridges in each." });
    await two.run(300);
    expect(await two.rows()).toEqual([["buyer", "Two sites. Three fridges in each."]]);
    expect(await one.rows()).toEqual([["buyer", "Two sites."]]);
    await two.end();
  });
});

describe("S4: the time limit", () => {
  const limits: VoiceLimits = { deadlineSec: 120 };
  const ended = async (id: string) => (await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)))[0];

  it("warned 60 s before; the warning waits for the agent's response; at the limit the agent finishes, then the call ends", async () => {
    const c = await fakeCall({ limits });
    const warned = () => c.conn().responses.filter((r) => /time limit/.test(r ?? "")).length;
    await c.run(58_000);
    // The agent starts speaking just before the warning is due.
    c.emit({ type: "audio", pcm: new Uint8Array(4800) });
    await c.run(3_000);
    expect(warned()).toBe(0);
    expect(c.sent.some((m) => (m as { kind?: string }).kind === "limit_soon")).toBe(false);
    c.emit({ type: "agent-transcript", text: "So for two sites you need six sensors.", final: true });
    c.emit({ type: "turn-done" });
    await c.run(300);
    // Right after its response: the warning (61.3 s into a 120 s call).
    expect(warned()).toBe(1);
    expect(c.sent.filter((m) => (m as { kind?: string }).kind === "limit_soon")).toHaveLength(1);
    await c.said("We're almost out of time. We can continue in the chat.");
    // Mid-response at the limit: not cut.
    await c.run(57_000);
    // 118.6 s: the agent speaks; the limit (120 s) comes while it does.
    c.emit({ type: "audio", pcm: new Uint8Array(4800) });
    await c.run(4_000);
    expect(c.engine.isEnded).toBe(false);
    expect(c.logs.some((l) => l.endsWith("time limit: the agent finishes its response first (at most 8s)"))).toBe(true);
    c.emit({ type: "agent-transcript", text: "Thank you, I'll send the details in the chat.", final: true });
    c.emit({ type: "turn-done" });
    await c.run(300);
    expect(c.engine.isEnded).toBe(true);
    const row = await ended(c.sessionId);
    expect(row.endReason).toBe("limit");
    expect(row.durationSec).toBe(123);
    // The whole sentence is stored (not cut).
    expect((await c.rows()).at(-1)).toEqual(["agent", "Thank you, I'll send the details in the chat."]);
  });

  it("an agent that keeps talking past the limit is ended 8 s after it; an idle agent at the limit ends at once", async () => {
    const c = await fakeCall({ limits });
    await c.run(119_000);
    c.emit({ type: "audio", pcm: new Uint8Array(4800) });
    await c.run(1_000);
    expect(c.engine.isEnded).toBe(false);
    for (let i = 0; i < 7; i++) {
      c.emit({ type: "audio", pcm: new Uint8Array(4800) });
      await c.run(1_000);
    }
    expect(c.engine.isEnded).toBe(false);
    await c.run(1_000);
    expect(c.engine.isEnded).toBe(true);
    expect((await ended(c.sessionId)).durationSec).toBe(128);
    const idle = await fakeCall({ limits });
    await idle.run(120_000);
    expect(idle.engine.isEnded).toBe(true);
    expect((await ended(idle.sessionId)).durationSec).toBe(120);
  });

  it("a call under two minutes keeps the 45 s warning", async () => {
    const c = await fakeCall({ limits: { deadlineSec: 100 } });
    await c.run(54_000);
    expect(c.conn().responses.filter((r) => /time limit/.test(r ?? ""))).toHaveLength(0);
    await c.run(1_000);
    expect(c.conn().responses.filter((r) => /time limit/.test(r ?? ""))).toHaveLength(1);
    await c.end();
  });
});

describe("S5: a smaller quote needs the buyer's ask first (Current)", () => {
  it("fewer sites than the buyer said: held on a hedged yes to 'starting with one site', made after 'yes please' to the question", async () => {
    const c = await fakeCall();
    const quoteCount = async () => (await db.select({ id: quotes.id }).from(quotes).where(eq(quotes.accountId, acc))).length;
    const before = await quoteCount();
    await c.buyer("We are a restaurant with two sites.");
    await c.tool("u1", "update_deal_state", facts("2"));
    await c.said("Would starting with one site help?");
    await c.buyer("Yeah, I guess so. I need a solution.");
    const held = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 1 }], { sites: 1 }));
    expect(held).toMatchObject({ ok: false, rule: "Smaller quote not asked" });
    expect(String(held.message)).toContain(smallerQuoteNotAsked("1 site").message);
    expect(String(held.message)).not.toMatch(/attempt|step|rule/i);
    expect(c.logs.some((l) => l.endsWith("tool create_quote held: a smaller quote the buyer did not ask for"))).toBe(true);
    expect(await quoteCount()).toBe(before);
    await c.said("Shall I prepare a quote for one site?");
    await c.buyer("yes please");
    const made = await c.tool("q2", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 1 }], { sites: 1 }));
    expect(made.ok).toBe(true);
    await c.end();
  });

  it("fewer units than the latest quote: held on a plain 'ok', made on 'make it two seats'; the same or more: no hold", async () => {
    const c = await fakeCall();
    await c.buyer("A restaurant, one site, three seats please.");
    await c.tool("u1", "update_deal_state", facts("1"));
    expect((await c.tool("q1", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 3 }]))).ok).toBe(true);
    await c.said("Does that look right?");
    await c.buyer("Ok.");
    expect(await c.tool("q2", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 2 }]))).toMatchObject({ ok: false, rule: "Smaller quote not asked" });
    await c.buyer("Make it two seats.");
    expect((await c.tool("q3", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 2 }]))).ok).toBe(true);
    await c.buyer("Ok.");
    expect((await c.tool("q4", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 4 }]))).ok).toBe(true);
    await c.end();
  });
});

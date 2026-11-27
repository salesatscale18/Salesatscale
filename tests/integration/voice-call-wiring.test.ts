/**
 * Call wiring (owner-approved, 27 Nov 2026) on the guarded engine, on PGlite with a fake realtime model whose tool
 * calls the test emits by hand. No paid call.
 * A1 (every call): no internal id (create_quote's quote_id / quote_message_id, any uuid) in a result the model gets;
 *    the stored rows and the browser's messages keep them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, quotes, rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import type { PlaybookWithOffers, StoredOffer } from "@/lib/agent/offer-settings";
import { VoiceEngine, type VoiceLimits, type VoiceProfile } from "@/lib/voice/engine";
import { GUARDED_PROFILE, guardedQuoteMessage } from "@/lib/voice-guarded/profile";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import type { VoiceLog } from "@/lib/voice/log";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A model whose events the test emits by hand; records every tool result the engine sends it, per connection. */
class FakeModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  readonly modelId = "openai/gpt-realtime-mini";
  readonly conns: { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { name: string; result: Record<string, unknown> }[] }[] = [];
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c = { cfg, emit: onEvent, results: [] as { name: string; result: Record<string, unknown> }[] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: () => undefined, close: () => undefined, requestResponse: () => undefined, sendNote: () => undefined,
      sendToolResult: (_id, name, result) => void c.results.push({ name, result: structuredClone(result) as Record<string, unknown> }),
    };
  }
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
/** A catalog that ties no item to sites. */
let acc: string;

async function account(name: string): Promise<string> {
  const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `w-${name.toLowerCase()}@x.test` });
  if (!p.ok) throw new Error();
  const id = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, id);
  return id;
}

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  [me] = await db.insert(users).values({ clerkId: "w", email: "w@p.test", firstName: "Wi", role: "super_admin" }).returning();
  acc = await account("Acme");
  await seedCatalog(db, acc, [
    { sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" },
    { sku: "SENSOR", name: "Temperature sensor", unit: "unit", plainName: "temperature sensor" },
  ]);
  await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }, { sku: "SENSOR", oneTime: 45_000, recurring: 1_770 }], { userId: me.id });
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const noUpdate = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };
const quoteArgs = (lines: { sku: string; qty: number }[], extra: Record<string, unknown> = {}) => ({ lines, discount_percent: 0, offer: null, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null, ...extra });
const basics = (sites = "1") => ({ ...noUpdate, updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: sites, provenance: "buyer" }] });

const memLog = () => {
  const lines: string[] = [];
  const log: VoiceLog = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  return { lines, log };
};

/** A call on the guarded engine (a test call unless `buyer`), driven by hand. */
async function fakeCall(o: { accountId?: string; buyer?: boolean; profile?: VoiceProfile | null } = {}) {
  const accountId = o.accountId ?? acc;
  const c = (await startVoiceTestConversation(db, accountId, me.id, { scenario: null }))!;
  const profile = o.profile === undefined ? GUARDED_PROFILE : o.profile;
  const s = await createVoiceSession(db, { accountId, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, ...(profile ? { engine: "guarded" as const } : {}) });
  if (!s.ok) throw new Error(s.reason);
  // A buyer call: the same session, not a test.
  if (o.buyer) await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s.sessionId));
  const clock = new ManualClock();
  const model = new FakeModel();
  const { lines: logs, log } = memLog();
  const sent: Record<string, unknown>[] = [];
  const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, send: (m) => void sent.push(m as Record<string, unknown>), log, limits: QUIET, recording: { store: null, reason: "test" }, ...(profile ? { profile } : {}) });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  await engine.start();
  await settle();
  return {
    ...s, conversationId: c.conversationId, leadId: c.leadId, clock, model, engine, logs, sent, settle, run,
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
type Call = Awaited<ReturnType<typeof fakeCall>>;

const storedRows = (conversationId: string) => db.select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));

describe("A1: no internal id reaches the model (every call on the guarded engine)", () => {
  for (const buyer of [false, true]) {
    it(`${buyer ? "a buyer call" : "a test call"}: create_quote, send_order_form, update_deal_state and check_offer results carry no uuid; rows and the browser keep them`, async () => {
      const before = (await ensureDraftVersion(db, acc)).playbook;
      const offers: StoredOffer[] = [{ type: "general", on: true, percentBp: 500 }];
      await saveDraftPlaybook(db, acc, { ...before, maxDiscountBp: 500, offers } as PlaybookWithOffers);
      try {
        const c: Call = await fakeCall({ buyer });
        const u = await c.tool("u1", "update_deal_state", basics());
        await c.buyer("How much for six sensors?");
        const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }]));
        expect(q, JSON.stringify(q)).toMatchObject({ ok: true, status: "ready" });
        expect(q.quote_id).toBeUndefined();
        expect(q.quote_message_id).toBeUndefined();
        expect(String(q.quote)).toMatch(/^Q-\d+ v1$/);
        expect(typeof q.say_this).toBe("string");
        await c.said("That is the quote. Shall I send the order form?");
        await c.buyer("That's a bit much, can you do anything on the price?");
        await c.tool("o0", "update_deal_state", { ...noUpdate, objection: { play: "too_expensive", buyer_words: "a bit much", step: 4, attempt: true, status: "open" } });
        const offer = await c.tool("o1", "check_offer", { quote: String(q.quote).split(" ")[0], reason: "next", lines: null, sites: null });
        expect(offer, JSON.stringify(offer)).toMatchObject({ ok: true });
        await c.buyer("OK. Yes, please send me the order form.");
        const f = await c.tool("f1", "send_order_form", { quote: String(q.quote).split(" ")[0] });
        expect(f, JSON.stringify(f)).toMatchObject({ ok: true, link: "shown in the chat" });
        for (const r of [u, q, offer, f]) expect(JSON.stringify(r)).not.toMatch(UUID);
        for (const r of c.model.conns.flatMap((x) => x.results)) expect(JSON.stringify(r.result), r.name).not.toMatch(UUID);
        // The browser was told the quote card's message id; the stored row keeps both ids.
        const card = c.sent.find((m) => m.t === "message");
        expect(String(card?.messageId)).toMatch(UUID);
        await c.end();
        const made = (await storedRows(c.conversationId)).find((x) => x.name === "create_quote")!;
        const stored = made.result as { quote_id?: string; quote_message_id?: string };
        expect(stored.quote_id).toMatch(UUID);
        expect(stored.quote_message_id).toBe(card?.messageId);
        const [m] = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.id, String(card?.messageId))));
        expect(m.body).toMatch(/Quote Q-\d+/);
      } finally {
        await saveDraftPlaybook(db, acc, before);
      }
    });
  }

  it("send_order_form asked with the quote's internal id still sends it (voiceToolArgs repairs it)", async () => {
    const c = await fakeCall();
    await c.tool("u1", "update_deal_state", basics());
    await c.buyer("Six sensors please.");
    const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }]));
    expect(q.ok).toBe(true);
    const [row] = await db.select({ id: quotes.id }).from(quotes).where(eq(quotes.leadId, c.leadId));
    await c.buyer("Yes, please send me the order form.");
    const f = await c.tool("f1", "send_order_form", { quote: row.id });
    expect(f, JSON.stringify(f)).toMatchObject({ ok: true, link: "shown in the chat" });
    await c.end();
  });
});

describe("A2: the current step on every tool result (test calls; CALL_WIRING_V2_FOR_BUYER_CALLS off)", () => {
  const firstLine = (r: Record<string, unknown>) => String(r.stage ?? "").split("\n")[0];

  it("after search_catalog, check_fit, create_quote and check_offer: the full block when the stage changed, else one short line", async () => {
    const before = (await ensureDraftVersion(db, acc)).playbook;
    await saveDraftPlaybook(db, acc, { ...before, maxDiscountBp: 500, offers: [{ type: "general", on: true, percentBp: 500 }] } as PlaybookWithOffers);
    try {
      const c = await fakeCall();
      // The first result of the connection gets the full block (none delivered yet).
      const s1 = await c.tool("s1", "search_catalog", { query: "sensor" });
      expect(s1.ok).toBe(true);
      expect(firstLine(s1)).toMatch(/^## Stage now: \d /);
      expect(String(s1.stage)).toContain("\nDo: ");
      // Nothing changed: one short line.
      const s2 = await c.tool("s2", "search_catalog", { query: "seat" });
      expect(s2.stage).toBe(`unchanged: ${firstLine(s1).replace("## Stage now: ", "")}`);
      // update_deal_state keeps its own block (once, never a second one), and counts as delivered.
      const u = await c.tool("u1", "update_deal_state", { ...basics(), price_asked: true });
      expect(firstLine(u)).toBe("## Stage now: 4 Quote and close");
      expect(String(u.stage).match(/## Stage now/g)).toHaveLength(1);
      await c.buyer("Six sensors, please. How much is that?");
      const fit = await c.tool("c1", "check_fit", { lines: [{ sku: "SENSOR", qty: 6 }], sites: 1 });
      expect(fit.ok).toBe(true);
      expect(fit.stage).toBe("unchanged: 4 Quote and close");
      // The quote is made: the model is told it is at 5 Order form, with its Do line; say_this and its message first.
      const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }]));
      expect(q).toMatchObject({ ok: true, status: "ready", message: guardedQuoteMessage(String(q.quote)) });
      expect(String(q.stage)).toMatch(/^## Stage now: 5 Order form\n/);
      expect(String(q.stage)).toContain("\nDo: if the buyer agrees");
      const keys = Object.keys(q);
      expect(keys.indexOf("message")).toBeLessThan(keys.indexOf("stage"));
      expect(keys.indexOf("say_this")).toBeLessThan(keys.indexOf("stage"));
      expect(keys.at(-1)).toBe("stage");
      await c.said("That is the quote. Shall I send the order form?");
      await c.buyer("That's a bit much, can you do anything on the price?");
      await c.tool("o0", "update_deal_state", { ...noUpdate, objection: { play: "too_expensive", buyer_words: "a bit much", step: 4, attempt: true, status: "open" } });
      const offer = await c.tool("o1", "check_offer", { quote: String(q.quote).split(" ")[0], reason: "next", lines: null, sites: null });
      expect(offer.ok).toBe(true);
      expect(offer.stage).toBe("unchanged: 5 Order form");
      await c.end();
      // The stored rows are the tools' own results: no stage on them.
      for (const row of await storedRows(c.conversationId)) {
        if (row.name !== "update_deal_state") expect((row.result as Record<string, unknown>).stage, row.name).toBeUndefined();
      }
    } finally {
      await saveDraftPlaybook(db, acc, before);
    }
  });

  it("a refused tool carries the step too (the quantities guard, the order form not agreed)", async () => {
    const c = await fakeCall();
    await c.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
    await c.buyer("We have two restaurants. How much would it cost?");
    const r = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 5 }]));
    expect(r).toMatchObject({ ok: false, rule: "Quantity not given" });
    expect(r.stage).toBe("unchanged: 4 Quote and close");
    const f = await c.tool("f1", "send_order_form", { quote: "Q-1" });
    expect(f.ok).toBe(false);
    expect(f.stage).toBe("unchanged: 4 Quote and close");
    await c.end();
  });

  it("a reconnect starts with no block delivered: the first result after it gets the full block again", async () => {
    const c = await fakeCall();
    await c.said("Hi, this is Ava from Acme. How do you keep track of your fridges today?");
    const a = await c.tool("s1", "search_catalog", { query: "sensor" });
    expect(firstLine(a)).toMatch(/^## Stage now: /);
    expect((await c.tool("s2", "search_catalog", { query: "sensor" })).stage).toMatch(/^unchanged: /);
    c.model.conns.at(-1)!.emit({ type: "going-away" });
    await c.run(3_000);
    expect(c.model.conns).toHaveLength(2);
    const b = await c.tool("s3", "search_catalog", { query: "sensor" });
    expect(b.stage).toBe(a.stage);
    expect((await c.tool("s4", "search_catalog", { query: "sensor" })).stage).toMatch(/^unchanged: /);
    await c.end();
  });

  it("a buyer call: no step on any result but update_deal_state's own block (as before)", async () => {
    const c = await fakeCall({ buyer: true });
    const s = await c.tool("s1", "search_catalog", { query: "sensor" });
    expect(s.ok).toBe(true);
    expect(s.stage).toBeUndefined();
    const u = await c.tool("u1", "update_deal_state", { ...basics(), price_asked: true });
    expect(firstLine(u)).toBe("## Stage now: 4 Quote and close");
    await c.buyer("Six sensors, please.");
    const fit = await c.tool("c1", "check_fit", { lines: [{ sku: "SENSOR", qty: 6 }], sites: 1 });
    const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }]));
    expect(q.ok).toBe(true);
    for (const r of [fit, q]) expect(r.stage).toBeUndefined();
    expect(c.logs.some((l) => /stage not attached/.test(l))).toBe(false);
    await c.end();
  });
});

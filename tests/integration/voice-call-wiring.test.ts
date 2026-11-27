/**
 * Call wiring (owner-approved, 27 Nov 2026) on the guarded engine, on PGlite with a fake realtime model whose tool
 * calls the test emits by hand. No paid call.
 * A1 (every call): no internal id (create_quote's quote_id / quote_message_id, any uuid) in a result the model gets;
 *    the stored rows and the browser's messages keep them.
 * A2 (test calls; CALL_WIRING_V2_FOR_BUYER_CALLS off): the current step on every tool result.
 * A3 (test calls): what a quote needs in the stage block; the guards' refusals in tighter words (English, Hebrew);
 *    a catalog with no site data lets the site count ground no quantity (the scripted agent asks for it first).
 * A4 (test calls): the quote flow: search_catalog gives no money, the stage says recommend / quote straight away,
 *    create_quote checks the fit and says why when it does not.
 * Buyer calls: everything but A1 exactly as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { messages, quotes, rateLimits, toolCalls, users, voiceSessions, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, saveDraftPlaybook } from "@/lib/agent/service";
import type { PlaybookWithOffers, StoredOffer } from "@/lib/agent/offer-settings";
import { fitRefusedMessage, removalKeepLine, removalNotAsked, SEARCH_PRICES_FOR_CALL, smallerQuoteHold, smallerQuoteNotAsked, VoiceEngine, type VoiceLimits, type VoiceProfile } from "@/lib/voice/engine";
import { quantityNotGiven } from "@/lib/voice/quote-quantities";
import { QUOTE_NEEDS_LINE } from "@/lib/voice-guarded/stage-hints";
import { micPcm, ScriptedRealtime } from "@/lib/voice/scripted-realtime";
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
/** A catalog with site data (as the Polar demo): a hub per site for the sensors, installation added per site. */
let accSites: string;

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
  accSites = await account("Polar");
  await seedCatalog(db, accSites, [
    { sku: "SNS-200", name: "Wireless fridge sensor", unit: "unit", plainName: "wireless fridge sensor" },
    { sku: "GW-10", name: "Site gateway", unit: "unit", plainName: "kitchen hub" },
    { sku: "INST-1", name: "Installation", unit: "site", kind: "service", plainName: "installation" },
  ], [
    { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
    { kind: "auto_add", sku: "INST-1", whenAnyOf: ["GW-10"], qty: "sites", removable: true },
  ]);
  await seedPricing(db, accSites, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }, { sku: "INST-1", oneTime: 25_000 }], { userId: me.id });
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
async function fakeCall(o: { accountId?: string; buyer?: boolean; profile?: VoiceProfile | null; language?: "en" | "he" } = {}) {
  const accountId = o.accountId ?? acc;
  const c = (await startVoiceTestConversation(db, accountId, me.id, { scenario: null, ...(o.language ? { language: o.language } : {}) }))!;
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
    // What is not given yet changed (the five sensors the model named): the full block again, saying so.
    expect(String(r.stage)).toMatch(/^## Stage now: 4 Quote and close\n/);
    expect(String(r.stage)).toContain("Not given yet: how many temperature sensor. Ask that before you quote.");
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

describe("A3 (a): the stage block says what a quote needs (test calls)", () => {
  it("stages 2-4: the rule, the items not given yet (same checks as the guard), the per-site item to keep; gone once the buyer gives the number", async () => {
    const c = await fakeCall({ accountId: accSites });
    await c.buyer("We have two cafés and we write the temperatures on paper. How much would it cost?");
    const u = await c.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
    const stage = String(u.stage);
    expect(stage).toMatch(/^## Stage now: 4 Quote and close\n/);
    // Nothing named yet: the rule without a list, and the installation line.
    expect(stage).toContain(`\n${QUOTE_NEEDS_LINE}\n`);
    expect(stage).not.toContain("Not given yet");
    expect(stage.endsWith("\nInstallation is added automatically for each site: keep it; do not offer to remove it unless the buyer asks.")).toBe(true);
    // The model names ten sensors (never said) and two hubs (one per site): only the sensors are listed; the block
    // changed, so it comes in full.
    const fit = await c.tool("c1", "check_fit", { lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }], sites: 2 });
    expect(String(fit.stage)).toMatch(/^## Stage now: 4 Quote and close\n/);
    expect(String(fit.stage)).toContain(`${QUOTE_NEEDS_LINE} Not given yet: how many wireless fridge sensor. Ask that before you quote.`);
    expect(String(fit.stage)).not.toContain("kitchen hub. Ask");
    // Same again: unchanged.
    expect((await c.tool("c2", "check_fit", { lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }], sites: 2 })).stage).toBe("unchanged: 4 Quote and close");
    // The buyer gives the number: the list is gone (the full block once more, without it).
    await c.buyer("12 fridges in total.");
    const fit2 = await c.tool("c3", "check_fit", { lines: [{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 2 }], sites: 2 });
    expect(String(fit2.stage)).toContain(`\n${QUOTE_NEEDS_LINE}\n`);
    expect(String(fit2.stage)).not.toContain("Not given yet");
    // The quote is made: stage 5 carries none of it.
    const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 2 }], { sites: 2 }));
    expect(q, JSON.stringify(q)).toMatchObject({ ok: true, status: "ready" });
    expect(String(q.stage)).toMatch(/^## Stage now: 5 Order form\n/);
    expect(String(q.stage)).not.toContain("Before create_quote");
    expect(String(q.stage)).not.toContain("added automatically");
    await c.end();
  });

  it("a buyer call: update_deal_state's block as before (no quote-needs lines)", async () => {
    const c = await fakeCall({ accountId: accSites, buyer: true });
    const u = await c.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
    expect(String(u.stage)).toMatch(/^## Stage now: 4 Quote and close\n/);
    expect(String(u.stage)).not.toContain("Before create_quote");
    expect(String(u.stage)).not.toContain("added automatically");
    expect(String(u.stage).endsWith("Prices: allowed. Take every number from the tools.")).toBe(true);
    await c.end();
  });
});

describe("A3 (b): the guards' refusals in words the model cannot read aloud or turn into an offer (test calls)", () => {
  it("removal guard: keep the per-site installation line (English and Hebrew); a buyer call keeps the old text", async () => {
    for (const language of ["en", "he"] as const) {
      const c = await fakeCall({ accountId: accSites, language });
      await c.buyer(language === "he" ? "יש לנו שני בתי קפה עם שנים עשר מקררים, 12 בסך הכל." : "We have two cafés with 12 fridges in total.");
      await c.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
      await c.buyer(language === "he" ? "זה יותר ממה שתכננו להוציא." : "It is more than we plan to spend.");
      const held = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 2 }], { sites: 2, remove_auto_added: ["INST-1"] }));
      expect(held).toMatchObject({ ok: false, rule: "Removal not asked" });
      const want = removalKeepLine(["installation"], true, language).message;
      expect(String(held.message).startsWith(want)).toBe(true);
      expect(String(held.message)).not.toMatch(/\boffer that option\b/);
      await c.end();
    }
    const b = await fakeCall({ accountId: accSites, buyer: true });
    await b.buyer("We have two cafés with 12 fridges in total.");
    await b.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
    await b.buyer("It is more than we plan to spend.");
    const old = await b.tool("q1", "create_quote", quoteArgs([{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 2 }], { sites: 2, remove_auto_added: ["INST-1"] }));
    expect(old.message).toBe(removalNotAsked(["INST-1"]).message);
    await b.end();
  });

  it("quantities and smaller-quote guards: the v2 texts on a test call, the old ones on a buyer call", async () => {
    for (const buyer of [false, true]) {
      const c = await fakeCall({ buyer });
      await c.buyer("A restaurant with two sites. How much for sensors?");
      await c.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
      const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 5 }]));
      expect(q.message).toBe(quantityNotGiven("temperature sensor", "en", { v2: !buyer }).message);
      await c.buyer("Three in each.");
      expect(await c.tool("q2", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }], { sites: 2 }))).toMatchObject({ ok: true });
      await c.said("Would starting with one site help?");
      await c.buyer("Yeah, I guess so. I need a solution.");
      const smaller = await c.tool("q3", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 3 }], { sites: 1 }));
      expect(smaller).toMatchObject({ ok: false, rule: "Smaller quote not asked" });
      const what = "1 site, 3 × Temperature sensor";
      expect(smaller.message).toBe(buyer ? smallerQuoteNotAsked(what).message : smallerQuoteHold(what, "en").message);
      await c.end();
    }
  });
});

describe("A3 (c): no site data, no grounding by the site count (test calls)", () => {
  it("one location does not ground one sensor on a test call; it still does on a buyer call; a product with the site count still grounds", async () => {
    const t1 = await fakeCall();
    await t1.buyer("We have one location. How much would it cost?");
    await t1.tool("u1", "update_deal_state", { ...basics("1"), price_asked: true });
    expect(await t1.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 1 }], { sites: 1 }))).toMatchObject({ ok: false, rule: "Quantity not given" });
    expect(t1.logs.some((l) => l.endsWith("quote quantities: refused item=SENSOR qty=1"))).toBe(true);
    await t1.end();
    const b = await fakeCall({ buyer: true });
    await b.buyer("We have one location. How much would it cost?");
    await b.tool("u1", "update_deal_state", { ...basics("1"), price_asked: true });
    expect(await b.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 1 }], { sites: 1 }))).toMatchObject({ ok: true, status: "ready" });
    await b.end();
    const t2 = await fakeCall();
    await t2.buyer("We have two sites, three fridges in each.");
    await t2.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
    expect(await t2.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }], { sites: 2 }))).toMatchObject({ ok: true });
    await t2.end();
  });

  /** The scripted ready_buyer call (lib/voice/scripted-realtime.ts) on the catalog with no site data. */
  async function scriptedReadyBuyer(buyer: boolean) {
    const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: "ready_buyer", language: "en" }))!;
    const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, engine: "guarded" });
    if (!s.ok) throw new Error(s.reason);
    if (buyer) await db.update(voiceSessions).set({ isTest: false }).where(eq(voiceSessions.id, s.sessionId));
    const clock = new ManualClock(Date.UTC(2026, 10, 27, 10, 0, 0));
    const model = new ScriptedRealtime({ clock });
    const { log } = memLog();
    const e = new VoiceEngine({ db, model, sessionId: s.sessionId, send: () => undefined, clock, limits: QUIET, log, recording: { store: null, reason: "test" }, profile: GUARDED_PROFILE });
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await flushAsync();
        await e.idle();
      }
    };
    const run = (ms: number) => clock.advance(ms, settle);
    const speak = async () => {
      for (let x = 0; x < 1000; x += 100) { e.onClientAudio(micPcm(100, true)); await run(100); }
      for (let x = 0; x < 800; x += 100) { e.onClientAudio(micPcm(100, false)); await run(100); }
      await run(30_000);
    };
    await e.start();
    await settle();
    e.onClientMessage({ t: "ready" });
    await run(15_000);
    return { ...c, model, speak, end: async () => { e.onClientMessage({ t: "end" }); await settle(); } };
  }
  const buyerLines = async (conversationId: string) => (await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)))
    .filter((m) => m.actor === "buyer").map((m) => m.body);

  it("the scripted ready_buyer: a test call asks for the number and quotes after the buyer's yes; a buyer call runs as before", async () => {
    const t = await scriptedReadyBuyer(false);
    await t.speak();
    // Refused once ("one location" grounds no package): the agent proposes one aloud and waits for the yes.
    const names = () => t.model.connections[0].sent.toolResults.map((r) => `${r.name}:${(r.result as { ok?: boolean }).ok}`);
    expect(names()).toEqual(["update_deal_state:true", "search_catalog:true", "create_quote:false"]);
    await t.speak();
    expect(names()).toEqual(["update_deal_state:true", "search_catalog:true", "create_quote:false", "create_quote:true"]);
    await t.speak();
    expect(names().at(-1)).toBe("send_order_form:true");
    expect(await buyerLines(t.conversationId)).toEqual([
      "Hi, I run a business with one location. I decide on purchases. Please send me a price and the order form so I can sign today.",
      "Yes, go ahead.",
      "Yes, please send it.",
    ]);
    await t.end();
    const b = await scriptedReadyBuyer(true);
    await b.speak();
    await b.speak();
    expect(b.model.connections[0].sent.toolResults.map((r) => `${r.name}:${(r.result as { ok?: boolean }).ok}`))
      .toEqual(["update_deal_state:true", "search_catalog:true", "create_quote:true", "send_order_form:true"]);
    expect(await buyerLines(b.conversationId)).toEqual([
      "Hi, I run a business with one location. I decide on purchases. Please send me a price and the order form so I can sign today.",
      "Yes, please send it.",
    ]);
    await b.end();
  });
});

describe("A4: the quote flow on a call (test calls)", () => {
  const MONEY = /[₪$€£]|\bILS\b|\d[\d,]*\.\d{2}\b/;

  it("search_catalog gives no figure on a test call (prices open: the buyer asked); a buyer call gets the prices as before", async () => {
    for (const buyer of [false, true]) {
      const c = await fakeCall({ accountId: accSites, buyer });
      await c.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
      const s = await c.tool("s1", "search_catalog", { query: "" });
      const items = s.items as Record<string, unknown>[];
      expect(items.length).toBe(3);
      if (buyer) {
        expect(items[0].one_time_price).toBe("₪590.00");
        expect(typeof s.price_basis).toBe("string");
        expect(s.prices).toBeUndefined();
      } else {
        expect(JSON.stringify({ ...s, stage: undefined })).not.toMatch(MONEY);
        for (const it of items) for (const k of ["one_time_price", "recurring_price", "volume_prices"]) expect(it[k]).toBeUndefined();
        expect(s.prices).toBe(SEARCH_PRICES_FOR_CALL);
      }
      await c.end();
      // The stored row keeps the tool's own result (prices included).
      const row = (await storedRows(c.conversationId)).find((x) => x.name === "search_catalog")!;
      expect(((row.result as { items: Record<string, unknown>[] }).items)[0].one_time_price).toBe("₪590.00");
    }
  });

  it("a price turn: save and create_quote in one step, no check_fit; the quote is made and the model is told it is at 5 Order form", async () => {
    const c = await fakeCall({ accountId: accSites });
    await c.buyer("We have two cafés with 12 fridges in total. How much would it cost?");
    // One model response with both calls (the GPT tool rules' Batch): the save and the quote.
    const conn = c.model.conns.at(-1)!;
    conn.emit({ type: "tool-call", callId: "u1", name: "update_deal_state", args: { ...basics("2"), price_asked: true } });
    conn.emit({ type: "tool-call", callId: "q1", name: "create_quote", args: quoteArgs([{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 2 }], { sites: 2 }) });
    await c.run(1_000);
    expect(conn.results.map((r) => r.name)).toEqual(["update_deal_state", "create_quote"]);
    const q = conn.results[1].result;
    expect(q, JSON.stringify(q)).toMatchObject({ ok: true, status: "ready" });
    expect(String(q.stage)).toMatch(/^## Stage now: 5 Order form\n/);
    expect(String(conn.results[0].result.stage)).toContain("Do: call create_quote now. Do not call check_fit first: create_quote checks the fit itself. Save new facts with update_deal_state in the same step.");
    expect(String(conn.results[0].result.stage)).toContain("Prices: only from create_quote.");
    await c.end();
    const rows = await storedRows(c.conversationId);
    expect(rows.map((r) => r.name)).not.toContain("check_fit");
    expect(rows.filter((r) => r.name === "create_quote").map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("a set that does not fit is refused by create_quote itself, and the model is told why and what to do", async () => {
    const c = await fakeCall({ accountId: accSites });
    await c.buyer("We have two cafés with 12 fridges in total. How much would it cost?");
    await c.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
    const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SNS-200", qty: 12 }], { sites: 2 }));
    expect(q).toMatchObject({ ok: false, rule: "Fit check failed" });
    const problems = (q.problems as string[]);
    expect(problems.length).toBeGreaterThan(0);
    expect(q.message).toBe(fitRefusedMessage(problems));
    await c.end();
    // A buyer call: the tool's refusal as before (no message added).
    const b = await fakeCall({ accountId: accSites, buyer: true });
    await b.buyer("We have two cafés with 12 fridges in total. How much would it cost?");
    await b.tool("u1", "update_deal_state", { ...basics("2"), price_asked: true });
    const old = await b.tool("q1", "create_quote", quoteArgs([{ sku: "SNS-200", qty: 12 }], { sites: 2 }));
    expect(old).toMatchObject({ ok: false, rule: "Fit check failed" });
    expect(old.message).toBeUndefined();
    await b.end();
  });

  it("the stage on a call: Recommend says one set, no prices; price asked early says no number (test call); a buyer call as before", async () => {
    for (const buyer of [false, true]) {
      const c = await fakeCall({ accountId: accSites, buyer });
      await c.said("Hi, this is Ava from Polar. How do you keep track of your fridges today?");
      await c.buyer("On paper, in two cafés.");
      const u = await c.tool("u1", "update_deal_state", { ...basics("2"), asked: ["business_type"] });
      const stage = String(u.stage);
      expect(stage).toMatch(/^## Stage now: 3 Recommend\n/);
      if (buyer) {
        expect(stage).toContain("then answer with a number or range from search_catalog.");
        expect(stage).not.toContain("You have no prices yet.");
      } else {
        expect(stage).not.toContain("number or range from search_catalog");
        expect(stage).toContain("\nPresent one set in plain words, no prices, and ask if it fits. You have no prices yet.");
        expect(stage).toContain("say in one short sentence that you will give the exact price in a moment");
      }
      await c.end();
    }
  });
});

describe("offer next-action line (test calls; CALL_WIRING_V2_FOR_BUYER_CALLS off): standing_offer and matching_offer", () => {
  const TERMS = "5% off the one-time charges. Recurring charges are not discounted.";
  const DISCOUNT_REFUSAL = "A discount comes only from check_offer. Call it with the buyer's quote and reason, offer what it returns, and pass its offer id when the buyer accepts.";
  for (const buyer of [false, true]) {
    it(`${buyer ? "a buyer call: the data fields only, no next line, the tool's own messages" : "a test call: one next line from standing_offer and from matching_offer"}`, async () => {
      const before = (await ensureDraftVersion(db, acc)).playbook;
      await saveDraftPlaybook(db, acc, { ...before, maxDiscountBp: 500, offers: [{ type: "general", on: true, percentBp: 500 }] } as PlaybookWithOffers);
      try {
        const c = await fakeCall({ buyer });
        await c.tool("u1", "update_deal_state", basics());
        await c.buyer("How much for six sensors?");
        const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 6 }]));
        expect(q, JSON.stringify(q)).toMatchObject({ ok: true, status: "ready" });
        const quote = String(q.quote).split(" ")[0];
        await c.said("That is the quote.");
        await c.buyer("That's a bit much, can you do anything on the price?");
        await c.tool("o0", "update_deal_state", { ...noUpdate, objection: { play: "too_expensive", buyer_words: "a bit much", step: 4, attempt: true, status: "open" } });
        const first = await c.tool("o1", "check_offer", { quote, reason: "next", lines: null, sites: null });
        const offerId = (first.offer as { offer_id: string }).offer_id;
        expect(offerId).toMatch(/^OF-[0-9a-f]+$/);
        expect(first.next).toBeUndefined();
        await c.said("I can take five percent off.");
        await c.buyer("Anything more than that?");
        // Nothing more: the earlier offer still stands.
        const none = await c.tool("o2", "check_offer", { quote, reason: "next", lines: null, sites: null });
        expect(none, JSON.stringify(none)).toMatchObject({ ok: true, offer: null, standing_offer: { id: offerId, terms: TERMS, quote: `${quote} v1` } });
        await c.said("That is the best I can do.");
        await c.buyer("Then make it seven sensors with the five percent.");
        // 5% on other lines without the offer id: refused, the matching offer as data.
        const re = await c.tool("q2", "create_quote", quoteArgs([{ sku: "SENSOR", qty: 7 }], { discount_percent: 5 }));
        expect(re, JSON.stringify(re)).toMatchObject({
          ok: false, rule: "Discount not from an offer", missing: ["offer"],
          matching_offer: { id: offerId, terms: TERMS, quote: `${quote} v1`, lines: [{ sku: "SENSOR", qty: 6 }] },
        });
        // Not the K4 "not saved yet" message: an offer id is not a fact to save.
        expect(String(re.message)).toBe(DISCOUNT_REFUSAL);
        if (buyer) {
          expect(none.next).toBeUndefined();
          expect(re.next).toBeUndefined();
        } else {
          expect(none.next).toBe(`An earlier offer still stands on ${quote} v1. If the buyer accepts it, call create_quote with offer ${offerId}; do not make a new offer. Its terms: ${TERMS}`);
          expect(re.next).toBe(`Call create_quote again with offer ${offerId} and that offer's lines; do not change the lines. Its terms: ${TERMS}`);
        }
        for (const r of [none, re]) expect(JSON.stringify(r)).not.toMatch(UUID);
        await c.end();
        // The stored rows are the tools' own results: no next line on them.
        for (const row of await storedRows(c.conversationId)) expect((row.result as Record<string, unknown>).next, row.name).toBeUndefined();
      } finally {
        await saveDraftPlaybook(db, acc, before);
      }
    });
  }
});

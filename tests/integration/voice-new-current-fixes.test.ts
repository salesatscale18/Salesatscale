/**
 * The New engine (lib/voice/engine.ts with the guarded profile: every buyer call since 26 Nov 2026) keeps Current's
 * buyer fixes, run as Current runs them. Each case runs on the guarded engine and on Current with the same driving
 * and expects the same: PGlite, free fake models, a hand-moved clock. No paid call.
 * 1. Opt-out and card replies in the call's language (Hebrew), and no injected reply on top of a spoken line's own
 *    answer; record_opt_out's reply in the language spoken now.
 * 2. The language-switch note (OpenAI, mid-call); on Gemini the next connection's instructions in that language; the
 *    time-limit warning and tool result guidance name the language.
 * 3. Tool arguments repaired: a misplaced update_deal_state fact, the order form asked with an internal quote id.
 * 4. Transcripts cleaned (markers never stored).
 * 5. The order form's note: never mid-call on Gemini, in the instructions of every later connection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { leads, messages, quotes, rateLimits, toolCalls, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion } from "@/lib/agent/service";
import { CARD_REPLY, OPT_OUT_REPLY } from "@/lib/agent/safety";
import { VoiceEngine, type VoiceLimits, type VoiceProfile } from "@/lib/voice/engine";
import { GUARDED_PROFILE } from "@/lib/voice-guarded/profile";
import { flushAsync, ManualClock, type RealtimeConnection, type RealtimeEvent, type RealtimeModel, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { createVoiceSession, startVoiceTestConversation } from "@/lib/voice/service";
import type { VoiceLog } from "@/lib/voice/log";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const QUIET: VoiceLimits = { standbyAfterQuietMs: 600_000, env: {} };
const GEMINI = "google/gemini-3.8-live";
const GPT = "openai/gpt-realtime-2.1";
const HE_HINT = "Say it in Hebrew, the language you are speaking with the buyer.";

/** A model whose events the test emits by hand; records everything the engine sends it. */
class FakeModel implements RealtimeModel {
  readonly mode = "scripted" as const;
  constructor(readonly modelId: string) {}
  readonly conns: { cfg: RealtimeSessionConfig; emit: (e: RealtimeEvent) => void; results: { name: string; result: Record<string, unknown> }[]; responses: (string | undefined)[]; notes: string[]; texts: string[] }[] = [];
  async connect(cfg: RealtimeSessionConfig, onEvent: (e: RealtimeEvent) => void): Promise<RealtimeConnection> {
    const c = { cfg, emit: onEvent, results: [] as { name: string; result: Record<string, unknown> }[], responses: [] as (string | undefined)[], notes: [] as string[], texts: [] as string[] };
    this.conns.push(c);
    return {
      sendAudio: () => undefined, sendText: (t) => void c.texts.push(t), close: () => undefined,
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
  [me] = await db.insert(users).values({ clerkId: "n", email: "n@p.test", firstName: "Noa", role: "super_admin" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "n-acme@x.test" });
  if (!p.ok) throw new Error();
  acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, acc, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
  await seedPricing(db, acc, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, acc);
});
afterAll(async () => t.close());
beforeEach(async () => void (await db.delete(rateLimits)));

const ENGINES: [string, VoiceProfile | null][] = [["New (guarded)", GUARDED_PROFILE], ["Current", null]];

async function call(profile: VoiceProfile | null, o: { language?: string; modelId?: string; limits?: VoiceLimits } = {}) {
  const c = (await startVoiceTestConversation(db, acc, me.id, { scenario: null, language: o.language ?? "en" }))!;
  const s = await createVoiceSession(db, { accountId: acc, conversationId: c.conversationId, userId: me.id, isTest: true }, { env: SCRIPTED, ...(profile ? { engine: "guarded" as const } : { engine: "current" as const }) });
  if (!s.ok) throw new Error(s.reason);
  const clock = new ManualClock();
  const model = new FakeModel(o.modelId ?? GEMINI);
  const logs: string[] = [];
  const log: VoiceLog = { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) };
  const engine = new VoiceEngine({ db, model, sessionId: s.sessionId, clock, send: () => undefined, log, limits: { ...QUIET, ...o.limits }, recording: { store: null, reason: "test" }, ...(profile ? { profile } : {}) });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flushAsync();
      await engine.idle();
    }
  };
  const run = (ms: number) => clock.advance(ms, settle);
  const conn = () => model.conns.at(-1)!;
  await engine.start();
  await settle();
  return {
    ...s, conversationId: c.conversationId, leadId: c.leadId, model, engine, logs, run, conn,
    emit: (e: RealtimeEvent) => conn().emit(e),
    /** A spoken buyer line (the provider's final transcript). */
    spoken: async (text: string) => { conn().emit({ type: "buyer-transcript", text, final: true }); await run(300); },
    typed: async (text: string) => { engine.onClientMessage({ t: "text", text }); await run(300); },
    said: async (text: string) => {
      conn().emit({ type: "audio", pcm: new Uint8Array(480) });
      conn().emit({ type: "agent-transcript", text, final: true });
      conn().emit({ type: "turn-done" });
      await run(300);
    },
    tool: async (callId: string, name: string, args: unknown) => {
      conn().emit({ type: "tool-call", callId, name, args });
      await run(500);
      return conn().results.filter((r) => r.name === name).at(-1)!.result;
    },
    /** The provider drops the connection: the engine reconnects with fresh instructions. */
    goAway: async () => { conn().emit({ type: "going-away" }); await run(3_000); },
    end: async () => { engine.onClientMessage({ t: "end" }); await settle(); },
  };
}

const noUpdate = { updates: [], next_step: null, objection: null, recommendation_confirmed: null, price_asked: null, asked: null };
const quoteArgs = (lines: { sku: string; qty: number }[]) => ({ lines, discount_percent: 0, offer: null, sites: null, remove_auto_added: null, exception: null, headline: null, assumed: null });

describe("the New engine keeps Current's buyer fixes (26 Nov 2026)", () => {
  for (const [label, profile] of ENGINES) {
    describe(label, () => {
      it("1. a spoken Hebrew opt-out: opted out in code, no reply injected on top of the model's own answer; record_opt_out's reply in Hebrew", async () => {
        const c = await call(profile, { language: "he" });
        expect(c.conn().responses).toHaveLength(1); // the opener
        await c.spoken("הסירו אותי");
        expect(c.conn().responses).toHaveLength(1);
        expect(c.logs.some((l) => l.endsWith("note skipped: opt-out on a spoken turn (the model answers it)"))).toBe(true);
        const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
        expect(lead.status).toBe("opted_out");
        // The model answers by its rules: record_opt_out gives the reply to say, in Hebrew (no English, no hint after it).
        const r = await c.tool("x1", "record_opt_out", { reason: "הסירו אותי" });
        expect(r.reply).toBe(OPT_OUT_REPLY.he);
        expect(String(r.message)).toContain(OPT_OUT_REPLY.he);
        expect(String(r.message)).not.toContain(OPT_OUT_REPLY.en);
        expect(String(r.message)).not.toContain(HE_HINT);
        await c.end();
      });

      it("1. a typed Hebrew opt-out: the fixed reply asked for, in Hebrew", async () => {
        const c = await call(profile, { language: "he" });
        await c.typed("הסירו אותי");
        expect(c.conn().responses).toHaveLength(2);
        expect(c.conn().responses[1]).toContain(`"${OPT_OUT_REPLY.he}"`);
        expect(c.conn().responses[1]).not.toContain(OPT_OUT_REPLY.en);
        await c.end();
      });

      it("1. a card number: spoken, the model answers it (nothing injected); typed, the security reply in Hebrew", async () => {
        const c = await call(profile, { language: "he" });
        await c.spoken("המספר הוא 4111 1111 1111 1111");
        expect(c.conn().responses).toHaveLength(1);
        expect(c.logs.some((l) => l.endsWith("note skipped: card number on a spoken turn (the model answers it)"))).toBe(true);
        await c.typed("הכרטיס שלי 4111 1111 1111 1111");
        expect(c.conn().responses).toHaveLength(2);
        expect(c.conn().responses[1]).toContain(`"${CARD_REPLY.he}"`);
        expect(c.conn().responses[1]).not.toContain(CARD_REPLY.en);
        // Never stored unmasked.
        const rows = await db.select().from(messages).where(eq(messages.conversationId, c.conversationId));
        expect(rows.some((m) => /4111 1111/.test(m.body))).toBe(false);
        await c.end();
      });

      it("2. the buyer switches to Hebrew on GPT-Realtime: the language note goes in at once", async () => {
        const c = await call(profile, { modelId: GPT });
        await c.spoken("שלום, אני מעדיף לדבר עברית.");
        expect(c.conn().notes).toEqual([expect.stringContaining("the buyer now speaks Hebrew. Speak Hebrew from now on")]);
        await c.end();
      });

      it("2. the buyer switches to Hebrew on Gemini: no note mid-call; the next connection is told in its instructions and language", async () => {
        const c = await call(profile);
        expect(c.conn().cfg.instructions).toContain("Language: start in English");
        await c.spoken("שלום, אני מעדיף לדבר עברית.");
        expect(c.conn().notes).toEqual([]);
        await c.said("בטח, נמשיך בעברית.");
        await c.goAway();
        expect(c.model.conns).toHaveLength(2);
        expect(c.conn().cfg.instructions).toContain("Language: start in Hebrew");
        expect(c.conn().cfg.language).toBe("he");
        await c.end();
      });

      it("2. the time-limit warning and a tool result's guidance name the call's language", async () => {
        const c = await call(profile, { language: "he", limits: { deadlineSec: 120 } });
        await c.run(61_000);
        const warning = c.conn().responses.find((r) => /time limit/.test(r ?? ""));
        expect(warning).toContain(HE_HINT);
        // A refusal's guidance (no quote: nothing the buyer gave yet) ends with the hint.
        const r = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 3 }]));
        expect(r.ok).toBe(false);
        expect(String(r.message).endsWith(HE_HINT)).toBe(true);
        await c.end();
      });

      it("3. tool arguments repaired: price_asked sent as a deal-state field; the order form asked with the quote's internal id", async () => {
        const c = await call(profile);
        await c.spoken("I run one restaurant, one site, and I need one user seat. What does it cost?");
        const u = await c.tool("u1", "update_deal_state", {
          ...noUpdate, updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }, { key: "price_asked", value: "yes", provenance: "buyer" }],
        });
        expect(u.ok, JSON.stringify(u)).toBe(true);
        const q = await c.tool("q1", "create_quote", quoteArgs([{ sku: "SEAT-M", qty: 1 }]));
        expect(q, JSON.stringify(q)).toMatchObject({ ok: true, status: "ready" });
        // The quote's internal id (since 27 Nov 2026 no result on a call carries it: a model could still send one it
        // saw earlier, e.g. Classic's result or a recap).
        const [quoteRow] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.accountId, acc), eq(quotes.leadId, c.leadId)));
        const internalId = quoteRow.id;
        expect(q.quote_id).toBeUndefined();
        await c.spoken("Yes please, send me the order form.");
        const f = await c.tool("f1", "send_order_form", { quote: internalId });
        expect(f, JSON.stringify(f)).toMatchObject({ ok: true, link: "shown in the chat" });
        await c.end();
        const rows = await db.select().from(toolCalls).where(eq(toolCalls.conversationId, c.conversationId)).orderBy(asc(toolCalls.createdAt), asc(toolCalls.sequence));
        const deal = rows.find((x) => x.name === "update_deal_state")!.input as { updates: { key: string }[]; price_asked?: unknown };
        expect(deal.price_asked).toBe(true);
        expect(deal.updates.map((x) => x.key)).toEqual(["business_type", "sites"]);
        expect((rows.find((x) => x.name === "send_order_form")!.input as { quote: string }).quote).toBe(String(q.quote).replace(/\s*v\d+$/i, ""));
      });

      it("4. transcripts cleaned: markers never stored, a marker-only buyer line is no line", async () => {
        const c = await call(profile);
        await c.said("<no speech detected> Hi, how can I help?");
        await c.spoken("<noise>");
        await c.spoken("[inaudible] I need two seats.");
        await c.end();
        const rows = (await db.select().from(messages).where(eq(messages.conversationId, c.conversationId)).orderBy(asc(messages.createdAt))).filter((m) => m.voiceSessionId);
        expect(rows.map((m) => [m.actor, m.body])).toEqual([["agent", "Hi, how can I help?"], ["buyer", "I need two seats."]]);
      });

      it("5. the order form's note on Gemini: never mid-call; in the instructions of the next connection (a wake or a reconnect)", async () => {
        const c = await call(profile);
        c.engine.onClientMessage({ t: "context", kind: "order_form", step: "company", label: "Company", event: "opened" });
        await c.run(6_000);
        expect(c.conn().notes).toEqual([]);
        await c.said("Take your time with the form.");
        await c.goAway();
        expect(c.model.conns).toHaveLength(2);
        expect(c.conn().notes).toEqual([]);
        expect(c.conn().cfg.instructions).toMatch(/\n\n### The order form \(a note from the app, not from the buyer\)\n.*Company details/);
        await c.end();
      });

      it("5. the order form's note on GPT-Realtime: a note at once, and in the next connection's instructions", async () => {
        const c = await call(profile, { modelId: GPT });
        c.engine.onClientMessage({ t: "context", kind: "order_form", step: "company", label: "Company", event: "opened" });
        await c.run(6_000);
        expect(c.conn().notes).toEqual([expect.stringContaining("Company details")]);
        await c.said("Take your time with the form.");
        await c.goAway();
        expect(c.conn().cfg.instructions).toContain("### The order form (a note from the app, not from the buyer)");
        await c.end();
      });
    });
  }
});

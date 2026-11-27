/**
 * Voice on a buyer chat that has not started (no conversation yet: the lead has a link, nobody wrote): the button
 * shows, and pressing it starts the chat with the gates of opening its link but with NO first message (owner, 26 Nov
 * 2026): the call speaks the opener as the conversation's first message; a start refused after the chat was started
 * leaves it with the written opener, as opening the link would. Simulated buyers (channel "simulator") and real leads (web chat, channel "chat").
 * PGlite and the free scripted model.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { conversations, leads, messages, sellerAccounts, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
import type { ContactHours } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, refuseSession: false }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
// A session refused after the conversation was started (the refusal the gate could not see coming).
vi.mock("@/lib/voice/service", async (orig) => {
  const real = await orig<typeof import("@/lib/voice/service")>();
  return { ...real, createVoiceSession: (...a: Parameters<typeof real.createVoiceSession>) => (holder.refuseSession ? Promise.resolve({ ok: false as const, reason: "account_paused" as const }) : real.createVoiceSession(...a)) };
});

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { createSimulatedBuyer, resolveChatLink, receiveSimulatorInbound, ensureChatLink } = await import("@/lib/simulator/service");
const { buyerVoiceGate, buyerVoiceState, startBuyerVoiceCall, startRefusalBlock } = await import("@/lib/voice/buyer");
const { parseLead } = await import("@/lib/leads/rules");
const { upsertLead } = await import("@/lib/leads/service");
const { ManualClock, flushAsync } = await import("@/lib/voice/realtime");
const { ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { handleVoiceSocket } = await import("@/lib/voice/socket");
const messagesRoute = await import("@/app/chat/[token]/messages/route");

const SCRIPTED = { VOICE_REALTIME: "scripted" };
const ALWAYS: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let account: SellerAccount;

/** A simulated buyer with a chat link and no conversation yet. */
async function notStarted(name: string, language = "en") {
  const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, { ...account, allowSimulatedBuyers: true }, { fullName: name, company: "Shop", language, country: "IL" });
  if (!made.ok) throw new Error("buyer");
  const link = await resolveChatLink(db, made.token);
  if (!link) throw new Error("link");
  return { token: made.token, leadId: made.lead.id, ctx: link.ctx };
}
/** A real lead (not simulated) with a web-chat link and no conversation yet. */
async function realNotStarted(phone: string) {
  const p = parseLead({ fullName: "Rina Cohen", company: "Rina's", email: `r${phone}@x.test`, phone, language: "en", consent: "yes", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
  if (!p.ok) throw new Error(JSON.stringify(p.errors));
  const l = await upsertLead(db, account.id, { userId: me.id, actingAs: false }, p.value, "webhook");
  if (!l.ok) throw new Error("lead");
  const made = await ensureChatLink(db, { userId: me.id, actingAs: false }, account.id, l.lead.id);
  if (!made) throw new Error("chat link");
  const token = made.token;
  const link = await resolveChatLink(db, token);
  if (!link) throw new Error("link");
  return { token, leadId: l.lead.id, ctx: link.ctx };
}
const convsOf = (leadId: string) => db.select().from(conversations).where(eq(conversations.leadId, leadId));
const start = (b: Awaited<ReturnType<typeof notStarted>>) => startBuyerVoiceCall(db, b.ctx, b.token, { deadlineSec: 270, env: SCRIPTED });

beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
  holder.db = db;
  [me] = await db.insert(users).values({ clerkId: "o", email: "owner@p.test", firstName: "Owen", role: "user" }).returning();
  const p = parseCreateAccount({ tradeName: "Acme", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
  if (!p.ok) throw new Error();
  const id = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
  await seedCatalog(db, id, [{ sku: "SEAT-M", name: "User seat", unit: "seat", plainName: "user seat" }]);
  await seedPricing(db, id, [{ sku: "SEAT-M", oneTime: 10_000 }], { userId: me.id });
  const { saveLegalSection } = await import("@/lib/orders/settings");
  await saveLegalSection(db, id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  await ensureDraftVersion(db, id);
  await publishDraftVersion(db, { userId: me.id, actingAs: false }, id);
  await db.update(sellerAccounts).set({ status: "live", allowSimulatedBuyers: true, contactHours: ALWAYS }).where(eq(sellerAccounts.id, id));
  [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
});
afterAll(async () => tdb.close());
afterEach(() => {
  vi.unstubAllEnvs();
  holder.refuseSession = false;
});

describe("voice on a chat that has not started", () => {
  it("is available: the page, the poll and the gate (no conversation yet)", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const b = await notStarted("Empty One");
    expect(await convsOf(b.leadId)).toHaveLength(0);
    const gate = await buyerVoiceGate(db, b.ctx, { env: SCRIPTED });
    expect(gate).toMatchObject({ ok: true, conversation: null });
    const poll = (await (await messagesRoute.GET(new Request(`https://app.example.com/chat/${b.token}/messages`), { params: Promise.resolve({ token: b.token }) })).json()) as { messages: unknown[]; voice: unknown };
    expect(poll.messages).toHaveLength(0);
    expect(poll.voice).toEqual({ available: true });
  });

  it("the start makes one EMPTY conversation (no agent message before the call) and one session; the lead waits for a reply as after a chat start", async () => {
    const b = await notStarted("Empty Two");
    const r = await start(b);
    if (!r.ok) throw new Error(r.reason);
    const convs = await convsOf(b.leadId);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ id: r.conversationId, status: "open", channel: "simulator", language: "en" });
    expect(await db.select().from(voiceSessions).where(eq(voiceSessions.conversationId, r.conversationId))).toHaveLength(1);
    expect(r.firstInConversation).toBe(true);
    expect(await db.select().from(messages).where(eq(messages.conversationId, r.conversationId))).toHaveLength(0);
    expect((await db.select().from(leads).where(eq(leads.id, b.leadId)))[0].status).toBe("waiting_for_reply");
    // A message typed afterwards lands in the same conversation (the chat continues).
    // (the call is still pending here: the chat refuses a send then, so the session is ended first)
    await db.update(voiceSessions).set({ status: "ended" }).where(eq(voiceSessions.conversationId, r.conversationId));
    const sent = await receiveSimulatorInbound(db, b.ctx, "Hello", crypto.randomUUID());
    expect(sent).toMatchObject({ kind: "stored", conversationId: r.conversationId });
    expect(await convsOf(b.leadId)).toHaveLength(1);
  });

  it("a double start (double tap, two tabs) makes one conversation", async () => {
    const b = await notStarted("Empty Three");
    const [x, y] = await Promise.all([start(b), start(b)]);
    expect([x.ok, y.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(await convsOf(b.leadId)).toHaveLength(1);
    const again = await start(b);
    expect(again.ok).toBe(true);
    expect(await convsOf(b.leadId)).toHaveLength(1);
  });

  it("a start refused after the chat was started leaves the chat as opening its link would: started, no call", async () => {
    const b = await notStarted("Empty Four");
    holder.refuseSession = true;
    expect(await start(b)).toMatchObject({ ok: false, reason: "unavailable" });
    const convs = await convsOf(b.leadId);
    expect(convs).toHaveLength(1);
    expect(await db.select().from(voiceSessions).where(eq(voiceSessions.conversationId, convs[0].id))).toHaveLength(0);
    // The written opener, posted because no call started (nothing was said).
    const left = await db.select().from(messages).where(eq(messages.conversationId, convs[0].id));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ actor: "agent", voiceSessionId: null });
    expect(left[0].body).toMatch(/automated assistant of Acme/);
  });

  it("refusals on a not-started chat say why (to a tester): opted out hides it; spend cap, buyer calls off and the start's own refusals are typed", async () => {
    expect(["opted_out", "spend_cap", "no_consent", "account_paused", "account_not_live", "no_agent", "simulated_disabled", "test_lead"].map(startRefusalBlock))
      .toEqual(["opted_out", "spend_cap", "no_consent", "account_not_live", "account_not_live", "account_not_live", "account_not_live", "no_conversation"]);
    const b = await notStarted("Empty Five");
    await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, b.leadId));
    const g1 = await buyerVoiceGate(db, b.ctx, { env: SCRIPTED });
    expect(g1).toEqual({ ok: false, reason: "opted_out" });
    expect(buyerVoiceState(g1, b.ctx.lead)).toEqual({ available: false });
    expect(await start(b)).toMatchObject({ ok: false, gate: "opted_out" });
    expect(await convsOf(b.leadId)).toHaveLength(0);

    const c = await notStarted("Empty Six");
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, account.id));
    try {
      // Even scripted: a new buyer-started conversation at the cap waits for a person, so no call starts it.
      const g = await buyerVoiceGate(db, c.ctx, { env: SCRIPTED });
      expect(buyerVoiceState(g, c.ctx.lead)).toEqual({ available: false, reason: "spend_cap" });
      expect(await convsOf(c.leadId)).toHaveLength(0);
    } finally {
      await db.update(sellerAccounts).set({ monthlySpendCapMinor: account.monthlySpendCapMinor }).where(eq(sellerAccounts.id, account.id));
    }
    await db.update(sellerAccounts).set({ voiceBuyerCallsOff: true }).where(eq(sellerAccounts.id, account.id));
    try {
      expect(buyerVoiceState(await buyerVoiceGate(db, c.ctx, { env: SCRIPTED }), c.ctx.lead)).toEqual({ available: false, reason: "buyer_calls_off" });
    } finally {
      await db.update(sellerAccounts).set({ voiceBuyerCallsOff: false }).where(eq(sellerAccounts.id, account.id));
    }
  });

  it("the call on the started (empty) chat speaks the opener from its first word: it is the conversation's first message", async () => {
    const b = await notStarted("Empty Seven");
    const r = await start(b);
    if (!r.ok) throw new Error(r.reason);
    expect(await db.select().from(messages).where(eq(messages.conversationId, r.conversationId))).toHaveLength(0);
    class Fake extends EventEmitter {
      out: (string | Uint8Array)[] = [];
      bufferedAmount = 0;
      send(d: string | Uint8Array) { this.out.push(d); }
      close() { setImmediate(() => this.emit("close")); }
    }
    const ws = new Fake();
    const clock = new ManualClock();
    const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model: new ScriptedRealtime({ clock }), limits: { standbyAfterQuietMs: 600_000 } });
    const settle = async () => { for (let i = 0; i < 6; i++) { await flushAsync(4); await new Promise((x) => setTimeout(x, 5)); } };
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: r.sessionId, ticket: r.ticket })), false);
    await settle();
    await clock.advance(15_000, settle);
    ws.emit("message", Buffer.from(JSON.stringify({ t: "end" })), false);
    await clock.advance(5_000, settle);
    ws.emit("close");
    await settle();
    await done;
    const said = ws.out.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as { t: string; role?: string; text?: string; final?: boolean })
      .filter((m) => m.t === "transcript" && m.role === "agent" && m.final);
    // The opener, spoken: the introduction, then the recording line (recorded by default), then the opener's question.
    expect(said[0]?.text).toMatch(/automated assistant of Acme\. Some calls may be recorded for quality review\. /);
    expect(said.filter((m) => /automated assistant/.test(m.text ?? ""))).toHaveLength(1);
    // The chat's first message is the spoken opener (no written one before or after it).
    const stored = await db.select().from(messages).where(eq(messages.conversationId, r.conversationId)).orderBy(asc(messages.createdAt));
    expect(stored[0]).toMatchObject({ actor: "agent", voiceSessionId: r.sessionId });
    expect(stored.filter((m) => /automated assistant of Acme/.test(m.body))).toHaveLength(1);
  });
});

describe("a call on the empty chat that fails at the socket, before its engine", () => {
  it("no model for the session's mode: the session ends, then the written opener is posted (the real ensureWrittenOpenerUnlessCall)", async () => {
    const b = await notStarted("Empty Eight");
    const r = await start(b);
    if (!r.ok) throw new Error(r.reason);
    class Fake extends EventEmitter {
      out: (string | Uint8Array)[] = [];
      bufferedAmount = 0;
      send(d: string | Uint8Array) { this.out.push(d); }
      close() { setImmediate(() => this.emit("close")); }
    }
    const ws = new Fake();
    const clock = new ManualClock();
    // Voice is off now (no VOICE_REALTIME): the session's scripted mode has no model, so the socket refuses the call.
    const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: {}, clock });
    const settle = async () => { for (let i = 0; i < 6; i++) { await flushAsync(4); await new Promise((x) => setTimeout(x, 5)); } };
    ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", sessionId: r.sessionId, ticket: r.ticket })), false);
    await settle();
    ws.emit("close");
    await settle();
    await done;
    expect((await db.select().from(voiceSessions).where(eq(voiceSessions.id, r.sessionId)))[0]).toMatchObject({ status: "ended", errorCode: "model_unavailable" });
    const stored = await db.select().from(messages).where(eq(messages.conversationId, r.conversationId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ actor: "agent", voiceSessionId: null });
    expect(stored[0].body).toMatch(/automated assistant of Acme/);
  });
});

describe("Switch to voice on both web-chat channels", () => {
  it("a real lead's web chat (channel chat): available before it started, the start makes a chat conversation, and a second call joins it", async () => {
    const b = await realNotStarted("0525550777");
    expect(await buyerVoiceGate(db, b.ctx, { env: SCRIPTED })).toMatchObject({ ok: true, conversation: null });
    const r = await startBuyerVoiceCall(db, b.ctx, b.token, { deadlineSec: 270, env: SCRIPTED });
    if (!r.ok) throw new Error(`${r.reason} ${r.gate ?? ""}`);
    const convs = await convsOf(b.leadId);
    expect(convs.map((c) => c.channel)).toEqual(["chat"]);
    // The started chat is found as the chat's conversation (the gate, the rows, the tab key all use the same lookup).
    const gate = await buyerVoiceGate(db, b.ctx, { env: SCRIPTED });
    expect(gate).toMatchObject({ ok: true, conversation: { id: r.conversationId, channel: "chat" } });
  });

  it("a simulated buyer's chat (channel simulator) still works the same way", async () => {
    const b = await notStarted("Sim Channel");
    const r = await start(b);
    if (!r.ok) throw new Error(r.reason);
    expect((await convsOf(b.leadId)).map((c) => c.channel)).toEqual(["simulator"]);
    expect(await buyerVoiceGate(db, b.ctx, { env: SCRIPTED })).toMatchObject({ ok: true, conversation: { id: r.conversationId, channel: "simulator" } });
  });
});

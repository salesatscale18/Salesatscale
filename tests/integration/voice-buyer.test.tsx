/**
 * Live voice, release 2: the buyer calls from the chat page, on PGlite with
 * the FREE scripted model (VOICE_REALTIME=scripted only; no paid call).
 * The gates (each one off → no session), the chat token as the only
 * credential (wrong / expired / rate limited), consent recorded once, the call
 * continuing the chat (disclosure line, no new introduction, the chat in the
 * recap), text typed in the chat during a call going into the call (stored
 * once), no tool names reaching the buyer, and the Settings › Voice switch.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { accountMembers, auditLog, consentRecords, conversations, leads, messages, sellerAccounts, simulatorLinks, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
import type { ContactHours } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, clerkId: null as string | null, clerkCalls: 0 }));
// The chat routes read the viewer's Clerk session (lib/voice/chat-viewer.ts): signed out unless a test signs in.
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => { holder.clerkCalls++; return { userId: holder.clerkId }; },
  currentUser: async () => { throw new Error("no Clerk API call in tests"); },
}));
vi.mock("@/db", () => ({ get db() { return holder.db; } }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The chat route runs the agent's reply after the response: not here (no model call in tests).
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { createSimulatedBuyer, startSimulatorConversation, buyerChat, resolveChatLink } = await import("@/lib/simulator/service");
const { buyerVoiceGate, startBuyerVoiceCall, hasVoiceConsent, BUYER_CALLS_PER_HOUR } = await import("@/lib/voice/buyer");
const { buildVoiceInstructions, loadVoiceInstructions, reAskLine, CHAT_RECAP_LINES, CONTINUE_FALLBACK, CONTINUE_FALLBACK_HE } = await import("@/lib/voice/instructions");
const { VoiceEngine } = await import("@/lib/voice/engine");
const { ManualClock, flushAsync } = await import("@/lib/voice/realtime");
const { ScriptedRealtime } = await import("@/lib/voice/scripted-realtime");
const { handleVoiceSocket } = await import("@/lib/voice/socket");
const { barView } = await import("@/lib/voice/client/view");
const { INITIAL_SNAPSHOT } = await import("@/lib/voice/client/state");
const { VoiceCallBar } = await import("@/components/sas/voice/voice-call-bar");
const { ChatClient } = await import("@/app/chat/[token]/chat-client");
const { translator } = await import("@/lib/i18n");
const voiceRoute = await import("@/app/chat/[token]/voice/route");
const messagesRoute = await import("@/app/chat/[token]/messages/route");
const { saveVoiceBuyerCallsAction } = await import("@/app/app/[account]/settings/voice-actions");

const SCRIPTED = { VOICE_REALTIME: "scripted" };
/** Thursday 19 Nov 2026, 11:00 in Jerusalem: inside the default contact hours. */
const IN_HOURS = new Date("2026-11-19T09:00:00Z");
/** Saturday: the default hours are off. */
const SATURDAY = new Date("2026-11-21T09:00:00Z");
const ALWAYS: ContactHours = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;
let me: User;
let account: SellerAccount;

type Buyer = { token: string; leadId: string; conversationId: string };
async function newBuyer(name = "Rina Cohen", language = "en"): Promise<Buyer> {
  const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, { ...account, allowSimulatedBuyers: true }, { fullName: name, company: "Rina's Shop", language, country: "IL" });
  if (!made.ok) throw new Error("buyer");
  const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, account.id, made.lead.id);
  if (!started.ok) throw new Error(`start ${started.reason}`);
  return { token: made.token, leadId: made.lead.id, conversationId: started.conversationId };
}
const ctxOf = async (b: Buyer) => {
  const link = await resolveChatLink(db, b.token, IN_HOURS);
  if (!link) throw new Error("link");
  return link.ctx;
};
const sessions = async (conversationId: string) => db.select().from(voiceSessions).where(eq(voiceSessions.conversationId, conversationId));
const post = (path: string, token: string, body: unknown, mod: { POST: (req: Request, c: { params: Promise<{ token: string }> }) => Promise<Response> }) =>
  mod.POST(new Request(`https://app.example.com/chat/${token}/${path}`, { method: "POST", headers: { "content-type": "application/json", host: "app.example.com" }, body: JSON.stringify(body) }), { params: Promise.resolve({ token }) });

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
  await db.update(sellerAccounts).set({ status: "live", voiceBuyerCallsOff: false, allowSimulatedBuyers: true, contactHours: ALWAYS }).where(eq(sellerAccounts.id, id));
  [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
  holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
});
afterAll(async () => tdb.close());
afterEach(() => vi.unstubAllEnvs());

describe("the gates", () => {
  it("offers a call only when every gate holds; each one off means no session", async () => {
    const b = await newBuyer();
    const ctx = await ctxOf(b);
    const gate = (env: Record<string, string> = SCRIPTED, now = IN_HOURS) => buyerVoiceGate(db, ctx, { env, now });
    expect(await gate()).toMatchObject({ ok: true });
    expect(await gate({})).toEqual({ ok: false, reason: "voice_off" });

    const set = (o: Partial<SellerAccount>) => db.update(sellerAccounts).set(o).where(eq(sellerAccounts.id, account.id));
    await set({ voiceBuyerCallsOff: true });
    expect(await gate()).toEqual({ ok: false, reason: "buyer_calls_off" });
    await set({ voiceBuyerCallsOff: false, status: "paused" });
    expect(await gate()).toEqual({ ok: false, reason: "account_not_live" });
    await set({ status: "live", contactHours: null });
    // Contact hours do not limit a buyer's call: Saturday (hours off) and the middle of the night both work.
    expect((await gate(SCRIPTED, SATURDAY)).ok).toBe(true);
    expect((await gate(SCRIPTED, new Date("2026-11-19T01:00:00Z"))).ok).toBe(true);
    // Live mode at the spend cap (only the gate runs: nothing is called).
    await set({ monthlySpendCapMinor: 0 });
    expect(await gate({ VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "test-key-not-used" })).toEqual({ ok: false, reason: "spend_cap" });
    await set({ monthlySpendCapMinor: account.monthlySpendCapMinor, contactHours: ALWAYS });

    await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, b.conversationId));
    expect(await gate()).toEqual({ ok: false, reason: "not_agent" });
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, b.conversationId));
    expect(await gate()).toEqual({ ok: false, reason: "not_agent" });
    await db.update(conversations).set({ status: "open" }).where(eq(conversations.id, b.conversationId));
    await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, b.leadId));
    expect(await gate()).toEqual({ ok: false, reason: "opted_out" });

    // Any chat language gets the button: a Hebrew chat too (the call starts in Hebrew).
    const he = await newBuyer("Dana Levi", "he");
    expect(await buyerVoiceGate(db, await ctxOf(he), { env: SCRIPTED, now: IN_HOURS })).toMatchObject({ ok: true });
    // A refused buyer gets no session.
    expect(await sessions(b.conversationId)).toEqual([]);
  });
});

describe("why the button is off (a simulated chat's tester sees it; a real buyer does not)", () => {
  it("each reason, the hours text, the language check and the simulated-only rule", async () => {
    const { buyerVoiceState } = await import("@/lib/voice/buyer");
    const b = await newBuyer("Sim Tester");
    const ctx = await ctxOf(b);
    const lead = ctx.lead;
    const state = async (env: Record<string, string> = SCRIPTED, now = IN_HOURS) => buyerVoiceState(await buyerVoiceGate(db, ctx, { env, now }), lead);
    const set = (o: Partial<SellerAccount>) => db.update(sellerAccounts).set(o).where(eq(sellerAccounts.id, account.id));
    expect(await state()).toEqual({ available: true });
    expect(await state({})).toEqual({ available: false }); // voice off for the platform: no button at all
    await set({ voiceBuyerCallsOff: true });
    expect(await state()).toEqual({ available: false, reason: "buyer_calls_off" });
    await set({ voiceBuyerCallsOff: false, status: "paused" });
    expect(await state()).toEqual({ available: false, reason: "account_not_live" });
    // A setting-up account counts as live for a simulated chat.
    await set({ status: "setting_up" });
    expect(await state()).toEqual({ available: true });
    await set({ status: "live", contactHours: null });
    // Outside contact hours the button stays on (contact hours are only for what the agent starts).
    expect(await state(SCRIPTED, SATURDAY)).toEqual({ available: true });
    expect(await state(SCRIPTED, new Date("2026-11-19T05:00:00Z"))).toEqual({ available: true });
    await set({ monthlySpendCapMinor: 0 });
    expect(await state({ VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "test-key-not-used" })).toEqual({ available: false, reason: "spend_cap" });
    await set({ monthlySpendCapMinor: account.monthlySpendCapMinor, contactHours: ALWAYS });
    await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, b.conversationId));
    expect(await state()).toEqual({ available: false, reason: "not_agent" });
    // Any chat language: Hebrew, English with a region, or another language the model speaks.
    for (const l of ["he", "en", "en-US", "ar", "fr"]) {
      await db.update(conversations).set({ status: "open", language: l }).where(eq(conversations.id, b.conversationId));
      expect((await state()).available, l).toBe(true);
    }
    await db.update(conversations).set({ language: "en" }).where(eq(conversations.id, b.conversationId));
    // A real (non-simulated) buyer is never told why.
    await set({ voiceBuyerCallsOff: true });
    const real = { ...lead, buyerRef: null, phone: "+972501234567" };
    expect(buyerVoiceState(await buyerVoiceGate(db, ctx, { env: SCRIPTED, now: IN_HOURS }), real)).toEqual({ available: false });
    await set({ voiceBuyerCallsOff: false });
  });

  it("the server refuses with the same reason (simulated chat), and the page re-checks on every poll", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const b = await newBuyer("Poll Check");
    const get = async () => (await messagesRoute.GET(new Request(`https://app.example.com/chat/${b.token}/messages`), { params: Promise.resolve({ token: b.token }) })).json() as Promise<{ voice: unknown }>;
    expect((await get()).voice).toEqual({ available: true });
    await db.update(sellerAccounts).set({ voiceBuyerCallsOff: true }).where(eq(sellerAccounts.id, account.id));
    expect((await get()).voice).toEqual({ available: false, reason: "buyer_calls_off" });
    const refused = await post("voice", b.token, {}, voiceRoute);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, reason: "unavailable", gate: "buyer_calls_off" });
    await db.update(sellerAccounts).set({ voiceBuyerCallsOff: false }).where(eq(sellerAccounts.id, account.id));
    expect((await get()).voice).toEqual({ available: true });
  });
});

describe("why the button is off on a real buyer's chat: only the seller's signed-in staff or a platform admin see it", () => {
  it("anonymous: nothing; member of the account: the reason; member of another account: nothing; platform admin: the reason", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "boss@p.test");
    const b = await newBuyer("Real Buyer");
    // A real buyer's chat (not a simulated lead), the seller's buyer calls off.
    await db.update(leads).set({ buyerRef: null, phone: "+972501234567" }).where(eq(leads.id, b.leadId));
    const ctx = await ctxOf(b);
    const { isSimulatedLead } = await import("@/lib/simulator/rules");
    expect(isSimulatedLead(ctx.lead)).toBe(false);
    await db.update(sellerAccounts).set({ voiceBuyerCallsOff: true }).where(eq(sellerAccounts.id, account.id));
    // A member of this account, and a member of another account only.
    const [seller] = await db.insert(users).values({ clerkId: "clerk_seller", email: "seller@x.test", role: "user" }).returning();
    await db.insert(accountMembers).values({ accountId: account.id, userId: seller.id, role: "seller_admin" });
    const [other] = await db.insert(users).values({ clerkId: "clerk_other", email: "other@x.test", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Other Co", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "X", ownerEmail: "x@x.test" });
    if (!p.ok) throw new Error();
    const otherAccount = (await createAccount(db, { userId: other.id, actingAs: false }, p.value)).account;
    await db.insert(accountMembers).values({ accountId: otherAccount.id, userId: other.id, role: "seller_admin", isOwner: true });
    await db.insert(users).values({ clerkId: "clerk_boss", email: "boss@p.test", role: "super_admin" });
    const get = async () => (await (await messagesRoute.GET(new Request(`https://app.example.com/chat/${b.token}/messages`), { params: Promise.resolve({ token: b.token }) })).json() as { voice: unknown }).voice;
    const start = async () => (await post("voice", b.token, {}, voiceRoute)).json();
    const { default: ChatPage } = await import("@/app/chat/[token]/page");
    const pageWhy = async () => {
      const html = renderToStaticMarkup(await ChatPage({ params: Promise.resolve({ token: b.token }) }));
      return /data-voice-why="([a-z_]+)"/.exec(html)?.[1] ?? null;
    };
    try {
      // Anonymous (a real buyer): no reason on the poll, the start or the page; only the session check ran.
      holder.clerkId = null;
      holder.clerkCalls = 0;
      expect(await get()).toEqual({ available: false });
      expect(await start()).toEqual({ ok: false, reason: "unavailable" });
      expect(await pageWhy()).toBeNull();
      expect(holder.clerkCalls).toBe(3);
      // A member of this seller's account.
      holder.clerkId = "clerk_seller";
      expect(await get()).toEqual({ available: false, reason: "buyer_calls_off" });
      expect(await start()).toEqual({ ok: false, reason: "unavailable", gate: "buyer_calls_off" });
      expect(await pageWhy()).toBe("buyer_calls_off");
      // A member of another account only.
      holder.clerkId = "clerk_other";
      expect(await get()).toEqual({ available: false });
      expect(await start()).toEqual({ ok: false, reason: "unavailable" });
      expect(await pageWhy()).toBeNull();
      // A platform admin (super admin from SUPER_ADMIN_EMAILS), not a member.
      holder.clerkId = "clerk_boss";
      expect(await get()).toEqual({ available: false, reason: "buyer_calls_off" });
      expect(await start()).toEqual({ ok: false, reason: "unavailable", gate: "buyer_calls_off" });
      expect(await pageWhy()).toBe("buyer_calls_off");
      // An available call never asks who is looking.
      await db.update(sellerAccounts).set({ voiceBuyerCallsOff: false }).where(eq(sellerAccounts.id, account.id));
      holder.clerkId = null;
      holder.clerkCalls = 0;
      expect(await get()).toEqual({ available: true });
      expect(holder.clerkCalls).toBe(0);
    } finally {
      holder.clerkId = null;
      await db.update(sellerAccounts).set({ voiceBuyerCallsOff: false }).where(eq(sellerAccounts.id, account.id));
    }
  });
});

describe("starting a call", () => {
  it("starts at once (no sheet), records the first switch silently, and joins the SAME conversation", async () => {
    const b = await newBuyer("Tom Bell");
    const ctx = await ctxOf(b);
    expect(await hasVoiceConsent(db, account.id, b.leadId)).toBe(false);
    const first = await startBuyerVoiceCall(db, ctx, b.token, { deadlineSec: 270, env: SCRIPTED, now: IN_HOURS });
    expect(first).toMatchObject({ ok: true, conversationId: b.conversationId, mode: "scripted", maxSec: 270, firstInConversation: true });
    const [rec] = await db.select().from(consentRecords).where(and(eq(consentRecords.leadId, b.leadId), eq(consentRecords.accountId, account.id)));
    expect(rec.voiceConsentAt).toEqual(IN_HOURS);
    // Once a call has connected in this conversation, a later switch is not the first (no transcript note); consent time kept.
    if (!first.ok) throw new Error();
    await db.update(voiceSessions).set({ status: "ended", connectedAt: IN_HOURS, endedAt: IN_HOURS }).where(eq(voiceSessions.id, first.sessionId));
    const later = await startBuyerVoiceCall(db, ctx, b.token, { deadlineSec: 270, env: SCRIPTED, now: new Date(IN_HOURS.getTime() + 60_000) });
    expect(later).toMatchObject({ ok: true, firstInConversation: false });
    const recs = await db.select().from(consentRecords).where(eq(consentRecords.leadId, b.leadId));
    expect(recs).toHaveLength(1);
    expect(recs[0].voiceConsentAt).toEqual(IN_HOURS);
    const s = await sessions(b.conversationId);
    expect(s.every((x) => x.isTest === false && x.startedByUserId === null)).toBe(true);
    // No new conversation: the call joins the chat's own.
    expect((await db.select().from(conversations).where(eq(conversations.leadId, b.leadId))).map((c) => c.channel)).toEqual(["simulator"]);
  });

  it("the route: the chat token is the only credential (wrong → 404, expired → 410), rate-limited per token", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    const b = await newBuyer("Ann Lee");
    expect((await post("voice", "nope", {}, voiceRoute)).status).toBe(404);
    const ok = await post("voice", b.token, {}, voiceRoute);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, wsUrl: "wss://app.example.com/api/voice/socket", maxSec: 270, mode: "scripted" });
    expect(String(body.ticket)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (let i = 1; i < BUYER_CALLS_PER_HOUR; i++) expect((await post("voice", b.token, {}, voiceRoute)).status).toBe(200);
    const limited = await post("voice", b.token, {}, voiceRoute);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, reason: "rate_limited" });

    const old = await newBuyer("Old Link");
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await db.update(simulatorLinks).set({ createdAt: longAgo }).where(eq(simulatorLinks.leadId, old.leadId));
    await db.update(messages).set({ createdAt: longAgo }).where(eq(messages.conversationId, old.conversationId));
    await db.update(conversations).set({ createdAt: longAgo }).where(eq(conversations.id, old.conversationId));
    expect((await post("voice", old.token, {}, voiceRoute)).status).toBe(410);
    expect(await sessions(old.conversationId)).toEqual([]);
  });
});

describe("the call continues the chat", () => {
  it("the pick-up line: the agent's own open question re-asked, else I'm here, go ahead", () => {
    expect(reAskLine("Hi Dana, this is Maya, the automated assistant of Acme. You asked to hear from us. What made you get in touch today?")).toBe("So, what made you get in touch today?");
    expect(reAskLine("Thanks. How many locations do you have? I can then prepare a quote.")).toBe("So, how many locations do you have?");
    expect(reAskLine("Great. Is it one site or more?")).toBe("So, is it one site or more?");
    expect(reAskLine("Should I send the order form now?")).toBe("So, should I send the order form now?");
    expect(reAskLine("I see. I'd like to know: do you need setup help?")).toBe("So, do you need setup help?");
    // "I" and capitals stay; a question already starting with So is not doubled.
    expect(reAskLine("Got it. I can do Tuesday, would that work?")).toBe("So, I can do Tuesday, would that work?");
    expect(reAskLine("Does the CRM integration matter?")).toBe("So, does the CRM integration matter?");
    expect(reAskLine("Okay. So, which plan fits you?")).toBe("So, which plan fits you?");
    expect(reAskLine("The quote is in the chat.")).toBeNull();
    // A Hebrew chat: the question is re-asked in Hebrew ("אז, ..."), as the call starts in Hebrew.
    expect(reAskLine("היי דנה. מה גרם לך לפנות אלינו היום?")).toBe("אז, מה גרם לך לפנות אלינו היום?");
    expect(reAskLine("אז, מה גרם לך לפנות אלינו היום?")).toBe("אז, מה גרם לך לפנות אלינו היום?");
  });

  it("the agent's open question when it wrote last; the fallback when the buyer did", async () => {
    const b = await newBuyer("Open Question");
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, b.leadId));
    const { agentVersions } = await import("@/db/schema");
    const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, conv.agentVersionId));
    const load = () => loadVoiceInstructions(db, { account, version, conv, lead, deal: null, now: new Date() });
    const asked = await load();
    expect(asked.opener).toBe("So, what made you get in touch today?");
    expect(asked.openerPrompt).toContain('ask it again briefly, in spoken form: "So, what made you get in touch today?"');
    expect(asked.instructions).toContain('(here: "So, what made you get in touch today?")');
    await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "buyer", body: "Our fridges keep failing.", language: "en", createdAt: new Date(Date.now() + 5) });
    const answered = await load();
    expect(answered.opener).toBe(CONTINUE_FALLBACK);
    await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "agent", body: "Sorry to hear that. I'll check what fits.", language: "en", createdAt: new Date(Date.now() + 10) });
    expect((await load()).opener).toBe(CONTINUE_FALLBACK);
  });

  it("the pick-up line follows the conversation's language (its latest messages), never the conversation's UI language", async () => {
    const b = await newBuyer("Lang Check");
    const [stored] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, b.leadId));
    const { agentVersions } = await import("@/db/schema");
    const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, stored.agentVersionId));
    // Created from a Hebrew page (the 22 Nov 2026 call): the conversation says "he", every message is English.
    const conv = { ...stored, language: "he" };
    await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "buyer", body: "We run four cold rooms.", language: "he", createdAt: new Date(Date.now() + 5) });
    const en = await loadVoiceInstructions(db, { account, version, conv, lead, deal: null, now: new Date() });
    expect(en.continuing).toBe(true);
    expect(en.language).toBe("en");
    expect(en.opener).toBe(CONTINUE_FALLBACK);
    expect(en.openerPrompt).toContain(`"${CONTINUE_FALLBACK}"`);
    expect(en.openerPrompt).not.toContain(CONTINUE_FALLBACK_HE);
    expect(en.instructions).toContain("Language: start in English");
    // The conversation went on in Hebrew: the pick-up line is the Hebrew one.
    await db.insert(messages).values([
      { accountId: account.id, conversationId: b.conversationId, actor: "agent", body: "בשמחה. כמה חיישנים צריך?", language: "he", createdAt: new Date(Date.now() + 10) },
      { accountId: account.id, conversationId: b.conversationId, actor: "buyer", body: "בערך עשרים.", language: "he", createdAt: new Date(Date.now() + 15) },
    ]);
    const he = await loadVoiceInstructions(db, { account, version, conv: { ...stored, language: "en" }, lead, deal: null, now: new Date() });
    expect(he.language).toBe("he");
    expect(he.opener).toBe(CONTINUE_FALLBACK_HE);
  });

  it("a call on a chat with agent messages opens with no greeting, no introduction and no bot notice, with the chat in its instructions", async () => {
    const b = await newBuyer("Rina Grey");
    await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "buyer", body: "We have three shops in Haifa.", language: "en", createdAt: new Date(Date.now() + 5) });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, b.leadId));
    const { agentVersions } = await import("@/db/schema");
    const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, conv.agentVersionId));
    const ctx = await loadVoiceInstructions(db, { account, version, conv, lead, deal: null, now: new Date() });
    expect(ctx.continuing).toBe(true);
    // The buyer wrote last: nothing of the agent's is open, so the fallback line.
    expect(ctx.opener).toBe(CONTINUE_FALLBACK);
    expect(ctx.openerPrompt).toContain(`"${CONTINUE_FALLBACK}"`);
    expect(ctx.openerPrompt).toMatch(/Do not greet them as if new, do not introduce yourself and do not say you are an automated assistant/);
    expect(ctx.openerPrompt).toMatch(/The buyer spoke last or nothing is open/);
    expect(ctx.openerPrompt).not.toMatch(/Hi Rina|on the call now/);
    expect(ctx.instructions).toContain("The buyer switched this chat from text to voice");
    expect(ctx.instructions).toContain("say so only if the buyer asks");
    // No opener block in a continued call (the chat's opener was the introduction).
    expect(ctx.instructions).not.toContain("Your opening line, which you say first");
    expect(ctx.instructions).toContain("Never ask again for anything the buyer already answered");
    expect(ctx.instructions).toContain("- Buyer: We have three shops in Haifa.");
    expect(ctx.instructions).not.toContain("Your opening message, already sent");
    expect(CHAT_RECAP_LINES).toBe(20);
    // The recap takes up to 20 chat lines when continuing.
    const many = Array.from({ length: 25 }, (_, i) => ({ role: (i % 2 ? "buyer" : "agent") as "buyer" | "agent", text: `chat line ${i}` }));
    const built = buildVoiceInstructions({
      playbook: version.playbook, voiceSettings: null, seller: { tradeName: "Acme", currency: "ILS", languages: ["en"] }, catalog: null, deal: null,
      stage: (await import("@/lib/agent/core/stage")).NO_STAGE_FACTS, agentMessages: 3, names: { agent: "Maya", seller: "Acme", gender: "female", language: "en" },
      opener: ctx.opener, localNow: null, followUp: null, recap: many, continuing: true,
    });
    expect(built).toContain("chat line 5");
    expect(built).not.toContain("chat line 4\n");
    expect(built).toContain("chat line 24");
  });

  it("a test-lab call (a new conversation) still opens with the full introduction", async () => {
    const { startVoiceTestConversation } = await import("@/lib/voice/service");
    const c = (await startVoiceTestConversation(db, account.id, me.id, { scenario: null }))!;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, c.leadId));
    const ctx = await loadVoiceInstructions(db, { account, version: c.version, conv, lead, deal: null, now: new Date() });
    expect(ctx.continuing).toBe(false);
    expect(ctx.opener).toMatch(/the automated assistant of Acme/);
    expect(ctx.opener).not.toBe(CONTINUE_FALLBACK);
    expect(ctx.openerPrompt).toMatch(/Say your opening line now/);
  });

  it("text typed in the chat during the call goes into the call: one buyer message, marked typed; a chat POST meanwhile is refused", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const b = await newBuyer("Kim Ray");
    const ctx = await ctxOf(b);
    const r = await startBuyerVoiceCall(db, ctx, b.token, { deadlineSec: 270, env: SCRIPTED, now: new Date() });
    if (!r.ok) throw new Error(r.reason);
    const clock = new ManualClock();
    const model = new ScriptedRealtime({ clock });
    const sent: unknown[] = [];
    const engine = new VoiceEngine({ db, model, sessionId: r.sessionId, send: (m) => sent.push(m), clock, limits: { standbyAfterQuietMs: 600_000, env: {} } });
    const settle = async () => { for (let i = 0; i < 4; i++) { await flushAsync(); await engine.idle(); } };
    await engine.start();
    await settle();
    await clock.advance(15_000, settle);
    // The opener of a continuing call is the disclosure line.
    const [opener] = await db.select().from(messages).where(and(eq(messages.conversationId, b.conversationId), eq(messages.voiceSessionId, r.sessionId)));
    // The agent wrote last (its chat opener, a question not yet answered): the call re-asks it, spoken.
    expect(opener.body).toBe("So, what made you get in touch today?");
    // The chat route refuses a separate chat turn while the call runs.
    const refused = await post("messages", b.token, { text: "hello?", clientId: crypto.randomUUID() }, messagesRoute);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, reason: "in_call" });
    engine.onClientMessage({ t: "text", text: "Can you send me the price by text?" });
    await clock.advance(10_000, settle);
    engine.onClientMessage({ t: "end" });
    await settle();
    const buyerRows = await db.select().from(messages).where(and(eq(messages.conversationId, b.conversationId), eq(messages.actor, "buyer")));
    const typed = buyerRows.filter((m) => m.body === "Can you send me the price by text?");
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ typedInCall: true, voiceSessionId: r.sessionId });
    expect(buyerRows.some((m) => m.body === "hello?")).toBe(false);
    // The chat page shows the call's lines with their call marks and the finished call as a row.
    const chat = await buyerChat(db, ctx);
    expect(chat.messages.find((m) => m.body === "Can you send me the price by text?")?.call).toMatchObject({ typed: true });
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0].durationSec).toBeGreaterThan(0);
  });
});

describe("no chat turn beside a call", () => {
  it("every send path routes like the composer: into a live call, queued while it starts, chat otherwise", async () => {
    const { routeBuyerText, flushQueued } = await import("@/lib/voice/client/buyer-ui");
    expect(routeBuyerText("live")).toBe("call");
    for (const p of ["starting", "mic_prompt", "connecting", "reconnecting", "ending"]) expect(routeBuyerText(p)).toBe("queue");
    for (const p of ["idle", "ended", "unavailable", "mic_blocked", "no_mic"]) expect(routeBuyerText(p)).toBe("chat");
    expect(flushQueued("live")).toBe("call");
    expect(flushQueued("connecting")).toBe("wait");
    // The call never got there: the queued text goes to the chat.
    for (const p of ["ended", "unavailable", "mic_blocked", "idle"]) expect(flushQueued(p)).toBe("chat");
  });

  it("the server refuses a chat send while a buyer call is pending (just created) or live, and allows it once the pending one is stale", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const b = await newBuyer("Pat Moss");
    const r = await startBuyerVoiceCall(db, await ctxOf(b), b.token, { deadlineSec: 270, env: SCRIPTED, now: new Date() });
    if (!r.ok) throw new Error(r.reason);
    const send = () => post("messages", b.token, { text: "Sounds good", clientId: crypto.randomUUID() }, messagesRoute);
    const refused = await send();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, reason: "in_call" });
    expect((await db.select().from(messages).where(and(eq(messages.conversationId, b.conversationId), eq(messages.actor, "buyer")))).length).toBe(0);
    // A pending call that never connected stops blocking the chat after STALE_PENDING_SEC.
    await db.update(voiceSessions).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(eq(voiceSessions.id, r.sessionId));
    expect((await send()).status).toBe(200);
  });
});

describe("buyer calls are on by default", () => {
  it("a new account and a demo account have buyer calls on (Settings › Voice turns them off)", async () => {
    const p = parseCreateAccount({ tradeName: "Fresh", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "f@x.test" });
    if (!p.ok) throw new Error();
    const fresh = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    expect(fresh.voiceBuyerCallsOff).toBe(false);
    const [admin] = await db.insert(users).values({ clerkId: "sa", email: "sa@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const { createDemoAccount } = await import("@/lib/demo/seed");
    const demo = await createDemoAccount(db, { id: admin.id, role: "super_admin" }, { ownerEmail: "demo-owner@x.test" });
    if (!demo.ok) throw new Error("demo");
    const [row] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, demo.summary.accountId));
    expect(row.voiceBuyerCallsOff).toBe(false);
  });
});

describe("the buyer sees state words only", () => {
  it("the socket never sends tool messages to a buyer's call; the bar says One moment…", async () => {
    const b = await newBuyer("Lee Park");
    await db.update(conversations).set({ scenario: "ready_buyer" }).where(eq(conversations.id, b.conversationId));
    const r = await startBuyerVoiceCall(db, await ctxOf(b), b.token, { deadlineSec: 270, env: SCRIPTED, now: new Date() });
    if (!r.ok) throw new Error(r.reason);
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
    ws.emit("message", Buffer.from(JSON.stringify({ t: "text", text: "Hi, I run a business with one location. Please send me a price and the order form." })), false);
    await clock.advance(30_000, settle);
    ws.emit("close");
    await settle();
    await done;
    const json = ws.out.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as { t: string; state?: string });
    expect(json.some((m) => m.t === "state" && m.state === "checking")).toBe(true);
    expect(json.some((m) => m.t === "tool")).toBe(false);
    // The quote card reached the chat during the call (the chat polls it).
    const chat = await buyerChat(db, await ctxOf(b));
    expect(Object.keys(chat.cards).length).toBeGreaterThan(0);
  });

  it("the buyer's bar: the agent by name, One moment… while it checks, no cost, no Call again; Hebrew words in Hebrew", () => {
    const tr = translator("en");
    const now = Date.now();
    const live = (o: object) => ({ ...INITIAL_SNAPSHOT, phase: "live" as const, connectedAt: now - 5000, mode: "live" as const, costMicros: 99_000, ...o });
    const ctx = { audience: "buyer" as const, tr, agentName: "Maya" };
    expect(barView(live({ live: "speaking" }), now, ctx).title).toBe("\u2068Maya\u2069 is speaking");
    const checking = renderToStaticMarkup(<VoiceCallBar view={barView(live({ live: "checking" }), now, ctx)} />);
    expect(checking).toContain("One moment…");
    expect(checking).not.toMatch(/Preparing|catalog|quote|Noting/i);
    const ended = barView({ ...INITIAL_SNAPSHOT, phase: "ended", durationSec: 228, mode: "live", costMicros: 500_000 }, now, ctx);
    expect(ended.sub).toBe("The chat continues below.");
    expect(ended.action).toBeNull();
    expect(JSON.stringify(ended)).not.toMatch(/cost|₪|\$/i);
    const he = barView(live({ live: "listening" }), now, { ...ctx, tr: translator("he") });
    expect(he.title).toBe("מקשיבים");
    expect(he.muteLabel).toBe("השתקה");
  });

  it("the chat page: Switch to voice only when available, call rows and spoken marks, never a tool chip", () => {
    const strings = new Proxy({ refused: {} }, { get: (o, k) => (k in o ? (o as Record<string, unknown>)[k as string] : String(k)) }) as never;
    const initial = {
      messages: [
        { id: "m1", from: "agent" as const, body: "Hi Dana", at: "2026-11-19T09:00:00.000Z", status: null, name: null, previews: [] },
        { id: "m2", from: "buyer" as const, body: "Four shops.", at: "2026-11-19T09:02:00.000Z", status: "read" as const, name: null, previews: [], call: { atMs: 80_000, typed: false } },
      ],
      typing: false, ended: false, closedAt: null, cards: {}, calls: [{ id: "c1", startedAt: "2026-11-19T09:01:12.000Z", at: "2026-11-19T09:05:00.000Z", durationSec: 228, empty: false }],
      voice: { available: true },
    };
    const html = renderToStaticMarkup(<ChatClient token="t" lang="en" seller="Acme" initials="AC" strings={strings} initial={initial} timeZone="Asia/Jerusalem" voice={{ agentName: "Maya", gender: "female" }} />);
    expect(html).toContain('aria-label="Switch to voice"');
    expect(html).not.toContain("data-voice-disabled");
    expect(html).toContain("Voice call · 3 min 48 s · 11:05");
    // The call is framed: its start row comes before its first line, its summary row after the last.
    expect(html).toContain("Voice call started · 11:01");
    const order = ["Hi Dana", "Voice call started · 11:01", "Four shops.", "Voice call · 3 min 48 s · 11:05"].map((x) => html.indexOf(x));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const he = renderToStaticMarkup(<ChatClient token="t" lang="he" seller="Acme" initials="AC" strings={strings} initial={initial} timeZone="Asia/Jerusalem" voice={{ agentName: "Maya", gender: "female" }} />);
    expect(he).toContain("שיחה קולית התחילה · 11:01");
    expect(html).toContain('aria-label="Said in the call at 1:20"');
    expect(html).not.toContain("data-voice-tool");
    const off = renderToStaticMarkup(<ChatClient token="t" lang="en" seller="Acme" initials="AC" strings={strings} initial={{ ...initial, voice: { available: false } }} timeZone="Asia/Jerusalem" voice={{ agentName: "Maya", gender: "female" }} />);
    expect(off).not.toContain("Switch to voice");
    // A simulated chat with a gate off: the button stays, disabled, and says why under the composer.
    const why = renderToStaticMarkup(<ChatClient token="t" lang="en" seller="Acme" initials="AC" strings={strings} initial={{ ...initial, voice: { available: false, reason: "not_agent" } }} timeZone="Asia/Jerusalem" voice={{ agentName: "Maya", gender: "female" }} />);
    expect(why).toContain('aria-disabled="true"');
    expect(why).toContain("This chat is handled by a person.");
    const voiceOff = renderToStaticMarkup(<ChatClient token="t" lang="en" seller="Acme" initials="AC" strings={strings} initial={initial} timeZone="Asia/Jerusalem" />);
    expect(voiceOff).not.toContain("Switch to voice");
  });

  it("a short call with nothing from the buyer is one row (no start row), on the buyer page in both languages, the seller's thread and the stored rows", async () => {
    const strings = new Proxy({ refused: {} }, { get: (o, k) => (k in o ? (o as Record<string, unknown>)[k as string] : String(k)) }) as never;
    const initial = {
      messages: [{ id: "m1", from: "agent" as const, body: "So, what made you get in touch today?", at: "2026-11-19T09:13:01.000Z", status: null, name: null, previews: [], call: { atMs: 500, typed: false } }],
      typing: false, ended: false, closedAt: null, cards: {}, calls: [{ id: "c1", startedAt: "2026-11-19T09:13:00.000Z", at: "2026-11-19T09:13:04.000Z", durationSec: 4, empty: true }],
      voice: { available: true },
    };
    for (const [lang, row, start] of [["en", "Voice call · 4 s · 11:13", "Voice call started"], ["he", "שיחה קולית · 4 שנ׳ · 11:13", "שיחה קולית התחילה"]] as const) {
      const html = renderToStaticMarkup(<ChatClient token="t" lang={lang} seller="Acme" initials="AC" strings={strings} initial={initial} timeZone="Asia/Jerusalem" voice={{ agentName: "Maya", gender: "female" }} />);
      expect(html).toContain(row);
      expect(html).not.toContain(start);
      expect(html.match(/data-call-row=/g)).toHaveLength(1);
      // The agent's spoken line still shows as a message.
      expect(html).toContain("So, what made you get in touch today?");
    }
    // From the database: the rows and the seller's markers follow the buyer's lines in the call.
    const b = await newBuyer("Short Call");
    const at = (s: number) => new Date(Date.UTC(2026, 10, 19, 9, 13, s));
    const [v] = await db.insert(voiceSessions).values({
      accountId: account.id, conversationId: b.conversationId, agentVersionId: (await db.select().from(conversations).where(eq(conversations.id, b.conversationId)))[0].agentVersionId,
      isTest: false, status: "ended", createdAt: at(0), connectedAt: at(0), endedAt: at(4), durationSec: 4, model: "scripted", mode: "scripted", ticketHash: "x".repeat(64),
    }).returning();
    await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "agent", body: "So, what made you get in touch today?", language: "en", voiceSessionId: v.id, createdAt: at(1) });
    const { buyerCallRows } = await import("@/lib/voice/buyer");
    const { conversationView } = await import("@/lib/agent/conversation");
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    expect((await buyerCallRows(db, account.id, [b.conversationId]))[0]).toMatchObject({ durationSec: 4, empty: true });
    expect((await conversationView(db, account.id, conv)).markers!.filter((m) => m.kind.startsWith("voice")).map((m) => m.kind)).toEqual(["voice_ended"]);
    // The buyer said something: the start and summary pair.
    await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "buyer", body: "Hi", language: "en", voiceSessionId: v.id, createdAt: at(2) });
    expect((await buyerCallRows(db, account.id, [b.conversationId]))[0].empty).toBe(false);
    expect((await conversationView(db, account.id, conv)).markers!.filter((m) => m.kind.startsWith("voice")).map((m) => m.kind)).toEqual(["voice_started", "voice_ended"]);
  });
});

describe("a quote never paints as raw text", () => {
  it("the poll holds a quote message (and what follows) until its card is linked; then both come together", async () => {
    const b = await newBuyer("Quote Wait");
    const ctx = await ctxOf(b);
    const { createQuote } = await import("@/lib/quotes/service");
    const { toolCalls } = await import("@/db/schema");
    const q = await createQuote(db, account.id, { kind: "human", userId: me.id, actingAs: false }, b.leadId, { lines: [{ sku: "SEAT-M", qty: 2 }], discountBp: 0 });
    if (!q.ok) throw new Error(q.reason);
    // The live call's stored quote message (Hebrew chat), written mid-turn: its create_quote row is not stored yet.
    const body = `*הצעת מחיר Q-${q.quote.number}* \n2 × User seat (SEAT-M): ₪200.00`;
    const [quoteMsg] = await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "agent", body, language: "he" }).returning();
    const [after] = await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "agent", body: "The total today is 200 shekels.", language: "en", createdAt: new Date(quoteMsg.createdAt.getTime() + 5) }).returning();
    let chat = await buyerChat(db, ctx);
    expect(chat.messages.some((m) => m.id === quoteMsg.id || m.body.includes("Q-"))).toBe(false);
    expect(chat.messages.some((m) => m.id === after.id)).toBe(false);
    // The turn ends: its create_quote row links the message to the quote; the next poll has the message and its card.
    await db.insert(toolCalls).values({
      accountId: account.id, conversationId: b.conversationId, messageId: after.id, sequence: 0, name: "create_quote", input: {}, outcome: "ok",
      result: { quote: `Q-${q.quote.number} v1`, quote_id: q.quote.id, quote_version: 1, quote_message_id: quoteMsg.id, headline: "Two user seats" },
    });
    chat = await buyerChat(db, ctx);
    expect(chat.messages.map((m) => m.id)).toEqual(expect.arrayContaining([quoteMsg.id, after.id]));
    expect(chat.cards[quoteMsg.id]).toBeTruthy();
    // An ordinary message that merely mentions a quote number is never held.
    const { isQuoteMessageText } = await import("@/lib/agent/quote-message");
    expect(isQuoteMessageText(body)).toBe(true);
    expect(isQuoteMessageText("*Quote Q-1005*\n1 × Hub: 100")).toBe(true);
    expect(isQuoteMessageText("Your quote Q-1005 is in the chat.")).toBe(false);
  });

  it("the page: a quote message whose card is late shows a quiet placeholder, never its text", () => {
    const strings = new Proxy({ refused: {} }, { get: (o, k) => (k in o ? (o as Record<string, unknown>)[k as string] : String(k)) }) as never;
    const at = new Date().toISOString();
    const initial = {
      messages: [{ id: "q1", from: "agent" as const, body: "*הצעת מחיר Q-1005* \n2 × User seat (SEAT-M): ₪200.00", at, status: null, name: null, previews: [] }],
      typing: false, ended: false, closedAt: null, cards: {}, calls: [], voice: { available: true },
    };
    const html = renderToStaticMarkup(<ChatClient token="t" lang="he" seller="Acme" initials="AC" strings={strings} initial={initial} timeZone="Asia/Jerusalem" voice={{ agentName: "Maya", gender: "female" }} />);
    expect(html).toContain("data-quote-waiting");
    expect(html).not.toContain("הצעת מחיר Q-1005");
  });
});

describe("Settings › Voice", () => {
  it("renders for a seller while voice calls are on (and is not in the menu while they are off)", async () => {
    const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");
    type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
    const render = async (sp: Record<string, string>) => renderToStaticMarkup(await (SettingsPage as unknown as Page)({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve(sp) }));
    vi.stubEnv("VOICE_REALTIME", "off");
    const off = await render({ section: "voice" });
    expect(off).not.toContain("data-settings-voice");
    expect(off).not.toContain("section=voice");
    vi.stubEnv("VOICE_REALTIME", "scripted");
    vi.stubEnv("VOICE_WS_URL", "");
    const html = await render({ section: "voice" });
    expect(html).toContain("data-settings-voice");
    expect(html).toContain("Let buyers call the agent");
    expect(html).toContain("4 min 30 s");
    // No sheet and no opening sentence any more: a call continues the chat.
    expect(html).not.toMatch(/Opening sentence|on the call now/);
    expect(html).toContain("Transcript");
    // Call recording and its notice: company-level switches, both on by default.
    expect(html).toMatch(/data-voice-record-calls="" name="recordCalls" checked=""/);
    expect(html).toMatch(/data-voice-recording-notice="" name="recordingNotice" checked=""/);
    expect(html).toContain("Record calls");
    expect(html).toContain("kept for 90 days");
    // One Save for the page; read-only rows say where they are set.
    expect((html.match(/data-voice-save=""/g) ?? []).length).toBe(1);
    expect(html).toContain("Change it in Versions and test lab.");
    expect(html).toContain("Set by your plan.");
    const dir = process.env.VOICE_RENDER_DIR;
    if (dir) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "page-settings-voice.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} body{margin:0}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
    }
  });

  it("the switch writes voiceBuyerCallsOff (audited) and does nothing while voice calls are off", async () => {
    const form = (on: boolean, rec: { recordCalls?: boolean; recordingNotice?: boolean } = { recordCalls: true, recordingNotice: true }) => {
      const f = new FormData();
      f.set("slug", account.slug);
      if (on) f.set("buyerCalls", "on");
      if (rec.recordCalls) f.set("recordCalls", "on");
      if (rec.recordingNotice) f.set("recordingNotice", "on");
      return f;
    };
    vi.stubEnv("VOICE_REALTIME", "off");
    const e1 = await saveVoiceBuyerCallsAction(form(false)).catch((e: { url?: string }) => e);
    expect((e1 as { url?: string }).url).toBe(`/app/${account.slug}/settings`);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceBuyerCallsOff).toBe(false);
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const e2 = await saveVoiceBuyerCallsAction(form(false)).catch((e: { url?: string }) => e);
    expect((e2 as { url?: string }).url).toBe(`/app/${account.slug}/settings?section=voice&saved=voice`);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceBuyerCallsOff).toBe(true);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, account.id), eq(auditLog.action, "voice.buyer_calls_changed")));
    expect(audits).toHaveLength(1);
    await saveVoiceBuyerCallsAction(form(true)).catch(() => undefined);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceBuyerCallsOff).toBe(false);
    // The recording switches: unchanged (both on) writes nothing; turning them off is stored and audited.
    expect(await db.select().from(auditLog).where(and(eq(auditLog.accountId, account.id), eq(auditLog.action, "voice.recording_changed")))).toHaveLength(0);
    await saveVoiceBuyerCallsAction(form(true, { recordCalls: false, recordingNotice: false })).catch(() => undefined);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceSettings).toEqual({ recordCalls: false, recordingNotice: false });
    const rec = await db.select().from(auditLog).where(and(eq(auditLog.accountId, account.id), eq(auditLog.action, "voice.recording_changed")));
    expect(rec.map((a) => a.details)).toEqual([{ recordCalls: false, recordingNotice: false }]);
    await saveVoiceBuyerCallsAction(form(true)).catch(() => undefined);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceSettings).toEqual({ recordCalls: true, recordingNotice: true });
  });
});

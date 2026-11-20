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
import { auditLog, consentRecords, conversations, leads, messages, sellerAccounts, simulatorLinks, users, voiceSessions, type SellerAccount, type User } from "@/db/schema";
import type { ContactHours } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
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
const { buildVoiceInstructions, loadVoiceInstructions, CHAT_RECAP_LINES, CONTINUE_FALLBACK } = await import("@/lib/voice/instructions");
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
  await db.update(sellerAccounts).set({ status: "live", voiceBuyerCalls: true, allowSimulatedBuyers: true, contactHours: ALWAYS }).where(eq(sellerAccounts.id, id));
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
    await set({ voiceBuyerCalls: false });
    expect(await gate()).toEqual({ ok: false, reason: "buyer_calls_off" });
    await set({ voiceBuyerCalls: true, status: "paused" });
    expect(await gate()).toEqual({ ok: false, reason: "account_not_live" });
    await set({ status: "live", contactHours: null });
    expect(await gate(SCRIPTED, SATURDAY)).toEqual({ ok: false, reason: "outside_hours", hours: "Sun–Thu 08:30–20:00 · Fri 08:30–13:00 · Sat off" });
    expect((await gate(SCRIPTED, IN_HOURS)).ok).toBe(true);
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

    const he = await newBuyer("Dana Levi", "he");
    expect(await buyerVoiceGate(db, await ctxOf(he), { env: SCRIPTED, now: IN_HOURS })).toEqual({ ok: false, reason: "not_english" });
    // A refused buyer gets no session.
    expect(await startBuyerVoiceCall(db, await ctxOf(he), he.token, { deadlineSec: 270, env: SCRIPTED, now: IN_HOURS })).toEqual({ ok: false, reason: "unavailable", gate: "not_english" });
    expect(await sessions(he.conversationId)).toEqual([]);
    expect(await sessions(b.conversationId)).toEqual([]);
  });
});

describe("why the button is off (a simulated chat's tester sees it; a real buyer does not)", () => {
  it("each reason, the hours text, the language check and the simulated-only rule", async () => {
    const { buyerVoiceState, isEnglish } = await import("@/lib/voice/buyer");
    const b = await newBuyer("Sim Tester");
    const ctx = await ctxOf(b);
    const lead = ctx.lead;
    const state = async (env: Record<string, string> = SCRIPTED, now = IN_HOURS) => buyerVoiceState(await buyerVoiceGate(db, ctx, { env, now }), lead);
    const set = (o: Partial<SellerAccount>) => db.update(sellerAccounts).set(o).where(eq(sellerAccounts.id, account.id));
    expect(await state()).toEqual({ available: true });
    expect(await state({})).toEqual({ available: false }); // voice off for the platform: no button at all
    await set({ voiceBuyerCalls: false });
    expect(await state()).toEqual({ available: false, reason: "buyer_calls_off" });
    await set({ voiceBuyerCalls: true, status: "paused" });
    expect(await state()).toEqual({ available: false, reason: "account_not_live" });
    // A setting-up account counts as live for a simulated chat.
    await set({ status: "setting_up" });
    expect(await state()).toEqual({ available: true });
    await set({ status: "live", contactHours: null });
    expect(await state(SCRIPTED, SATURDAY)).toEqual({ available: false, reason: "outside_hours", hours: "Sun–Thu 08:30–20:00 · Fri 08:30–13:00 · Sat off" });
    // The lead's market time zone decides: 07:00 UTC Thursday is 09:00 in Jerusalem (open), 05:00 UTC is 07:00 there (closed).
    expect((await state(SCRIPTED, new Date("2026-11-19T07:00:00Z"))).available).toBe(true);
    expect((await state(SCRIPTED, new Date("2026-11-19T05:00:00Z"))).reason).toBe("outside_hours");
    await set({ monthlySpendCapMinor: 0 });
    expect(await state({ VOICE_REALTIME: "live", AI_GATEWAY_API_KEY: "test-key-not-used" })).toEqual({ available: false, reason: "spend_cap" });
    await set({ monthlySpendCapMinor: account.monthlySpendCapMinor, contactHours: ALWAYS });
    await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, b.conversationId));
    expect(await state()).toEqual({ available: false, reason: "not_agent" });
    await db.update(conversations).set({ status: "open", language: "he" }).where(eq(conversations.id, b.conversationId));
    expect(await state()).toEqual({ available: false, reason: "not_english" });
    // English whatever the case or region.
    for (const l of ["en", "EN", "en-US", "en_GB", " en "]) {
      await db.update(conversations).set({ language: l }).where(eq(conversations.id, b.conversationId));
      expect((await state()).available, l).toBe(true);
    }
    expect(isEnglish("eng")).toBe(false);
    expect(isEnglish(null)).toBe(false);
    // A real (non-simulated) buyer is never told why.
    await set({ voiceBuyerCalls: false });
    const real = { ...lead, buyerRef: null, phone: "+972501234567" };
    expect(buyerVoiceState(await buyerVoiceGate(db, ctx, { env: SCRIPTED, now: IN_HOURS }), real)).toEqual({ available: false });
    await set({ voiceBuyerCalls: true });
  });

  it("the server refuses with the same reason (simulated chat), and the page re-checks on every poll", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const b = await newBuyer("Poll Check");
    const get = async () => (await messagesRoute.GET(new Request(`https://app.example.com/chat/${b.token}/messages`), { params: Promise.resolve({ token: b.token }) })).json() as Promise<{ voice: unknown }>;
    expect((await get()).voice).toEqual({ available: true });
    await db.update(sellerAccounts).set({ voiceBuyerCalls: false }).where(eq(sellerAccounts.id, account.id));
    expect((await get()).voice).toEqual({ available: false, reason: "buyer_calls_off" });
    const refused = await post("voice", b.token, {}, voiceRoute);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, reason: "unavailable", gate: "buyer_calls_off" });
    await db.update(sellerAccounts).set({ voiceBuyerCalls: true }).where(eq(sellerAccounts.id, account.id));
    expect((await get()).voice).toEqual({ available: true });
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
  it("a call on a chat with agent messages opens with no greeting, no introduction and no bot notice, with the chat in its instructions", async () => {
    const b = await newBuyer("Rina Grey");
    await db.insert(messages).values({ accountId: account.id, conversationId: b.conversationId, actor: "buyer", body: "We have three shops in Haifa.", language: "en", createdAt: new Date(Date.now() + 5) });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, b.conversationId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, b.leadId));
    const { agentVersions } = await import("@/db/schema");
    const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, conv.agentVersionId));
    const ctx = await loadVoiceInstructions(db, { account, version, conv, lead, deal: null, now: new Date() });
    expect(ctx.continuing).toBe(true);
    expect(ctx.opener).toBe(CONTINUE_FALLBACK);
    expect(ctx.openerPrompt).toMatch(/Do not greet them as if new, do not introduce yourself and do not say you are an automated assistant/);
    expect(ctx.openerPrompt).toMatch(/picks up from where the chat stopped/);
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
    const engine = new VoiceEngine({ db, model, sessionId: r.sessionId, send: (m) => sent.push(m), clock, limits: { silenceAskMs: 600_000, silenceEndMs: 600_000, env: {} } });
    const settle = async () => { for (let i = 0; i < 4; i++) { await flushAsync(); await engine.idle(); } };
    await engine.start();
    await settle();
    await clock.advance(15_000, settle);
    // The opener of a continuing call is the disclosure line.
    const [opener] = await db.select().from(messages).where(and(eq(messages.conversationId, b.conversationId), eq(messages.voiceSessionId, r.sessionId)));
    expect(opener.body).toBe(CONTINUE_FALLBACK);
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

describe("buyer calls are off by default", () => {
  it("a new account and a demo account never have buyer calls on", async () => {
    const p = parseCreateAccount({ tradeName: "Fresh", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "f@x.test" });
    if (!p.ok) throw new Error();
    const fresh = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    expect(fresh.voiceBuyerCalls).toBe(false);
    const [admin] = await db.insert(users).values({ clerkId: "sa", email: "sa@p.test", firstName: "Sam", role: "super_admin" }).returning();
    const { createDemoAccount } = await import("@/lib/demo/seed");
    const demo = await createDemoAccount(db, { id: admin.id, role: "super_admin" }, { ownerEmail: "demo-owner@x.test" });
    if (!demo.ok) throw new Error("demo");
    const [row] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, demo.summary.accountId));
    expect(row.voiceBuyerCalls).toBe(false);
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
    const done = handleVoiceSocket(ws, { db, deadlineSec: 270, env: SCRIPTED, clock, model: new ScriptedRealtime({ clock }), limits: { silenceAskMs: 600_000, silenceEndMs: 600_000 } });
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
      typing: false, ended: false, closedAt: null, cards: {}, calls: [{ id: "c1", startedAt: "2026-11-19T09:01:12.000Z", at: "2026-11-19T09:05:00.000Z", durationSec: 228 }],
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
    const why = renderToStaticMarkup(<ChatClient token="t" lang="en" seller="Acme" initials="AC" strings={strings} initial={{ ...initial, voice: { available: false, reason: "outside_hours", hours: "Sun–Thu 08:30–20:00" } }} timeZone="Asia/Jerusalem" voice={{ agentName: "Maya", gender: "female" }} />);
    expect(why).toContain('aria-disabled="true"');
    expect(why).toContain("Outside contact hours (Sun–Thu 08:30–20:00).");
    const voiceOff = renderToStaticMarkup(<ChatClient token="t" lang="en" seller="Acme" initials="AC" strings={strings} initial={initial} timeZone="Asia/Jerusalem" />);
    expect(voiceOff).not.toContain("Switch to voice");
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
    expect(html).toContain('data-voice-recordings="off"');
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

  it("the switch writes voiceBuyerCalls (audited) and does nothing while voice calls are off", async () => {
    const form = (on: boolean) => {
      const f = new FormData();
      f.set("slug", account.slug);
      if (on) f.set("buyerCalls", "on");
      return f;
    };
    vi.stubEnv("VOICE_REALTIME", "off");
    const e1 = await saveVoiceBuyerCallsAction(form(false)).catch((e: { url?: string }) => e);
    expect((e1 as { url?: string }).url).toBe(`/app/${account.slug}/settings`);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceBuyerCalls).toBe(true);
    vi.stubEnv("VOICE_REALTIME", "scripted");
    const e2 = await saveVoiceBuyerCallsAction(form(false)).catch((e: { url?: string }) => e);
    expect((e2 as { url?: string }).url).toBe(`/app/${account.slug}/settings?section=voice&saved=voice`);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceBuyerCalls).toBe(false);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, account.id), eq(auditLog.action, "voice.buyer_calls_changed")));
    expect(audits).toHaveLength(1);
    await saveVoiceBuyerCallsAction(form(true)).catch(() => undefined);
    expect((await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, account.id)))[0].voiceBuyerCalls).toBe(true);
  });
});

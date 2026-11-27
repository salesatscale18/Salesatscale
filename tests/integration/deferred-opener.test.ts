/**
 * The lead page hand-over opens the conversation with no text in it (owner, 26 Nov): "Talk now" posts nothing, so the
 * call's first sentence is heard from its beginning; the written opener comes from ensureWrittenOpener ("Chat in
 * writing", a call that could not start, the chat page opened later, the cron after OPENER_PENDING_MINUTES).
 * Every other entry point keeps posting the opener at once. PGlite, mock SMS; no model calls, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, catalogVersions, consentRecords, conversations, followUps, leadPageSubmissions, leads, legalSections, messages, quotes, quoteVersions, sellerAccounts, toolCalls, users, voiceSessions, type LeadPage, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { ensureChatPrepared, ensureChatStarted, ensureWrittenOpener, ensureWrittenOpenerUnlessCall, writtenOpenerText } from "@/lib/chat/start";
import { submitLeadPage, type SubmitResult } from "@/lib/lead-pages/intake";
import { handoverWrittenOpener, loadHandover, recordHandoverChoice } from "@/lib/lead-pages/handover";
import { createLeadPage, goLiveLeadPage } from "@/lib/lead-pages/service";
import { OPENER_PENDING_MINUTES, runPendingOpeners } from "@/lib/lead-pages/pending-opener";
import { formTimingToken, leadCookieValue, previewTokenFor } from "@/lib/lead-pages/tokens";
import { isPreviewRunLead, isUnverifiedLead } from "@/lib/leads/unverified";
import { activeChatToken, createSimulatedBuyer, resolveChatLink, startSimulatorConversation } from "@/lib/simulator/service";
import { runDueFollowUps } from "@/lib/follow-ups/scheduler";
import { failedCallOpener, openWrittenChat } from "@/app/h/[token]/handover-chat";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, skipTurnGuard: false }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
// `skipTurnGuard`: the typed-message route's in_call check passes, as when a call starts right after it (the race).
vi.mock("@/lib/voice/one-agent", async (orig) => {
  const real = await orig<typeof import("@/lib/voice/one-agent")>();
  return { ...real, textTurnBlocked: (...a: Parameters<typeof real.textTurnBlocked>) => (holder.skipTurnGuard ? Promise.resolve(false) : real.textTurnBlocked(...a)) };
});

const APP = "http://localhost:3000";
const MIN = 60_000;
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));

describe("deferred written opener (lead page hand-over)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let page: LeadPage;
  let ipN = 0;
  let phoneN = 3000;
  const actor = () => ({ userId: me.id, actingAs: false });
  const nextPhone = () => `+9725472${String(++phoneN).padStart(5, "0")}`;

  const submit = async (name = "Rina Mizrahi"): Promise<Extract<SubmitResult, { kind: "handover" }>> => {
    const r = await submitLeadPage(db, {
      key: page.publicKey, headers: new Headers({ origin: APP }), ip: `10.77.0.${++ipN}`, env: { APP_URL: APP },
      body: { ft: formTimingToken(page.id, Date.now() - 5000), consent: "on", name, phone: nextPhone() },
    });
    if (r.kind !== "handover") throw new Error(JSON.stringify(r));
    return r;
  };
  /** Send, then the hand-over renders: the chat prepared, its conversation. */
  const sendAndHandover = async () => {
    const r = await submit();
    const h = await loadHandover(db, { token: r.token, cookie: null, ip: `10.78.0.${++ipN}` });
    if (h.kind !== "ready" || !h.chat) throw new Error(JSON.stringify(h.kind));
    const [sub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, r.submissionId));
    return { r, sub, conversationId: sub.conversationId!, leadId: sub.leadId, chatToken: h.chat.token };
  };
  const agentMessages = (conversationId: string) =>
    db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.actor, "agent")));
  const liveCall = (conversationId: string) => db.insert(voiceSessions).values({
    accountId: acc, conversationId, status: "live", connectedAt: new Date(), model: "scripted", mode: "scripted", ticketHash: "t".repeat(64),
  } as typeof voiceSessions.$inferInsert).returning();
  const pendingCall = (conversationId: string) => db.insert(voiceSessions).values({
    accountId: acc, conversationId, status: "pending", model: "scripted", mode: "scripted", ticketHash: "p".repeat(64),
  } as typeof voiceSessions.$inferInsert).returning();
  const ageSubmission = (id: string, minutes: number) =>
    db.update(leadPageSubmissions).set({ createdAt: new Date(Date.now() - minutes * MIN) }).where(eq(leadPageSubmissions.id, id));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-defer", email: "d@defer.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@defer.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live", contactHours: ALL_DAY, allowSimulatedBuyers: true }).where(eq(sellerAccounts.id, acc));
    for (const lang of ["en", "he"]) {
      await db.insert(legalSections).values({ accountId: acc, sectionKey: "privacy_notice", title: "Privacy notice", language: lang, version: 1, body: "We keep your details." });
    }
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    const c = await createLeadPage(db, actor(), account, { name: "Spring offer", connection: "link", language: "en", openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" } });
    if (!c.ok) throw new Error(JSON.stringify(c.errors));
    const live = await goLiveLeadPage(db, actor(), acc, c.page.id);
    if (!live.ok) throw new Error(JSON.stringify(live));
    page = live.page;
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("after Send the hand-over prepares the chat and its link with no message; reloading writes nothing", async () => {
    const { r, conversationId, leadId, chatToken } = await sendAndHandover();
    expect(chatToken).toBeTruthy();
    expect(await db.select().from(messages).where(eq(messages.conversationId, conversationId))).toHaveLength(0);
    // The lead stays new until the opener is written.
    expect((await db.select().from(leads).where(eq(leads.id, leadId)))[0].status).toBe("new");
    await loadHandover(db, { token: r.token, cookie: null, ip: "10.79.0.1" });
    expect(await db.select().from(conversations).where(eq(conversations.leadId, leadId))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.conversationId, conversationId))).toHaveLength(0);
  });

  it("Talk now posts nothing; a call that could not start posts the written opener (once)", async () => {
    const { r, conversationId } = await sendAndHandover();
    expect(await recordHandoverChoice(db, { token: r.token, choice: "voice", cookie: null, staffViewer: async () => false })).toEqual({ ok: true });
    expect(await agentMessages(conversationId)).toHaveLength(0);
    // onFailed → writtenOpenerAction → handoverWrittenOpener, then the failure line.
    const steps: string[] = [];
    await failedCallOpener({
      post: async () => { steps.push("post"); return handoverWrittenOpener(db, { token: r.token, cookie: null }); },
      showFailed: () => steps.push("failed"),
    });
    expect(steps).toEqual(["post", "failed"]);
    const [opener] = await agentMessages(conversationId);
    expect(opener.body).toContain("You asked about Fridge monitoring.");
    // "Chat in writing" after it: nothing more.
    expect(await handoverWrittenOpener(db, { token: r.token, cookie: null })).toEqual({ ok: true, posted: false });
    expect(await agentMessages(conversationId)).toHaveLength(1);
  });

  it("Chat in writing posts the opener and fetches it before the chat shows; a failed post still shows the chat", async () => {
    const { r, conversationId, leadId } = await sendAndHandover();
    const steps: string[] = [];
    await openWrittenChat({
      post: async () => { steps.push("post"); return handoverWrittenOpener(db, { token: r.token, cookie: null }); },
      refresh: async () => { steps.push(`refresh:${(await agentMessages(conversationId)).length}`); },
      show: () => steps.push("show"),
    });
    expect(steps).toEqual(["post", "refresh:1", "show"]);
    expect((await db.select().from(leads).where(eq(leads.id, leadId)))[0].status).toBe("waiting_for_reply");
    const shown: string[] = [];
    await openWrittenChat({ post: async () => { throw new Error("offline"); }, refresh: () => undefined, show: () => shown.push("show") });
    expect(shown).toEqual(["show"]);
    // Only the browser the chat was offered to, and not after 30 minutes.
    expect(await handoverWrittenOpener(db, { token: "nope.nope", cookie: null })).toEqual({ ok: false, reason: "not_found" });
    await ageSubmission(r.submissionId, 31);
    expect(await handoverWrittenOpener(db, { token: r.token, cookie: null })).toEqual({ ok: false, reason: "expired" });
  });

  it("ensureWrittenOpener: posts once, no-op once an agent message exists, one opener for concurrent callers", async () => {
    const a = await sendAndHandover();
    const results = await Promise.all([1, 2, 3, 4].map(() => ensureWrittenOpener(db, acc, a.conversationId)));
    expect(results.filter((x) => x.posted)).toHaveLength(1);
    expect(await agentMessages(a.conversationId)).toHaveLength(1);
    expect(await ensureWrittenOpener(db, acc, a.conversationId)).toEqual({ posted: false });
    // A spoken greeting (an agent line from a call) counts: no written opener over it.
    const b = await sendAndHandover();
    await db.insert(messages).values({ accountId: acc, conversationId: b.conversationId, actor: "agent", body: "Hi, this is the agent on the call." });
    expect(await ensureWrittenOpener(db, acc, b.conversationId)).toEqual({ posted: false });
    expect(await agentMessages(b.conversationId)).toHaveLength(1);
    // Another account's id, an unknown conversation: nothing.
    expect(await ensureWrittenOpener(db, crypto.randomUUID(), a.conversationId)).toEqual({ posted: false });
    expect(await ensureWrittenOpener(db, acc, crypto.randomUUID())).toEqual({ posted: false });
  });

  it("writtenOpenerText is exactly what ensureWrittenOpener posts, with no side effects; null behind a gate", async () => {
    const a = await sendAndHandover();
    const text = await writtenOpenerText(db, acc, a.conversationId);
    expect(text).toContain("You asked about Fridge monitoring.");
    expect(await writtenOpenerText(db, acc, a.conversationId, "he")).not.toBe(text);
    expect(await db.select().from(messages).where(eq(messages.conversationId, a.conversationId))).toHaveLength(0);
    expect((await db.select().from(leads).where(eq(leads.id, a.leadId)))[0].status).toBe("new");
    expect(await ensureWrittenOpener(db, acc, a.conversationId)).toEqual({ posted: true });
    expect((await agentMessages(a.conversationId))[0].body).toBe(text);
    const b = await sendAndHandover();
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, b.conversationId));
    expect(await writtenOpenerText(db, acc, b.conversationId)).toBeNull();
    expect(await writtenOpenerText(db, crypto.randomUUID(), a.conversationId)).toBeNull();
  });

  it("ensureWrittenOpener keeps the gates: closed, opted out, paused account, spend cap", async () => {
    const closed = await sendAndHandover();
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, closed.conversationId));
    expect(await ensureWrittenOpener(db, acc, closed.conversationId)).toEqual({ posted: false });

    const opted = await sendAndHandover();
    await db.update(leads).set({ status: "opted_out" }).where(eq(leads.id, opted.leadId));
    expect(await ensureWrittenOpener(db, acc, opted.conversationId)).toEqual({ posted: false });

    const paused = await sendAndHandover();
    await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, acc));
    expect(await ensureWrittenOpener(db, acc, paused.conversationId)).toEqual({ posted: false });
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));

    const capped = await sendAndHandover();
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 0 }).where(eq(sellerAccounts.id, acc));
    const atCap = await ensureWrittenOpener(db, acc, capped.conversationId);
    await db.update(sellerAccounts).set({ monthlySpendCapMinor: 10_000 }).where(eq(sellerAccounts.id, acc));
    expect(atCap).toEqual({ posted: false });
    for (const c of [closed, opted, paused, capped]) expect(await agentMessages(c.conversationId)).toHaveLength(0);
    // Once the gate lifts, the same chat gets its opener.
    expect(await ensureWrittenOpener(db, acc, paused.conversationId)).toEqual({ posted: true });
  });

  it("the chat page posts the opener on load when the chat is empty, but not while a call holds it", async () => {
    const { loadBuyerChat } = await import("@/app/chat/[token]/load");
    const a = await sendAndHandover();
    const link = await resolveChatLink(db, a.chatToken);
    if (!link || link.state !== "live") throw new Error();
    // A call holds the conversation: a reload during it posts nothing.
    const [call] = await liveCall(a.conversationId);
    const during = await loadBuyerChat(a.chatToken, link.ctx, {});
    expect(during.props.initial.messages).toHaveLength(0);
    expect(await ensureWrittenOpenerUnlessCall(db, acc, a.conversationId)).toEqual({ posted: false });
    expect(await agentMessages(a.conversationId)).toHaveLength(0);
    await db.update(voiceSessions).set({ status: "ended" }).where(eq(voiceSessions.id, call.id));
    // The buyer left the hand-over without choosing and opens the link later: the opener is there on load.
    const later = await loadBuyerChat(a.chatToken, link.ctx, {});
    expect(later.props.initial.messages).toHaveLength(1);
    expect(later.props.initial.messages[0]).toMatchObject({ from: "agent" });
    expect(later.props.initial.messages[0].body).toContain("You asked about Fridge monitoring.");
    // The hand-over itself never posts it (writtenOpener: false).
    const b = await sendAndHandover();
    const linkB = await resolveChatLink(db, b.chatToken);
    if (!linkB || linkB.state !== "live") throw new Error();
    const hand = await loadBuyerChat(b.chatToken, linkB.ctx, {}, { recordOpen: false, writtenOpener: false });
    expect(hand.props.initial.messages).toHaveLength(0);
  });

  it(`the cron posts after ${OPENER_PENDING_MINUTES} minutes without a choice, not before, not during a call; idempotent`, async () => {
    const fresh = await sendAndHandover();
    const old = await sendAndHandover();
    const inCall = await sendAndHandover();
    await ageSubmission(old.sub.id, OPENER_PENDING_MINUTES + 1);
    await ageSubmission(inCall.sub.id, OPENER_PENDING_MINUTES + 1);
    await liveCall(inCall.conversationId);
    const s = await runPendingOpeners(db);
    expect(s.posted).toBeGreaterThanOrEqual(1);
    expect(await agentMessages(old.conversationId)).toHaveLength(1);
    expect(await agentMessages(fresh.conversationId)).toHaveLength(0);
    expect(await agentMessages(inCall.conversationId)).toHaveLength(0);
    // Again: nothing new for the same chat.
    await runPendingOpeners(db);
    expect(await agentMessages(old.conversationId)).toHaveLength(1);
    // The fresh one once its time has come.
    await runPendingOpeners(db, new Date(Date.now() + (OPENER_PENDING_MINUTES + 1) * MIN));
    expect(await agentMessages(fresh.conversationId)).toHaveLength(1);
  });

  it("follow-ups still fire for a lead whose opener the cron posted", async () => {
    const a = await sendAndHandover();
    await ageSubmission(a.sub.id, OPENER_PENDING_MINUTES + 1);
    await runPendingOpeners(db);
    expect(await agentMessages(a.conversationId)).toHaveLength(1);
    const [f] = await db.insert(followUps).values({
      accountId: acc, leadId: a.leadId, conversationId: a.conversationId, dueAt: new Date(Date.now() - MIN), topic: "the second kitchen", language: "en",
      createdAt: new Date(Date.now() - 5 * MIN),
    }).returning();
    const s = await runDueFollowUps(db, null, new Date());
    expect(s.sent).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(followUps).where(eq(followUps.id, f.id)))[0].status).toBe("sent");
    expect(await agentMessages(a.conversationId)).toHaveLength(2);
  });

  it("non-lead-page entry points are unchanged: ensureChatStarted and the simulator post the opener at once", async () => {
    const r = await submit("Other Buyer");
    // No hand-over render: the chat link (Send chat link, an order form, /c/<code>) starts it as before.
    const [sub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, r.submissionId));
    const started = await ensureChatStarted(db, { accountId: acc, leadId: sub.leadId });
    if (!started.started) throw new Error(JSON.stringify(started));
    expect(await agentMessages(started.conversationId)).toHaveLength(1);
    expect(await activeChatToken(db, acc, sub.leadId)).toBeTruthy();
    // Prepared after that: the existing chat, nothing written.
    expect(await ensureChatPrepared(db, { accountId: acc, leadId: sub.leadId })).toEqual({ prepared: false, reason: "exists", conversationId: started.conversationId });
    // The buyer simulator (lead card) posts its opener in the same write.
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    const buyer = await createSimulatedBuyer(db, actor(), account, { fullName: "Sim Buyer", company: "", language: "en", country: "IL" });
    if (!buyer.ok) throw new Error(JSON.stringify(buyer));
    const sim = await startSimulatorConversation(db, actor(), acc, buyer.lead.id);
    if (!sim.ok) throw new Error(JSON.stringify(sim));
    const [m] = await agentMessages(sim.conversationId);
    expect(m.id).toBe(sim.messageId);
  });

  it("a typed message while a call is pending does not post the written opener (even past the in_call check)", async () => {
    const messagesRoute = await import("@/app/chat/[token]/messages/route");
    const a = await sendAndHandover();
    const [call] = await pendingCall(a.conversationId);
    const post = () => messagesRoute.POST(
      new Request(`${APP}/chat/${a.chatToken}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello?", clientId: crypto.randomUUID() }) }),
      { params: Promise.resolve({ token: a.chatToken }) },
    );
    holder.skipTurnGuard = true;
    try {
      await post();
    } finally {
      holder.skipTurnGuard = false;
    }
    expect(await agentMessages(a.conversationId)).toHaveLength(0);
    // Once the call is over, the next typed message gets the opener in first.
    await db.update(voiceSessions).set({ status: "ended" }).where(eq(voiceSessions.id, call.id));
    expect(await (await post()).json()).toEqual({ ok: true });
    const [opener] = await agentMessages(a.conversationId);
    expect(opener.body).toContain("You asked about Fridge monitoring.");
  });

  describe("continuation leads (the agent talked to the lead before)", () => {
    /** An existing lead with an earlier WhatsApp conversation and a sent quote (the continuation's card). */
    const earlierLead = async () => {
      const phone = nextPhone();
      const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Yael Cohen", phone, language: "en", origin: "manual", status: "waiting_for_reply" }).returning();
      await db.insert(consentRecords).values({ accountId: acc, leadId: lead.id, wording: "SMS, WhatsApp or email", source: "Form", capturedAt: new Date() });
      const [av] = await db.select({ id: agentVersions.id }).from(agentVersions).where(eq(agentVersions.accountId, acc)).limit(1);
      const [wa] = await db.insert(conversations).values({ accountId: acc, leadId: lead.id, channel: "whatsapp", language: "en", agentVersionId: av.id } as typeof conversations.$inferInsert).returning();
      await db.insert(messages).values({ accountId: acc, conversationId: wa.id, actor: "buyer", body: "Hi, how much is it?" });
      let [cv] = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, acc));
      if (!cv) [cv] = await db.insert(catalogVersions).values({ id: crypto.randomUUID(), accountId: acc, version: 1 }).returning();
      const quoteId = crypto.randomUUID();
      await db.insert(quotes).values({ id: quoteId, accountId: acc, leadId: lead.id, number: 5000 + phoneN, status: "sent" });
      await db.insert(quoteVersions).values({
        id: crypto.randomUUID(), accountId: acc, quoteId, version: 1, catalogVersionId: cv.id, currency: "ILS", pricesIncludeTax: true, taxRateBp: 1800,
        oneTimeSubtotalMinor: 0, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: 0,
        recurringSubtotalMinor: 0, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: 0,
        validUntil: new Date(Date.now() + 14 * 24 * 60 * MIN), createdByActor: "agent",
      } as typeof quoteVersions.$inferInsert);
      return { lead, phone, quoteId };
    };
    const send = async (body: Record<string, unknown>, cookie?: string) => {
      const h: Record<string, string> = { origin: APP };
      if (cookie) h.cookie = `sas_lp=${cookie}`;
      const r = await submitLeadPage(db, {
        key: page.publicKey, headers: new Headers(h), ip: `10.77.1.${++ipN}`, env: { APP_URL: APP },
        body: { ft: formTimingToken(page.id, Date.now() - 5000), consent: "on", ...body },
      });
      if (r.kind !== "handover") throw new Error(JSON.stringify(r));
      return r;
    };
    const webChat = async (leadId: string) => (await db.select().from(conversations).where(and(eq(conversations.leadId, leadId), eq(conversations.channel, "chat"))))[0];

    it("the lead's own browser: the continuation line and its card are posted on render; Talk now keeps them", async () => {
      const { lead, phone, quoteId } = await earlierLead();
      const r = await send({ name: "Yael Cohen", phone }, leadCookieValue(lead.id));
      const [sub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, r.submissionId));
      expect(sub).toMatchObject({ leadId: lead.id, leadCreated: false });
      const h = await loadHandover(db, { token: r.token, cookie: leadCookieValue(lead.id), ip: `10.78.1.${++ipN}` });
      expect(h).toMatchObject({ kind: "ready", variant: "chat" });
      const chat = await webChat(lead.id);
      const rows = await db.select().from(messages).where(eq(messages.conversationId, chat.id)).orderBy(messages.createdAt);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ actor: "agent" });
      expect(rows[0].body).toMatch(/^Hi Yael, it's .+ again from .+, picking up where we left off\. Here's your quote Q-\d+ from .+, any questions about it\?$/);
      const [card] = await db.select().from(toolCalls).where(eq(toolCalls.messageId, rows[1].id));
      expect(card.result).toMatchObject({ kind: "quote", quote_id: quoteId, continued: true });
      // A reload writes nothing more; Talk now keeps the chat as it is (the call speaks its own continuation).
      await loadHandover(db, { token: r.token, cookie: leadCookieValue(lead.id), ip: `10.78.1.${++ipN}` });
      expect(await recordHandoverChoice(db, { token: r.token, choice: "voice", cookie: leadCookieValue(lead.id), staffViewer: async () => false })).toEqual({ ok: true });
      expect(await agentMessages(chat.id)).toHaveLength(2);
      expect(await handoverWrittenOpener(db, { token: r.token, cookie: leadCookieValue(lead.id) })).toEqual({ ok: true, posted: false });
    });

    it("FRESH, not continuations: an unverified returning lead and a preview run with that number start empty", async () => {
      const { lead, phone } = await earlierLead();
      // Another browser, same number: a separate unverified lead.
      const other = await send({ name: "Someone Else", phone });
      expect(other.newLeadId).toBeTruthy();
      expect(other.newLeadId).not.toBe(lead.id);
      const [u] = await db.select().from(leads).where(eq(leads.id, other.newLeadId!));
      expect(isUnverifiedLead(u)).toBe(true);
      const hu = await loadHandover(db, { token: other.token, cookie: null, ip: `10.78.1.${++ipN}` });
      expect(hu).toMatchObject({ kind: "ready", variant: "chat" });
      expect(await db.select().from(messages).where(eq(messages.conversationId, (await webChat(u.id)).id))).toHaveLength(0);
      // The seller's preview with the same number (and the real lead's cookie): a preview-run test lead.
      const pv = await send({ name: "Seller Test", phone, preview: previewTokenFor(page.id, new Date()), fresh: "1" }, leadCookieValue(lead.id));
      const [psub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, pv.submissionId));
      const [pl] = await db.select().from(leads).where(eq(leads.id, psub.leadId));
      expect(isPreviewRunLead(pl)).toBe(true);
      const hp = await loadHandover(db, { token: pv.token, cookie: null, ip: `10.78.1.${++ipN}` });
      expect(hp).toMatchObject({ kind: "ready", variant: "chat" });
      expect(await db.select().from(messages).where(eq(messages.conversationId, psub.conversationId!))).toHaveLength(0);
      // The real lead got no web chat from either.
      expect(await webChat(lead.id)).toBeUndefined();
    });
  });
});

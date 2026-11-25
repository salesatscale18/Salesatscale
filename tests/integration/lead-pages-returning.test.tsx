/**
 * Lead pages: a returning number from another browser (owner rule, 25 Nov). A phone that is already a lead,
 * typed in a browser without that lead's sas_lp cookie, gets a SEPARATE unverified returning lead
 * (lib/leads/unverified.ts) with the normal hand-over and a fresh conversation; the existing lead is not
 * changed (one timeline note). Covers isolation (the new lead's agent context and tools), the same-browser
 * cases, existing leads in human handling / opted out / without consent, the limits, no SMS, the page
 * numbers, every outbound path skipping it, the seller's lines and the phone search.
 * ScriptedLlm and mock SMS only: no model call, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq, like } from "drizzle-orm";
import {
  consentRecords, conversations, leadEvents, leadPageSubmissions, leads, legalSections, messages, quotes, sellerAccounts, users,
  type LeadPage, type SellerAccount, type User,
} from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { ScriptedLlm } = await import("@/lib/agent/llm");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { runTool } = await import("@/lib/agent/tools");
const { loadStageFacts } = await import("@/lib/agent/core/stage-facts");
const { REPEAT_MS, submitLeadPage } = await import("@/lib/lead-pages/intake");
const { loadHandover } = await import("@/lib/lead-pages/handover");
const { createLeadPage, goLiveLeadPage } = await import("@/lib/lead-pages/service");
const { listTotals, pageFunnel, rangeOfDays } = await import("@/lib/lead-pages/stats");
const { formTimingToken, leadCookieValue } = await import("@/lib/lead-pages/tokens");
const { hasDialablePhone, isUnverifiedLead } = await import("@/lib/leads/unverified");
const { listLeads } = await import("@/lib/leads/service");
const { listInbox } = await import("@/lib/conversations/inbox");
const { MockSmsTransport } = await import("@/lib/sms/transport");
const { nudgeBuyer } = await import("@/lib/sms/service");
const { nudgeFollowUp, nudgePayReminder, nudgeQuoteReady, sendChatLink } = await import("@/lib/sms/outbound");
const { openerFacts } = await import("@/lib/channels/whatsapp");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

const APP = "http://localhost:3000";
const MG = `MG${"c".repeat(32)}`;
const LIVE_SMS = { transport: new MockSmsTransport(), env: { SMS_MODE: "live", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_MESSAGING_SERVICE_SID: MG, APP_URL: APP } };

type Params = Record<string, string>;
type Page = (p: { params: Promise<Params>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Params, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

/** With LP_RENDER_DIR set, the seller pages are also written there as HTML (visual check). */
const save = (name: string, html: string) => {
  const dir = process.env.LP_RENDER_DIR;
  if (!dir) return;
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};

describe("lead pages: a returning number from another browser gets its own unverified lead", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let page: LeadPage;
  let ipN = 0;
  let phoneN = 3000;
  const nextPhone = () => `+9725472${String(++phoneN).padStart(5, "0")}`;
  const submit = async (p: LeadPage, body: Record<string, unknown>, opts: { cookie?: string } = {}) => {
    const h: Record<string, string> = { origin: APP };
    if (opts.cookie) h.cookie = `sas_lp=${opts.cookie}`;
    const r = await submitLeadPage(db, {
      key: p.publicKey, headers: new Headers(h), ip: `10.40.${Math.floor(++ipN / 200)}.${ipN % 200}`, env: { APP_URL: APP },
      body: { ft: formTimingToken(p.id, Date.now() - 5000), consent: "on", ...body },
    });
    return r;
  };
  const handover = async (p: LeadPage, body: Record<string, unknown>, opts: { cookie?: string } = {}) => {
    const r = await submit(p, body, opts);
    if (r.kind !== "handover") throw new Error(JSON.stringify(r));
    return r;
  };
  const leadById = async (id: string) => (await db.select().from(leads).where(eq(leads.id, id)))[0];
  const eventsOf = async (leadId: string) => db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId));
  const convsOf = async (leadId: string) => db.select().from(conversations).where(eq(conversations.leadId, leadId));
  const firstMessage = async (convId: string) => (await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(messages.createdAt))[0];
  const backdate = (submissionId: string) =>
    db.update(leadPageSubmissions).set({ createdAt: new Date(Date.now() - REPEAT_MS - 60_000) }).where(eq(leadPageSubmissions.id, submissionId));

  /** Existing lead E (Dana Levi) with a chat, a quote, deal state and a buyer message; then U from another browser. */
  let phone: string;
  let existingId: string, unverifiedId: string;
  let existingBefore: Awaited<ReturnType<typeof leadById>>;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "seller.person@example.test", firstName: "Sam", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
    if (!p.ok) throw new Error();
    const acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    for (const lang of ["en", "he"]) {
      await db.insert(legalSections).values({ accountId: acc, sectionKey: "privacy_notice", title: "Privacy notice", language: lang, version: 1, body: "We keep your details." });
    }
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
    const r = await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name: "Spring offer", connection: "link", language: "en", fields: { company: "on", email: "on" }, openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" } });
    if (!r.ok) throw new Error();
    const live = await goLiveLeadPage(db, { userId: me.id, actingAs: false }, acc, r.page.id);
    if (!live.ok) throw new Error();
    page = live.page;
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("creates a separate real lead with a placeholder phone; the existing lead is not changed (one timeline note)", async () => {
    phone = nextPhone();
    const first = await handover(page, { name: "Dana Levi", phone, company: "Cafe Dana", email: "dana@cafe.test" });
    existingId = first.newLeadId!;
    await loadHandover(db, { token: first.token, cookie: null, ip: "10.41.0.1" });
    const [conv] = await convsOf(existingId);
    // The existing lead's private state: a quote, deal state, a buyer message; a person is handling it.
    await db.insert(quotes).values({ id: crypto.randomUUID(), accountId: account.id, leadId: existingId, number: 4242, status: "sent" });
    const draft = await ensureDraftVersion(db, account.id);
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "SecretBakery", provenance: "buyer" }], next_step: null, objection: null },
      { db, accountId: account.id, conversationId: conv.id, leadId: existingId, playbook: draft.playbook, currency: "ILS", callId: "u-secret", language: "en" });
    await db.insert(messages).values({ accountId: account.id, conversationId: conv.id, actor: "buyer", body: "My door code is ZEBRA42" });
    await db.update(leads).set({ status: "human_handling" }).where(eq(leads.id, existingId));
    await db.update(conversations).set({ status: "human" }).where(eq(conversations.id, conv.id));
    existingBefore = await leadById(existingId);
    const consentBefore = (await db.select().from(consentRecords).where(eq(consentRecords.leadId, existingId))).length;
    const eventsBefore = (await eventsOf(existingId)).length;

    // Another browser (no cookie), same number: the same result shape as a brand-new buyer.
    const second = await handover(page, { name: "Someone Else", phone, company: "Other Co", email: "someone@other.test" });
    expect(second).toMatchObject({ kind: "handover", repeat: false, newLeadId: expect.any(String) });
    unverifiedId = second.newLeadId!;
    expect(unverifiedId).not.toBe(existingId);
    const u = await leadById(unverifiedId);
    expect(u.phone).toMatch(/^lp:[0-9a-f]{32}$/);
    expect(isUnverifiedLead(u)).toBe(true);
    expect(hasDialablePhone(u)).toBe(false);
    // A real lead: no buyer ID, not a test lead; from this page with this form's details.
    expect(u).toMatchObject({
      accountId: account.id, buyerRef: null, isTest: false, fullName: "Someone Else", company: "Other Co", email: "someone@other.test",
      origin: "webhook", sourceLabel: "Spring offer", leadPageId: page.id, language: "en",
    });
    expect(u.marketId).toBe(existingBefore.marketId);
    // Its own consent record from this form.
    const [consent] = await db.select().from(consentRecords).where(eq(consentRecords.leadId, unverifiedId));
    expect(consent.wording).toContain("Polar Demo and its automated assistant");
    // The claim: on the submission and on the new lead's event; the existing lead gets one note.
    const [sub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, second.submissionId));
    expect(sub).toMatchObject({ leadId: unverifiedId, leadCreated: true, consent: true, answers: { firstName: "Someone", claimedPhone: phone } });
    const uEvents = await eventsOf(unverifiedId);
    expect(uEvents.find((e) => e.type === "lead_page.unverified_claim")?.data).toEqual({ pageId: page.id, page: "Spring offer", submissionId: second.submissionId, claimedPhone: phone, sameAsLeadId: existingId });
    const eEvents = await eventsOf(existingId);
    expect(eEvents).toHaveLength(eventsBefore + 1);
    expect(eEvents.find((e) => e.type === "lead_page.number_reused")?.data).toEqual({ pageId: page.id, page: "Spring offer", submissionId: second.submissionId, otherLeadId: unverifiedId });
    // The existing lead is untouched: name, company, email, source, page, status, consent.
    expect(await leadById(existingId)).toEqual(existingBefore);
    expect((await db.select().from(consentRecords).where(eq(consentRecords.leadId, existingId))).length).toBe(consentBefore);

    // The normal hand-over: the chat, a fresh conversation with the normal new-lead opener; no SMS tried.
    const sentBefore = LIVE_SMS.transport.sent.length;
    const h = await loadHandover(db, { token: second.token, cookie: null, ip: "10.41.0.2", sms: LIVE_SMS });
    expect(h).toMatchObject({ kind: "ready", variant: "chat", firstName: "Someone", sms: null });
    if (h.kind !== "ready" || !h.chat) throw new Error();
    expect(h.chat.ctx.lead.id).toBe(unverifiedId);
    expect(LIVE_SMS.transport.sent.length).toBe(sentBefore);
    expect((await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, second.submissionId)))[0].sms).toBeNull();
    expect([...await eventsOf(unverifiedId), ...await eventsOf(existingId)].filter((e) => e.type.startsWith("sms."))).toEqual(
      (await eventsOf(existingId)).filter((e) => e.type.startsWith("sms.")),
    );
    expect((await eventsOf(unverifiedId)).filter((e) => e.type.startsWith("sms."))).toEqual([]);
    const uConvs = await convsOf(unverifiedId);
    expect(uConvs).toHaveLength(1);
    expect(uConvs[0]).toMatchObject({ channel: "chat", status: "open" });
    const uOpener = await firstMessage(uConvs[0].id);
    const eOpener = await firstMessage(conv.id);
    expect(uOpener.actor).toBe("agent");
    expect(uOpener.body).toContain("You asked about Fridge monitoring.");
    expect(uOpener.body).toBe(eOpener.body.replace("Dana", "Someone"));
    // The existing lead's conversation and state did not move.
    expect(await convsOf(existingId)).toHaveLength(1);
    expect(await leadById(existingId)).toEqual(existingBefore);
  });

  it("isolation: the new lead's agent context and tools never see the existing lead's quote, deal state, messages or name", async () => {
    const [conv] = await convsOf(unverifiedId);
    const facts = await loadStageFacts(db, account.id, unverifiedId);
    expect(JSON.stringify(facts)).not.toContain("4242");
    const llm = new ScriptedLlm([() => ({ content: [{ type: "text" as const, text: "Happy to help." }] })]);
    const turn = await runBuyerTurn(db, llm, { accountId: account.id, conversationId: conv.id, text: "What did I tell you before?" });
    expect(turn.status).toBe("replied");
    const seen = JSON.stringify(llm.requests);
    for (const secret of ["ZEBRA42", "SecretBakery", "4242", "Dana", "Cafe Dana", "dana@cafe.test", existingId]) expect(seen).not.toContain(secret);
    const draft = await ensureDraftVersion(db, account.id);
    const ctx = { db, accountId: account.id, conversationId: conv.id, leadId: unverifiedId, playbook: draft.playbook, currency: "ILS", callId: "u-check", language: "en" };
    const pay = await runTool("check_payment", {}, ctx);
    expect(JSON.stringify(pay)).not.toContain("4242");
    // The existing lead's deal state is untouched by the new lead's tools.
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Florist", provenance: "buyer" }], next_step: null, objection: null }, { ...ctx, callId: "u-florist" });
    expect(JSON.stringify(await loadStageFacts(db, account.id, existingId))).not.toContain("Florist");
    expect(await leadById(existingId)).toEqual(existingBefore);
  });

  it("the same browser again: the unverified lead's cookie reopens ITS conversation; the existing lead's cookie keeps the existing one", async () => {
    const [uSub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.leadId, unverifiedId));
    // A double click within 10 minutes: the same hand-over.
    const dbl = await handover(page, { name: "Someone Else", phone }, { cookie: leadCookieValue(unverifiedId) });
    expect(dbl).toMatchObject({ repeat: true, submissionId: uSub.id, newLeadId: null });
    await backdate(uSub.id);
    const leadsBefore = (await db.select().from(leads).where(eq(leads.accountId, account.id))).length;
    const again = await handover(page, { name: "Someone Else", phone }, { cookie: leadCookieValue(unverifiedId) });
    expect(again).toMatchObject({ repeat: false, newLeadId: null });
    expect((await db.select().from(leads).where(eq(leads.accountId, account.id))).length).toBe(leadsBefore);
    expect((await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, again.submissionId)))[0]).toMatchObject({ leadId: unverifiedId, leadCreated: false, consent: true });
    const h = await loadHandover(db, { token: again.token, cookie: leadCookieValue(unverifiedId), ip: "10.41.0.3" });
    if (h.kind !== "ready" || !h.chat) throw new Error(JSON.stringify(h));
    expect(h.chat.ctx.lead.id).toBe(unverifiedId);
    expect(await convsOf(unverifiedId)).toHaveLength(1);
    // Without the cookie the same hand-over link never opens it.
    expect(await loadHandover(db, { token: again.token, cookie: null, ip: "10.41.0.4" })).toMatchObject({ variant: "received", chat: null });

    // The existing lead's own browser: today's behaviour, its own conversation.
    const own = await handover(page, { name: "Dana Levi", phone }, { cookie: leadCookieValue(existingId) });
    expect((await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, own.submissionId)))[0]).toMatchObject({ leadId: existingId });
    await db.update(leads).set({ status: "agent_handling" }).where(eq(leads.id, existingId));
    await db.update(conversations).set({ status: "open" }).where(eq(conversations.leadId, existingId));
    const eh = await loadHandover(db, { token: own.token, cookie: leadCookieValue(existingId), ip: "10.41.0.5" });
    if (eh.kind !== "ready" || !eh.chat) throw new Error(JSON.stringify(eh));
    expect(eh.chat.ctx.lead.id).toBe(existingId);
  });

  it("an existing lead that is opted out or has no consent: the new conversation still opens; the existing lead is untouched and gets no message", async () => {
    const gonePhone = nextPhone();
    const [gone] = await db.insert(leads).values({ accountId: account.id, fullName: "Gone Person", phone: gonePhone, language: "en", origin: "manual", status: "opted_out" }).returning();
    const r1 = await handover(page, { name: "New Buyer", phone: gonePhone });
    expect(r1.newLeadId).not.toBe(gone.id);
    expect(await loadHandover(db, { token: r1.token, cookie: null, ip: "10.41.1.1" })).toMatchObject({ variant: "chat" });
    expect(await leadById(gone.id)).toEqual(gone);
    expect(await convsOf(gone.id)).toHaveLength(0);

    const quietPhone = nextPhone();
    const noConsent = await handover(page, { name: "Quiet Person", phone: quietPhone, consent: "" });
    const quiet = await leadById(noConsent.newLeadId!);
    const r2 = await handover(page, { name: "Quiet Person", phone: quietPhone });
    expect(r2.newLeadId).not.toBe(quiet.id);
    expect(await loadHandover(db, { token: r2.token, cookie: null, ip: "10.41.1.2" })).toMatchObject({ variant: "chat" });
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, quiet.id))).toHaveLength(0);
    expect(await leadById(quiet.id)).toEqual(quiet);
    expect(await convsOf(quiet.id)).toHaveLength(0);
    // The new lead without a tick: the deliberate no-consent screen (as for a new buyer).
    const r3 = await handover(page, { name: "Quiet Again", phone: quietPhone, consent: "" });
    expect(await loadHandover(db, { token: r3.token, cookie: null, ip: "10.41.1.3" })).toMatchObject({ variant: "received", chat: null });
  });

  it("limits: at most 3 unverified leads per claimed number and page a day, then the plain busy refusal", async () => {
    const p2 = nextPhone();
    await db.insert(leads).values({ accountId: account.id, fullName: "Known Elsewhere", phone: p2, language: "en", origin: "manual" });
    for (let i = 0; i < 3; i++) expect((await submit(page, { name: `Try ${i}`, phone: p2 })).kind).toBe("handover");
    expect(await submit(page, { name: "Try 4", phone: p2 })).toMatchObject({ kind: "busy" });
    const claims = await db.select().from(leadEvents).where(and(eq(leadEvents.accountId, account.id), eq(leadEvents.type, "lead_page.unverified_claim")));
    expect(claims.filter((c) => (c.data as { claimedPhone?: string }).claimedPhone === p2)).toHaveLength(3);
  });

  it("counts as a real lead in the page numbers and lists", async () => {
    const r = await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name: "Funnel page", connection: "link", language: "en" });
    if (!r.ok) throw new Error();
    const live = await goLiveLeadPage(db, { userId: me.id, actingAs: false }, account.id, r.page.id);
    if (!live.ok) throw new Error();
    const fp = live.page;
    const p3 = nextPhone();
    const a = await handover(fp, { name: "First Visit", phone: p3 });
    const b = await handover(fp, { name: "Second Browser", phone: p3 });
    await loadHandover(db, { token: a.token, cookie: null, ip: "10.41.2.1" });
    await loadHandover(db, { token: b.token, cookie: null, ip: "10.41.2.2" });
    const [cb] = await convsOf(b.newLeadId!);
    await db.insert(messages).values({ accountId: account.id, conversationId: cb.id, actor: "buyer", body: "Hi" });
    const f = await pageFunnel(db, account.id, fp.id, rangeOfDays(30));
    expect(f).toMatchObject({ leftDetails: 2, startedTalking: 1 });
    expect((await listTotals(db, account.id, rangeOfDays(30))).perPage.get(fp.id)).toMatchObject({ leftDetails: 2 });
    // In the Leads list (not hidden as simulated or test) and the Conversations list.
    const listed = await listLeads(db, account.id, { tab: "all" } as Parameters<typeof listLeads>[2]);
    expect(listed.rows.map((x) => x.lead.id)).toContain(b.newLeadId);
    const inbox = await listInbox(db, account.id, { filter: "all", sort: "newest", q: undefined, page: 1, now: new Date(), simulateRules: false, market: null } as Parameters<typeof listInbox>[2]);
    expect(inbox.rows.map((x) => x.lead.id)).toContain(b.newLeadId);
  });

  it("every outbound path to the phone skips it cleanly: SMS kinds, WhatsApp, team calls; nothing recorded as failed", async () => {
    const [conv] = await convsOf(unverifiedId);
    const [m] = await db.insert(messages).values({ accountId: account.id, conversationId: conv.id, actor: "agent", body: "Your quote is ready." }).returning();
    const before = (await eventsOf(unverifiedId)).length;
    const deps = { transport: LIVE_SMS.transport, env: LIVE_SMS.env };
    const sent = LIVE_SMS.transport.sent.length;
    expect(await sendChatLink(db, { userId: null, actingAs: false }, account.id, unverifiedId, deps)).toEqual({ outcome: "skipped", reason: "no_phone" });
    expect(await nudgeQuoteReady(db, account.id, unverifiedId, m.id, deps)).toEqual({ outcome: "skipped", reason: "no_phone" });
    expect(await nudgeFollowUp(db, account.id, unverifiedId, m.id, true, deps)).toEqual({ outcome: "skipped", reason: "no_phone" });
    expect(await nudgePayReminder(db, account.id, unverifiedId, m.id, deps)).toEqual({ outcome: "skipped", reason: "no_phone" });
    for (const kind of ["team_call", "named_time_retry", "page_link", "chat_link"] as const) {
      expect(await nudgeBuyer(db, { userId: null, actingAs: false }, { accountId: account.id, leadId: unverifiedId, kind, time: "Mon 10:00" }, deps)).toEqual({ outcome: "refused", reason: "no_phone" });
    }
    expect(LIVE_SMS.transport.sent.length).toBe(sent);
    // Nothing recorded (no "not sent" or "failed" noise in the thread).
    expect((await eventsOf(unverifiedId)).length).toBe(before);
    // WhatsApp: the opener is refused quietly (the lead card hides the WhatsApp start for it).
    expect((await openerFacts(db, null, account.id, unverifiedId))?.refusal).toBe("no_phone");
  });

  it("seller side: the card, the timelines, the Leads and Conversations rows, and the phone search find both leads", async () => {
    const card = await render(LeadCardPage, { account: account.slug, leadId: unverifiedId });
    save("returning-card", card);
    expect(card).toContain("Came back from Spring offer · phone not verified");
    expect(card).toMatch(/same number as <a href="\/app\/[^"]+\/leads\/[^"]+"><bdi>Dana Levi<\/bdi><\/a>/);
    expect(card).toContain(`/leads/${existingId}`);
    expect(card).toContain('data-unverified="">not verified</span>');
    expect(card).toContain("data-claimed-phone");
    expect(card).not.toMatch(/lp:[0-9a-f]/);
    expect(card).not.toContain("dana@cafe.test");

    const existingCard = await render(LeadCardPage, { account: account.slug, leadId: existingId });
    save("returning-existingCard", existingCard);
    expect(existingCard).toContain("Someone left this number on Spring offer in another browser · not verified");
    expect(existingCard).toContain(`href="/app/${account.slug}/leads/${unverifiedId}"`);
    expect(existingCard).not.toContain("someone@other.test");

    const digits = phone.replace(/\D/g, "").slice(-7);
    const list = await render(LeadsPage, { account: account.slug }, { view: "all", q: digits });
    save("returning-list", list);
    expect(list).toContain("not verified · same number as Dana Levi");
    expect(list).toContain(`/leads/${unverifiedId}`);
    expect(list).toContain(`/leads/${existingId}`);
    // The placeholder's random digits never match a search.
    const u = await leadById(unverifiedId);
    const hexDigits = u.phone.slice(3).replace(/\D/g, "").slice(0, 6);
    if (hexDigits.length >= 3) {
      const miss = await listLeads(db, account.id, { tab: "all", q: hexDigits } as Parameters<typeof listLeads>[2]);
      expect(miss.rows.map((x) => x.lead.id)).not.toContain(unverifiedId);
    }

    const inbox = await render(ConversationsPage, { account: account.slug }, { q: digits });
    save("returning-inbox", inbox);
    expect(inbox).toContain("not verified · same number as Dana Levi");
    expect(inbox).toContain("Someone Else");
    expect(inbox).toContain("Dana Levi");
    expect(await db.select().from(leads).where(like(leads.phone, "sim:%"))).toHaveLength(0);
  });
});

/**
 * Lead pages: preview runs (owner rule 26 Nov). A send with the seller's preview token never touches a real
 * lead or the real-buyer cookie (sas_lp): it makes a preview run, a test lead with a placeholder phone
 * ("lp:preview:…"), the typed number only a claim. "Open" continues this page's latest run for the number;
 * "Start over" (`fresh`, from the seller's page view or the link inside a run) always makes a new run: a new
 * test lead and a new conversation with the opener, even with the same number in the same browser. Preview
 * runs stay out of the numbers and every outbound path; the seller sees "Preview run · {time}".
 * Real buyers are unchanged (their returning-number and cookie tests live in lead-pages-returning).
 * Template opener and mock SMS only: no model call, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import {
  conversations, leadEvents, leadPageSubmissions, leads, legalSections, messages, sellerAccounts, users,
  type LeadPage, type SellerAccount, type User,
} from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, cookie: null as string | null }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000", "x-forwarded-for": "10.77.0.1" }),
  cookies: async () => ({ get: (n: string) => (n === "sas_lp" && holder.cookie ? { name: n, value: holder.cookie } : undefined) }),
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
const { REPEAT_MS, submitLeadPage } = await import("@/lib/lead-pages/intake");
const { loadHandover, recordHandoverChoice } = await import("@/lib/lead-pages/handover");
const { createLeadPage, goLiveLeadPage, latestLeadsOfPage } = await import("@/lib/lead-pages/service");
const { pageFunnel, rangeOfDays } = await import("@/lib/lead-pages/stats");
const { formTimingToken, leadCookieValue, previewTokenFor } = await import("@/lib/lead-pages/tokens");
const { startOverForLead, previewFormUrl } = await import("@/lib/lead-pages/preview-run");
const { hasDialablePhone, isPreviewRunLead, isUnverifiedLead } = await import("@/lib/leads/unverified");
const { overviewKpis } = await import("@/lib/overview/service");
const { nudgeBuyer } = await import("@/lib/sms/service");
const { MockSmsTransport } = await import("@/lib/sms/transport");
const { decideDue } = await import("@/lib/follow-ups/rules");
const { activeChatToken } = await import("@/lib/simulator/service");
const { POST: submitRoute } = await import("@/app/api/lp/[key]/submit/route");
const { default: FormPage } = await import("@/app/p/[key]/page");
const { default: HandoverPage } = await import("@/app/h/[token]/page");
const { default: ChatPage } = await import("@/app/chat/[token]/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: PageView } = await import("@/app/app/[account]/lead-pages/[pageId]/page");

const APP = "http://localhost:3000";
const MG = `MG${"c".repeat(32)}`;
const LIVE_SMS = { transport: new MockSmsTransport(), env: { SMS_MODE: "live", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_MESSAGING_SERVICE_SID: MG, APP_URL: APP } };

type Params = Record<string, string>;
type Page = (p: { params: Promise<Params>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Params, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

describe("lead pages: preview runs (Open continues, Start over is a new run; never a real lead)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let page: LeadPage;
  let ipN = 0;
  let phoneN = 6000;
  const nextPhone = () => `+9725472${String(++phoneN).padStart(5, "0")}`;
  const token = () => previewTokenFor(page.id, new Date());
  const submit = async (body: Record<string, unknown>, opts: { cookie?: string; p?: LeadPage } = {}) => {
    const p = opts.p ?? page;
    const h: Record<string, string> = { origin: APP };
    if (opts.cookie) h.cookie = `sas_lp=${opts.cookie}`;
    const r = await submitLeadPage(db, {
      key: p.publicKey, headers: new Headers(h), ip: `10.70.${Math.floor(++ipN / 200)}.${ipN % 200}`, env: { APP_URL: APP },
      body: { ft: formTimingToken(p.id, Date.now() - 5000), consent: "on", ...body },
    });
    if (r.kind !== "handover") throw new Error(JSON.stringify(r));
    return r;
  };
  const subById = async (id: string) => (await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, id)))[0];
  const leadById = async (id: string) => (await db.select().from(leads).where(eq(leads.id, id)))[0];
  const convsOf = async (leadId: string) => db.select().from(conversations).where(eq(conversations.leadId, leadId));
  const firstMessage = async (convId: string) => (await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(messages.createdAt))[0];
  const hand = async (tok: string) => loadHandover(db, { token: tok, cookie: holder.cookie, ip: `10.71.0.${++ipN % 250}` });

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
    const r = await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name: "Spring offer", connection: "link", language: "en", fields: { company: "on" }, openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" } });
    if (!r.ok) throw new Error();
    // A draft page: only preview sends are taken.
    page = r.page;
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("Start over twice with the same number in the same browser: two test leads, two conversations, each with the opener; no cookie", async () => {
    const phone = nextPhone();
    const a = await submit({ name: "Dana Test", phone, preview: token(), fresh: "1" });
    const b = await submit({ name: "Dana Test", phone, preview: token(), fresh: "1" });
    expect(a.newLeadId).toBeNull();
    expect(b.newLeadId).toBeNull();
    expect(b.token).not.toBe(a.token);
    const [sa, sb] = [await subById(a.submissionId), await subById(b.submissionId)];
    expect(sa.leadId).not.toBe(sb.leadId);
    expect(sa).toMatchObject({ preview: true, leadCreated: true, consent: true, answers: { firstName: "Dana", claimedPhone: phone } });
    for (const s of [sa, sb]) {
      const lead = await leadById(s.leadId);
      expect(lead.phone).toMatch(/^lp:preview:[0-9a-f]{32}$/);
      expect(isPreviewRunLead(lead) && isUnverifiedLead(lead) && !hasDialablePhone(lead)).toBe(true);
      expect(lead.isTest).toBe(false);
      // The hand-over opens the chat (no cookie needed) and starts the conversation with the opener.
      const h = await hand(s.id === sa.id ? a.token : b.token);
      expect(h).toMatchObject({ kind: "ready", variant: "chat" });
      if (h.kind !== "ready") throw new Error();
      expect(h.sms).toBeNull();
      expect(h.startOver).toMatch(new RegExp(`^/p/${page.publicKey}\\?preview=[^&]+&fresh=1$`));
      const convs = await convsOf(s.leadId);
      expect(convs).toHaveLength(1);
      expect((await firstMessage(convs[0].id)).body).toContain("Fridge monitoring");
    }
    // No real lead with the typed number, and no unverified-claim notes anywhere.
    expect(await db.select().from(leads).where(and(eq(leads.accountId, account.id), eq(leads.phone, phone)))).toHaveLength(0);
    expect((await db.select().from(leadEvents).where(eq(leadEvents.type, "lead_page.unverified_claim")))).toHaveLength(0);
    // The choice is recorded for the run without any cookie.
    expect(await recordHandoverChoice(db, { token: a.token, choice: "text", cookie: null, staffViewer: async () => true })).toEqual({ ok: true });
  });

  it("Open: the same number again continues this page's latest run (its hand-over within 10 minutes, then the same lead and conversation); a reload shows that run", async () => {
    const phone = nextPhone();
    const a = await submit({ name: "Omer Test", phone, preview: token() });
    await hand(a.token);
    const again = await submit({ name: "Omer Test", phone, preview: token() });
    expect(again).toMatchObject({ token: a.token, repeat: true, newLeadId: null });
    // A reload of the hand-over shows that same run.
    const r1 = await hand(a.token);
    const r2 = await hand(a.token);
    expect(r1.kind === "ready" && r2.kind === "ready" && r1.chat?.token === r2.chat?.token).toBe(true);
    await db.update(leadPageSubmissions).set({ createdAt: new Date(Date.now() - REPEAT_MS - 60_000) }).where(eq(leadPageSubmissions.id, a.submissionId));
    const later = await submit({ name: "Omer Test", phone, preview: token() });
    expect(later.repeat).toBe(false);
    const sl = await subById(later.submissionId);
    expect(sl.leadId).toBe((await subById(a.submissionId)).leadId);
    expect(sl.leadCreated).toBe(false);
    const h = await hand(later.token);
    expect(h).toMatchObject({ kind: "ready", variant: "chat" });
    expect(await convsOf(sl.leadId)).toHaveLength(1);
    // Start over after it: a new run, which "Open" then continues.
    const fresh = await submit({ name: "Omer Test", phone, preview: token(), fresh: "1" });
    const fl = (await subById(fresh.submissionId)).leadId;
    expect(fl).not.toBe(sl.leadId);
    expect((await submit({ name: "Omer Test", phone, preview: token() })).token).toBe(fresh.token);
  });

  it("never a real lead: a preview with a real buyer's number and that buyer's sas_lp cookie leaves the real lead untouched", async () => {
    const livePage = (await goLiveLeadPage(db, { userId: me.id, actingAs: false }, account.id, (await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name: "Live page", connection: "link", language: "en", fields: {}, openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" } }) as { page: LeadPage }).page.id) as { page: LeadPage }).page;
    const phone = nextPhone();
    const real = await submit({ name: "Real Buyer", phone }, { p: livePage });
    expect(real.newLeadId).not.toBeNull();
    const cookie = leadCookieValue(real.newLeadId!);
    const before = await leadById(real.newLeadId!);
    const pv = await submit({ name: "Seller Test", phone, preview: previewTokenFor(livePage.id, new Date()) }, { p: livePage, cookie });
    expect(pv.repeat).toBe(false);
    const sub = await subById(pv.submissionId);
    expect(sub.leadId).not.toBe(real.newLeadId);
    expect(isPreviewRunLead(await leadById(sub.leadId))).toBe(true);
    expect(await leadById(real.newLeadId!)).toEqual(before);
    expect((await db.select().from(leadEvents).where(eq(leadEvents.leadId, real.newLeadId!))).map((e) => e.type)).not.toContain("lead_page.number_reused");
    // The real buyer's own resend in their browser still gets their earlier hand-over (cookie rule unchanged).
    expect((await submit({ name: "Real Buyer", phone }, { p: livePage, cookie })).token).toBe(real.token);
  });

  it("the submit route never sets the real-buyer cookie on a preview send", async () => {
    const livePage = page;
    const post = (body: Record<string, unknown>) => submitRoute(new Request(`${APP}/api/lp/${livePage.publicKey}/submit`, {
      method: "POST", headers: { "content-type": "application/json", origin: APP, "x-forwarded-for": `10.72.0.${++ipN % 250}` },
      body: JSON.stringify({ ft: formTimingToken(livePage.id, Date.now() - 5000), consent: "on", ...body }),
    }), { params: Promise.resolve({ key: livePage.publicKey }) });
    const res = await post({ name: "Route Test", phone: nextPhone(), preview: token(), fresh: "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("left out of the numbers and of every outbound path", async () => {
    const phone = nextPhone();
    const r = await submit({ name: "Count Test", phone, preview: token(), fresh: "1" });
    await hand(r.token);
    const leadId = (await subById(r.submissionId)).leadId;
    const lead = await leadById(leadId);
    const range = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };
    const k = await overviewKpis(db, account.id, range);
    const all = await db.select().from(leads).where(and(eq(leads.accountId, account.id), eq(leads.isTest, false)));
    expect(k.newLeads).toBe(all.filter((l) => !isPreviewRunLead(l) && !l.buyerRef).length);
    expect((await pageFunnel(db, account.id, page.id, rangeOfDays(30))).leftDetails).toBe(0);
    // No SMS of any kind (no phone of its own), and follow-ups are cancelled.
    const sms = await nudgeBuyer(db, { userId: null, actingAs: false }, { accountId: account.id, leadId, kind: "page_link" }, LIVE_SMS);
    expect(sms.outcome).not.toBe("sent");
    expect(hasDialablePhone(lead)).toBe(false);
    expect(decideDue({ leadOptedOut: false, accountStatus: "live", needsLiveAccount: false, conversationStatus: "open", paid: false, buyerWroteAfterScheduling: false, withinContactHours: true, previewRun: true }))
      .toEqual({ action: "cancel", reason: "preview_run" });
  });

  it("Start over renders only for preview runs (form, hand-over, chat), never for a real buyer; from the chat it lands on the empty form and the next send is a new run", async () => {
    // The form: only with a valid preview token.
    const tok = token();
    const pform = await render(FormPage, { key: page.publicKey }, { preview: tok });
    expect(pform).toContain("data-preview-start-over");
    expect(pform).toContain(`href="/p/${page.publicKey}?preview=${encodeURIComponent(tok)}&amp;fresh=1"`);
    expect(pform).not.toContain('name="fresh"');
    const liveP = ((await goLiveLeadPage(db, { userId: me.id, actingAs: false }, account.id, (await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name: "Buyer page", connection: "link", language: "he", fields: {}, openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" } }) as { page: LeadPage }).page.id) as { page: LeadPage }).page);
    const realForm = await render(FormPage, { key: liveP.publicKey });
    expect(realForm).not.toContain("data-preview-start-over");
    expect(realForm).not.toContain("להתחיל מחדש");

    // A real buyer's hand-over and chat: no link.
    const real = await submit({ name: "Real Person", phone: nextPhone() }, { p: liveP });
    const realHand = renderToStaticMarkup(await HandoverPage({ params: Promise.resolve({ token: real.token }) }));
    expect(realHand).toContain('data-handover="chat"');
    expect(realHand).not.toContain("data-preview-start-over");
    const realChatToken = await activeChatToken(db, account.id, real.newLeadId!);
    const realChat = await render(ChatPage, { token: realChatToken! });
    expect(realChat).not.toContain("data-preview-start-over");
    expect(await startOverForLead(db, account.id, await leadById(real.newLeadId!), new Date())).toBeNull();

    // A preview run's hand-over (chat mounted under it) and its chat: the link.
    const phone = nextPhone();
    const run = await submit({ name: "Noa Test", phone, preview: tok, fresh: "1" });
    const runHand = renderToStaticMarkup(await HandoverPage({ params: Promise.resolve({ token: run.token }) }));
    expect(runHand.match(/data-preview-start-over/g)?.length).toBe(2);
    const runLead = (await subById(run.submissionId)).leadId;
    const chatToken = await activeChatToken(db, account.id, runLead);
    const runChat = await render(ChatPage, { token: chatToken! });
    const href = /data-preview-start-over=""><a href="([^"]+)"/.exec(runChat)?.[1]?.replace(/&amp;/g, "&");
    expect(href).toMatch(new RegExp(`^/p/${page.publicKey}\\?preview=[^&]+&fresh=1$`));

    // Following it: the empty preview form with the fresh flag; its send is a new run (new lead, new conversation).
    const u = new URL(href!, APP);
    const sp = Object.fromEntries(u.searchParams.entries());
    const back = await render(FormPage, { key: page.publicKey }, sp);
    expect(back).toContain('name="fresh" value="1"');
    expect(back).toContain('name="preview"');
    expect(back).not.toContain("Noa");
    const next = await submit({ name: "Noa Test", phone, preview: sp.preview, fresh: sp.fresh });
    const nextLead = (await subById(next.submissionId)).leadId;
    expect(nextLead).not.toBe(runLead);
    await hand(next.token);
    expect(await convsOf(nextLead)).toHaveLength(1);
  });

  it("the seller sees Preview run · {time} on the lead row, the card and the page's latest leads, and Start over next to Open", async () => {
    const r = await submit({ name: "Row Test", phone: nextPhone(), preview: token(), fresh: "1" });
    await hand(r.token);
    const leadId = (await subById(r.submissionId)).leadId;
    const card = await render(LeadCardPage, { account: account.slug, leadId });
    expect(card).toMatch(/data-preview-run="">Preview run · [^<]+</);
    expect(card).not.toContain("lp:preview:");
    expect(card).not.toContain("data-unverified-line");
    const list = await render(LeadsPage, { account: account.slug }, { view: "all", q: "Row Test" });
    expect(list).toMatch(/data-preview-run="">Preview run · [^<]+</);
    expect(list).not.toContain("lp:preview:");
    const latest = await latestLeadsOfPage(db, account.id, page.id, 50);
    expect(latest.rows.find((x) => x.leadId === leadId)?.preview).toBe(true);
    const view = await render(PageView, { account: account.slug, pageId: page.id }, { pl: token() });
    expect(view).toContain('data-preview-run="">Preview run<');
    expect(view).toMatch(/data-preview-start-over=""[^>]*>.*Start over/);
    expect(view).toMatch(/href="[^"]*\?preview=[^"&]+&amp;fresh=1"[^>]*data-preview-start-over/);
    // The hosted form address for the snippet's own page would carry the fragment flag instead.
    expect(previewFormUrl({ publicKey: "k", connection: "snippet", address: "https://acme.example/contact" }, "tok", { fresh: true })).toBe("https://acme.example/contact#sas-preview=tok&sas-fresh=1");
    expect(previewFormUrl({ publicKey: "k", connection: "own_form", address: null }, "tok", { fresh: true })).toBeNull();
  });
});

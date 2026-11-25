/**
 * Lead pages slice b on PGlite: the snippet's public endpoints through their
 * route handlers (config, submit, beacon): CORS for allowed origins only (echo,
 * Vary, no credentials, OPTIONS), refused origins recorded, drafts 404 unless
 * previewed, the "snippet seen" check, the pixel switch and the consent default
 * in the config, a preview visit ticking "The form opened from the link" without
 * counting, and the buyer chat never saying "SMS sent" for an SMS that was not sent.
 * Mock SMS or a fake transport only; no model calls, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { leadEvents, leadPageDaily, leadPageSubmissions, consentRecords, legalSections, markets, sellerAccounts, users, leads, type LeadPage, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { chatReach } from "@/lib/chat/reach";
import { loadHandover } from "@/lib/lead-pages/handover";
import { createLeadPage, getLeadPage, goLiveLeadPage, leadPageReadiness, pauseLeadPage, updateLeadPage, rawOf } from "@/lib/lead-pages/service";
import { formTimingToken, previewTokenFor, submissionIdFromHandoverToken } from "@/lib/lead-pages/tokens";
import { seenOriginSuggestion } from "@/lib/lead-pages/view";
import { MockSmsTransport } from "@/lib/sms/transport";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));

const config = await import("@/app/api/lp/[key]/config/route");
const submitRoute = await import("@/app/api/lp/[key]/submit/route");
const beacon = await import("@/app/api/lp/[key]/e/route");

const APP = "http://localhost:3000";
const SITE = "https://acme.com";
const MG = `MG${"c".repeat(32)}`;
const LIVE_SMS = { transport: new MockSmsTransport(), env: { SMS_MODE: "live", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_MESSAGING_SERVICE_SID: MG, APP_URL: APP } };

let ipN = 0;
const ip = () => `10.7.0.${++ipN}`;
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });
const get = (key: string, origin: string | null, query = "") =>
  config.GET(new Request(`${APP}/api/lp/${key}/config${query}`, { headers: { ...(origin ? { origin } : {}), "x-forwarded-for": ip() } }), ctx(key));
const options = (route: { OPTIONS: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, key: string, origin: string) =>
  route.OPTIONS(new Request(`${APP}/api/lp/${key}/x`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }), ctx(key));
const post = (route: { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, key: string, origin: string | null, body: unknown) =>
  route.POST(new Request(`${APP}/api/lp/${key}/x`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": ip(), ...(origin ? { origin } : {}) },
  }), ctx(key));

describe("lead pages (b): the snippet's endpoints", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let snippet: LeadPage, link: LeadPage, uk: LeadPage;
  const actor = () => ({ userId: me.id, actingAs: false });
  const account = async () => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc)))[0];
  const fresh = async (p: LeadPage) => (await getLeadPage(db, acc, p.id))!;
  const counters = async (p: LeadPage) => (await db.select().from(leadPageDaily).where(eq(leadPageDaily.pageId, p.id))).reduce((s, r) => ({ views: s.views + r.views, opens: s.opens + r.opens }), { views: 0, opens: 0 });
  const make = async (raw: Parameters<typeof createLeadPage>[3], live = true) => {
    const r = await createLeadPage(db, actor(), await account(), raw);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    if (!live) return r.page;
    const g = await goLiveLeadPage(db, actor(), acc, r.page.id);
    if (!g.ok) throw new Error(JSON.stringify(g));
    return g.page;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-b", email: "b@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "polar@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, actor(), acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    for (const lang of ["en", "he"]) {
      await db.insert(legalSections).values({ accountId: acc, sectionKey: "privacy_notice", title: "Privacy notice", language: lang, version: 1, body: "We keep your details to answer your request." });
    }
    snippet = await make({ name: "Spring offer", connection: "snippet", language: "en", address: `${SITE}/offer`, extraOrigins: ["staging.acme.com"], openingTopic: { en: "Fridge monitoring" }, fields: { company: "on" } });
    link = await make({ name: "Button page", connection: "link", language: "en" }, false);
    const [m] = await db.insert(markets).values({ id: crypto.randomUUID(), accountId: acc, name: "UK", countries: ["GB"] }).returning();
    uk = await make({ name: "UK page", connection: "snippet", language: "en", address: "https://acme.co.uk", marketId: m.id });
  });
  afterAll(async () => { await t.close(); });

  it("config: CORS for allowed origins only (exact, www twin, extra host), never credentials; the form's texts, fields and timing token", async () => {
    for (const origin of [SITE, "https://www.acme.com", "https://staging.acme.com"]) {
      const r = await get(snippet.publicKey, origin);
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe(origin);
      expect(r.headers.get("vary")).toBe("Origin");
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
      expect(r.headers.get("cache-control")).toBe("private, max-age=60");
    }
    const body = await (await get(snippet.publicKey, SITE)).json();
    expect(body).toMatchObject({
      v: 1, lang: "en", dir: "ltr", preview: false,
      text: { title: "Leave your details", name: "Full name", phone: "Mobile number", send: "Send", continue: "Continue to the chat" },
      about: "About: Fridge monitoring",
      fields: { company: true, email: false, sites: false },
      privacyUrl: `${APP}/p/${snippet.publicKey}/privacy`,
      tracking: { tellPagePixel: true, carryAdDetails: true },
      brand: { "--brand": expect.stringMatching(/^#/) },
    });
    expect(body.consent.line).toContain("Polar Demo");
    expect(body.ft).toMatch(/^[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    // Not allowed: http on an https page, another port, a subdomain not listed, a look-alike.
    for (const origin of ["http://acme.com", "https://acme.com:8443", "https://shop.acme.com", "https://acme.com.evil.io"]) {
      const r = await get(snippet.publicKey, origin);
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
    // No Origin and no Referer (a script on a server): refused.
    expect((await get(snippet.publicKey, null)).status).toBe(403);
    expect((await get("AAAAAAAAAAAA", SITE)).status).toBe(404);
  });

  it("config: the consent box default follows the market (ticked for Israel, unticked for the UK); the pixel switch is passed on", async () => {
    expect((await (await get(snippet.publicKey, SITE)).json()).consent.ticked).toBe(true);
    expect((await (await get(uk.publicKey, "https://acme.co.uk")).json()).consent.ticked).toBe(false);
    await updateLeadPage(db, actor(), await account(), uk.id, { ...rawOf(await fresh(uk)), tracking: { tellPagePixel: false, carryAdDetails: false } });
    expect((await (await get(uk.publicKey, "https://acme.co.uk")).json()).tracking).toEqual({ tellPagePixel: false, carryAdDetails: false });
  });

  it("a refused origin is recorded on the page (throttled) and suggested to the seller; the snippet-seen check ticks from an allowed config fetch", async () => {
    expect((await get(snippet.publicKey, "https://new-site.acme.org")).status).toBe(403);
    const p = await fresh(snippet);
    expect(p.checks).toMatchObject({ refusedOrigin: "https://new-site.acme.org", snippetOrigin: SITE });
    expect(p.checks.snippetSeenAt).toBeTruthy();
    expect(seenOriginSuggestion(p)).toBe("new-site.acme.org");
    // Throttled: a second refusal from the same origin within 10 minutes writes nothing new.
    const at = p.checks.refusedAt;
    await get(snippet.publicKey, "https://new-site.acme.org");
    expect((await fresh(snippet)).checks.refusedAt).toBe(at);
    expect((await leadPageReadiness(db, await account(), await fresh(snippet))).map((c) => [c.key, c.done])).toEqual([
      ["privacy_notice", true], ["account_live", true], ["snippet_seen", true], ["test_lead", false],
    ]);
    // Our own origin (the hosted form) never ticks "seen on your page".
    const before = (await fresh(link)).checks;
    await get(link.publicKey, APP, `?preview=${previewTokenFor(link.id, new Date())}`);
    expect((await fresh(link)).checks.snippetSeenAt).toBe(before.snippetSeenAt);
  });

  it("OPTIONS: the preflight answers allowed origins only, on config, submit and the beacon", async () => {
    for (const route of [config, submitRoute, beacon]) {
      const ok = await options(route, snippet.publicKey, "https://www.acme.com");
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://www.acme.com");
      expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
      expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
      const no = await options(route, snippet.publicKey, "https://evil.example");
      expect(no.status).toBe(403);
      expect(no.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("a draft has no config (404) unless the seller's preview token comes with it; a paused page says it is closed", async () => {
    const draft = await make({ name: "Draft", connection: "snippet", language: "he", address: SITE }, false);
    expect((await get(draft.publicKey, SITE)).status).toBe(404);
    expect((await get(draft.publicKey, SITE, "?preview=1.AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    const r = await get(draft.publicKey, SITE, `?preview=${previewTokenFor(draft.id, new Date())}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(await r.json()).toMatchObject({ preview: true, lang: "he", dir: "rtl", text: { title: "השאירו פרטים" } });
    // A preview from the seller's page also ticks "The snippet was seen on your page".
    expect((await fresh(draft)).checks.snippetSeenAt).toBeTruthy();
    await pauseLeadPage(db, actor(), acc, uk.id);
    expect(await (await get(uk.publicKey, "https://acme.co.uk")).json()).toMatchObject({ v: 1, closed: true, text: { closed: "This form is not taking requests right now." } });
  });

  it("submit from the snippet: CORS on an allowed origin, the hand-over and the event id; via snippet; the consent names the page; a refused origin writes nothing", async () => {
    const ft = formTimingToken(snippet.id, Date.now() - 5000);
    const r = await post(submitRoute, snippet.publicKey, "https://www.acme.com", {
      name: "Rina Mizrahi", phone: "+972547100001", consent: "on", ft, page_url: "https://www.acme.com/offer", utm_source: "facebook", sas_url: "",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://www.acme.com");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    const body = await r.json();
    expect(body.handover).toMatch(/^\/h\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(body.eventId).toBe(submissionIdFromHandoverToken(body.handover.slice(3)));
    const [sub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, body.eventId));
    expect(sub).toMatchObject({ via: "snippet", consent: true, preview: false, sourceKey: "facebook" });
    const [rec] = await db.select().from(consentRecords).where(eq(consentRecords.leadId, sub.leadId));
    expect(rec.pageUrl).toBe("https://www.acme.com/offer");
    expect(rec.source).toContain("www.acme.com/offer");

    const before = (await db.select().from(leadPageSubmissions)).length;
    const no = await post(submitRoute, snippet.publicKey, "https://evil.example", { name: "Spam Bot", phone: "+972547100002", consent: "on", ft });
    expect(no.status).toBe(403);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
    expect((await db.select().from(leadPageSubmissions)).length).toBe(before);
    // A page_url on another origin is not trusted for the consent record.
    const odd = await post(submitRoute, snippet.publicKey, SITE, { name: "Avi Levi", phone: "+972547100003", consent: "on", ft, page_url: "https://evil.example/x" });
    const s2 = (await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, (await odd.json()).eventId)))[0];
    const [rec2] = await db.select().from(consentRecords).where(eq(consentRecords.leadId, s2.leadId));
    expect(rec2.pageUrl).not.toContain("evil");
  });

  it("beacon: counts views and opens from an allowed origin; a preview visit ticks the check without counting (the hosted form too)", async () => {
    const before = await counters(snippet);
    expect((await post(beacon, snippet.publicKey, SITE, { t: "view" })).headers.get("access-control-allow-origin")).toBe(SITE);
    await post(beacon, snippet.publicKey, SITE, { t: "open" });
    await post(beacon, snippet.publicKey, "https://evil.example", { t: "view" });
    expect(await counters(snippet)).toEqual({ views: before.views + 1, opens: before.opens + 1 });

    // The defect from slice a: a preview visit to the hosted form of a draft "Button or link" page.
    const check = async () => (await leadPageReadiness(db, await account(), await fresh(link))).find((c) => c.key === "form_opens")!.done;
    expect(await check()).toBe(false);
    const r = await post(beacon, link.publicKey, APP, { t: "view", preview: previewTokenFor(link.id, new Date()) });
    expect(r.status).toBe(204);
    expect(await check()).toBe(true);
    expect(await counters(link)).toEqual({ views: 0, opens: 0 });
    // A bad preview token on a draft counts nothing and ticks nothing new.
    await post(beacon, link.publicKey, APP, { t: "view", preview: "1.AAAAAAAAAAAAAAAAAAAAAA" });
    expect(await counters(link)).toEqual({ views: 0, opens: 0 });
  });

  it("the buyer chat says \"SMS sent\" only for an SMS that was really sent, and never for the lead page's own link SMS", async () => {
    const submitOne = async (phone: string) => {
      const ft = formTimingToken(snippet.id, Date.now() - 5000);
      const r = await (await post(submitRoute, snippet.publicKey, SITE, { name: "Dana Cohen", phone, consent: "on", ft })).json();
      return r.handover.slice(3) as string;
    };
    // Test mode (mock): the page_link SMS is "Not sent"; nothing in the buyer chat claims it was.
    const mockToken = await submitOne("+972547100011");
    const mocked = await loadHandover(db, { token: mockToken, cookie: null, ip: "10.8.0.1" });
    expect(mocked).toMatchObject({ kind: "ready", sms: "mocked" });
    const leadA = (await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.phone, "+972547100011"))))[0];
    expect((await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadA.id), eq(leadEvents.type, "sms.mocked")))).map((e) => e.data?.kind)).toEqual(["page_link"]);
    const accRow = await account();
    expect((await chatReach(db, { lead: leadA, account: accRow })).sms).toEqual([]);
    // Really sent: the hand-over says so itself; the chat adds no chip for it. The seller's timeline keeps the outcome.
    const sentToken = await submitOne("+972547100012");
    expect(await loadHandover(db, { token: sentToken, cookie: null, ip: "10.8.0.2", sms: LIVE_SMS })).toMatchObject({ sms: "sent" });
    const leadB = (await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.phone, "+972547100012"))))[0];
    expect((await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadB.id), eq(leadEvents.type, "sms.sent")))).length).toBe(1);
    expect((await chatReach(db, { lead: leadB, account: accRow })).sms).toEqual([]);
    // Another kind that was really sent still shows its chip.
    await db.insert(leadEvents).values({ accountId: acc, leadId: leadB.id, type: "sms.sent", actor: "system", data: { kind: "named_time", messageId: null } });
    expect((await chatReach(db, { lead: leadB, account: accRow })).sms).toHaveLength(1);
    // And a mocked one of that kind does not.
    await db.insert(leadEvents).values({ accountId: acc, leadId: leadA.id, type: "sms.mocked", actor: "system", data: { kind: "named_time", messageId: null } });
    expect((await chatReach(db, { lead: leadA, account: accRow })).sms).toEqual([]);
  });
});

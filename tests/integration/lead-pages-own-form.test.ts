/**
 * Lead pages slice c on PGlite: the seller's own form posting urlencoded to
 * POST /api/lp/<key>/submit (through the route handler): 303 to the hand-over,
 * the field aliases, consent only when sent (otherwise no chat and no SMS), the
 * consent wording "Seller's own form on …", refused origins and posts with no
 * Origin/Referer (no redirect, nothing written), the error redirect back to the
 * allowed Referer page only (no open redirect, no personal details), rate limits,
 * account isolation, consent never given back to an existing lead, the
 * "A lead arrived from your form" check, and "Where they came from" with
 * Orders and the top 8 + Other.
 * Mock SMS or a fake transport only; no model calls, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { consentRecords, leadEvents, leadPageSubmissions, leads, legalSections, sellerAccounts, users, type LeadPage, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { loadHandover } from "@/lib/lead-pages/handover";
import { addLeadPageOrigin, createLeadPage, getLeadPage, goLiveLeadPage, leadPageReadiness, pauseLeadPage } from "@/lib/lead-pages/service";
import { seenOriginSuggestion } from "@/lib/lead-pages/view";
import { bySource, rangeOfDays, SOURCE_TOP } from "@/lib/lead-pages/stats";
import { submitLeadPage } from "@/lib/lead-pages/intake";
import { OWN_FORM_ERRORS } from "@/lib/lead-pages/rules";
import { formTimingToken, previewTokenFor } from "@/lib/lead-pages/tokens";
import { MockSmsTransport } from "@/lib/sms/transport";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));

const submitRoute = await import("@/app/api/lp/[key]/submit/route");

const APP = "http://localhost:3000";
const SITE = "https://acme.com";
const MG = `MG${"c".repeat(32)}`;
const transport = new MockSmsTransport();
const LIVE_SMS = { transport, env: { SMS_MODE: "live", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_MESSAGING_SERVICE_SID: MG, APP_URL: APP } };

let ipN = 0;
const ip = () => `10.9.0.${++ipN}`;
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });
/** A browser form post (urlencoded), with the headers a browser sends. */
const send = (key: string, fields: Record<string, string>, h: { origin?: string | null; referer?: string | null; ip?: string } = {}) =>
  submitRoute.POST(new Request(`${APP}/api/lp/${key}/submit`, {
    method: "POST", body: new URLSearchParams(fields).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": h.ip ?? ip(),
      ...(h.origin === undefined ? { origin: SITE } : h.origin ? { origin: h.origin } : {}),
      ...(h.referer === undefined ? { referer: `${SITE}/contact` } : h.referer ? { referer: h.referer } : {}),
    },
  }), ctx(key));

describe("lead pages (c): the seller's own form", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, accB: string;
  let own: LeadPage, ownB: LeadPage;
  const actor = () => ({ userId: me.id, actingAs: false });
  const account = async (id = acc) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  const fresh = async (p: LeadPage) => (await getLeadPage(db, p.accountId, p.id))!;
  const leadOf = async (phone: string, accountId = acc) => (await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.phone, phone))))[0];
  const subsOf = async (leadId: string) => db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.leadId, leadId));
  const makeAccount = async (name: string, email: string) => {
    const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: email });
    if (!p.ok) throw new Error();
    const id = (await createAccount(db, actor(), p.value)).account.id;
    await ensureDraftVersion(db, id);
    await publishDraftVersion(db, actor(), id);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, id));
    for (const lang of ["en", "he"]) {
      await db.insert(legalSections).values({ accountId: id, sectionKey: "privacy_notice", title: "Privacy notice", language: lang, version: 1, body: "We keep your details to answer your request." });
    }
    return id;
  };
  const make = async (accountId: string, raw: Parameters<typeof createLeadPage>[3], live = true) => {
    const r = await createLeadPage(db, actor(), await account(accountId), raw);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    if (!live) return r.page;
    const g = await goLiveLeadPage(db, actor(), accountId, r.page.id);
    if (!g.ok) throw new Error(JSON.stringify(g));
    return g.page;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-c", email: "c@p.test", firstName: "Danny", role: "super_admin" }).returning();
    acc = await makeAccount("Polar Demo", "polar-c@x.test");
    accB = await makeAccount("Other Seller", "other-c@x.test");
    own = await make(acc, { name: "Contact form", connection: "own_form", language: "en", address: `${SITE}/contact`, extraOrigins: ["staging.acme.com"], openingTopic: { en: "Fridge monitoring" } });
    ownB = await make(accB, { name: "B form", connection: "own_form", language: "en", address: `${SITE}/contact` });
  });
  afterAll(async () => { await t.close(); });

  it("a urlencoded post from the allowed page: 303 to the hand-over, the lead (via own_form), consent with the own-form wording and the page URL", async () => {
    expect((await leadPageReadiness(db, await account(), own)).map((c) => [c.key, c.done])).toEqual([
      ["privacy_notice", true], ["account_live", true], ["own_form_lead", false], ["test_lead", false],
    ]);
    const r = await send(own.publicKey, { name: "Rina Mizrahi", phone: "+972547200001", consent: "yes", sas_url: "", utm_source: "facebook", utm_campaign: "Spring" },
      { referer: `${SITE}/contact?utm_source=facebook&name=x` });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/^\/h\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(r.headers.get("set-cookie")).toMatch(/^sas_lp=/);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    const lead = await leadOf("+972547200001");
    expect(lead).toMatchObject({ fullName: "Rina Mizrahi", origin: "webhook", sourceLabel: "Contact form", leadPageId: own.id });
    const [sub] = await subsOf(lead.id);
    expect(sub).toMatchObject({ via: "own_form", consent: true, preview: false, leadCreated: true, sourceKey: "facebook / spring" });
    const [rec] = await db.select().from(consentRecords).where(eq(consentRecords.leadId, lead.id));
    expect(rec.wording).toBe("Seller's own form on acme.com/contact");
    expect(rec.pageUrl).toBe(`${SITE}/contact`);
    expect(rec.source).toBe('Lead page "Contact form" (acme.com/contact)');
    // The hand-over offers the chat (this submission created the lead).
    const h = await loadHandover(db, { token: r.headers.get("location")!.slice(3), cookie: null, ip: "10.9.9.1" });
    expect(h).toMatchObject({ kind: "ready", variant: "chat" });
    // The check ticks.
    expect((await leadPageReadiness(db, await account(), await fresh(own))).find((c) => c.key === "own_form_lead")?.done).toBe(true);
  });

  it("field aliases like the intake API: full_name, tel, mobile, business, email, consent=on (a posted `sites` is ignored)", async () => {
    expect((await send(own.publicKey, { full_name: "Avi Levi", tel: "0547200002", business: "Avi's Diner", email: "Avi@Diner.example", sites: "3", consent: "on" })).status).toBe(303);
    const a = await leadOf("+972547200002");
    expect(a).toMatchObject({ fullName: "Avi Levi", company: "Avi's Diner", email: "avi@diner.example" });
    expect((await subsOf(a.id))[0]).toMatchObject({ consent: true, answers: { firstName: "Avi" } });
    expect((await subsOf(a.id))[0].answers).not.toHaveProperty("sites");
    expect((await send(own.publicKey, { name: "Dana Cohen", mobile: "+972547200003", consent: "1" })).status).toBe(303);
    expect((await subsOf((await leadOf("+972547200003")).id))[0].consent).toBe(true);
  });

  it("consent absent (or anything but true/on/yes/1): the lead is saved without consent; the hand-over is 'received', with no chat and no SMS", async () => {
    for (const [phone, consent] of [["+972547200004", null], ["+972547200005", "no"], ["+972547200006", "false"]] as const) {
      const r = await send(own.publicKey, { name: "Noa Peretz", phone, ...(consent ? { consent } : {}) });
      expect(r.status).toBe(303);
      const lead = await leadOf(phone);
      expect((await subsOf(lead.id))[0].consent).toBe(false);
      expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, lead.id))).toEqual([]);
      const before = transport.sent.length;
      const h = await loadHandover(db, { token: r.headers.get("location")!.slice(3), cookie: null, ip: `10.9.8.${phone.slice(-1)}`, sms: LIVE_SMS });
      expect(h).toMatchObject({ kind: "ready", variant: "received" });
      if (h.kind === "ready") expect(h.chat).toBeNull();
      expect(transport.sent.length).toBe(before);
    }
  });

  it("a refused origin: no redirect, nothing written, the origin suggested to the seller", async () => {
    const before = (await db.select().from(leadPageSubmissions)).length;
    const r = await send(own.publicKey, { name: "Spam Bot", phone: "+972547200010", consent: "yes" }, { origin: "https://evil.example", referer: "https://evil.example/form" });
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
    // A small styled page with the generic buyer sentence: nothing from the request in it.
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain("<p>Something went wrong. Please try again.</p>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    for (const reflected of ["Spam Bot", "+972547200010", "evil.example", own.publicKey, "<script", "src=", "href=", "url("]) expect(html).not.toContain(reflected);
    expect((await db.select().from(leadPageSubmissions)).length).toBe(before);
    expect(await leadOf("+972547200010")).toBeUndefined();
    expect((await fresh(own)).checks).toMatchObject({ refusedOrigin: "https://evil.example" });
    // The Referer host alone is used when there is no Origin (an allowed extra address works).
    expect((await send(own.publicKey, { name: "Gal Shani", phone: "+972547200011" }, { origin: null, referer: "https://staging.acme.com/try" })).status).toBe(303);
    expect((await subsOf((await leadOf("+972547200011")).id))[0].via).toBe("own_form");
  });

  it("no page address (optional for the own form): the first send is refused and shown as 'Seen on …, add it?'; once added, sends are accepted", async () => {
    const bare = await make(acc, { name: "No address form", connection: "own_form", language: "en" });
    expect(bare).toMatchObject({ address: null, extraOrigins: [] });
    const before = (await db.select().from(leadPageSubmissions)).length;
    const r = await send(bare.publicKey, { name: "Noa Peretz", phone: "+972547200029", consent: "yes" }, { origin: "https://shop.example", referer: "https://shop.example/contact" });
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
    expect((await db.select().from(leadPageSubmissions)).length).toBe(before);
    expect(await leadOf("+972547200029")).toBeUndefined();
    const seen = await fresh(bare);
    expect(seen.checks).toMatchObject({ refusedOrigin: "https://shop.example" });
    expect(seenOriginSuggestion(seen)).toBe("shop.example");
    // "Add it?": the host becomes an allowed address, and the next send is accepted.
    expect(await addLeadPageOrigin(db, actor(), await account(), bare.id, "shop.example")).toMatchObject({ ok: true, page: { extraOrigins: ["shop.example"], address: null } });
    expect((await send(bare.publicKey, { name: "Noa Peretz", phone: "+972547200029", consent: "yes" }, { origin: "https://shop.example", referer: "https://shop.example/contact" })).status).toBe(303);
    expect((await subsOf((await leadOf("+972547200029")).id))[0]).toMatchObject({ via: "own_form", consent: true });
    expect(seenOriginSuggestion(await fresh(bare))).toBeNull();
  });

  it("no Origin and no Referer (curl, a server): refused, no redirect, nothing written", async () => {
    const r = await send(own.publicKey, { name: "Curl User", phone: "+972547200012", consent: "yes" }, { origin: null, referer: null });
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
    expect(await leadOf("+972547200012")).toBeUndefined();
    // "Origin: null" (a sandboxed or no-referrer page) with no Referer is refused the same way.
    const n = await send(own.publicKey, { name: "Null Origin", phone: "+972547200013" }, { origin: "null", referer: null });
    expect(n.status).toBe(403);
    expect(await leadOf("+972547200013")).toBeUndefined();
    // Both are the styled page, not plain text.
    for (const x of [r, n]) {
      expect(x.headers.get("content-type")).toContain("text/html");
      const html = await x.text();
      expect(html).toContain("<p>Something went wrong. Please try again.</p>");
      expect(html).not.toMatch(/Curl User|Null Origin|972547200012|972547200013|<script/);
    }
  });

  it("the styled refusal page is in the form's language (Hebrew: rtl), with no reflected input; JSON callers keep JSON", async () => {
    const he = await make(acc, { name: "Hebrew form", connection: "own_form", language: "he", address: `${SITE}/he` });
    const payload = { name: "<b>x</b>\"'&", phone: "+972547200050", consent: "yes" };
    const r = await send(he.publicKey, payload, { origin: "https://evil.example", referer: "https://evil.example/<x>?q=\"y\"" });
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
    const html = await r.text();
    expect(html).toContain('<html lang="he" dir="rtl">');
    expect(html).toContain("<p>משהו השתבש. אפשר לנסות שוב.</p>");
    for (const reflected of ["<b>", "&quot;y", "<x>", "evil.example", "972547200050", he.publicKey]) expect(html).not.toContain(reflected);
    // Too many sends from an unlisted address: the busy sentence, 429, still no redirect.
    const one = "10.9.8.8";
    for (let i = 0; i < 5; i++) await send(he.publicKey, { name: "Repeat", phone: `+97254720006${i}` }, { ip: one, origin: "https://evil.example", referer: "https://evil.example/" });
    const busy = await send(he.publicKey, { name: "Repeat", phone: "+972547200069" }, { ip: one, origin: "https://evil.example", referer: "https://evil.example/" });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("location")).toBeNull();
    expect(await busy.text()).toContain("<p>יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות.</p>");
    // A page that is not found (or a draft): the same styled page, 404.
    const draft = await make(acc, { name: "Hebrew draft", connection: "own_form", language: "he", address: `${SITE}/he-draft` }, false);
    const nf = await send(draft.publicKey, { name: "Early", phone: "+972547200070" }, { referer: `${SITE}/he-draft` });
    expect(nf.status).toBe(404);
    expect(nf.headers.get("content-type")).toContain("text/html");
    expect(await nf.text()).toContain('<html lang="he" dir="rtl">');
    // A JSON caller from an unlisted address keeps its JSON answer.
    const json = await submitRoute.POST(new Request(`${APP}/api/lp/${he.publicKey}/submit`, {
      method: "POST", body: JSON.stringify({ name: "Json", phone: "+972547200071" }),
      headers: { "content-type": "application/json", origin: "https://evil.example", "x-forwarded-for": ip() },
    }), ctx(he.publicKey));
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({ error: "origin" });
  });

  it("every code the endpoint sends back is one the setup panel lists (one list), and each is reachable", async () => {
    const seen = new Set<string>();
    const codeOf = (r: Response) => { const m = /[?&]sas_error=([a-z]+)$/.exec(r.headers.get("location") ?? ""); if (m) seen.add(m[1]); return m?.[1]; };
    expect(codeOf(await send(own.publicKey, { name: "", phone: "+972547200080" }))).toBe("name");
    expect(codeOf(await send(own.publicKey, { name: "Dana Cohen", phone: "12" }))).toBe("phone");
    const one = "10.9.9.9";
    for (let i = 0; i < 5; i++) await send(own.publicKey, { name: "Repeat Buyer", phone: `+97254720008${i + 1}` }, { ip: one });
    expect(codeOf(await send(own.publicKey, { name: "Repeat Buyer", phone: "+972547200087" }, { ip: one }))).toBe("busy");
    const paused = await make(acc, { name: "Paused codes", connection: "own_form", language: "en", address: `${SITE}/paused` });
    await pauseLeadPage(db, actor(), acc, paused.id);
    expect(codeOf(await send(paused.publicKey, { name: "Late", phone: "+972547200088" }, { referer: `${SITE}/paused` }))).toBe("closed");
    // The snippet page's no-JS fallback without its timing token: generic.
    const snip = await make(acc, { name: "Snippet codes", connection: "snippet", language: "en", address: `${SITE}/snip` });
    expect(codeOf(await send(snip.publicKey, { name: "Bot", phone: "+972547200089" }, { referer: `${SITE}/snip` }))).toBe("generic");
    expect([...seen].sort()).toEqual([...OWN_FORM_ERRORS].sort());
  });

  it("a refused send goes back to the allowed Referer page only, with ?sas_error= and no personal details (no open redirect)", async () => {
    const bad = await send(own.publicKey, { name: "Dana Cohen", phone: "12" }, { referer: `${SITE}/contact?name=Dana+Cohen&utm_source=x#frag` });
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toBe(`${SITE}/contact?sas_error=phone`);
    const noName = await send(own.publicKey, { name: "", phone: "+972547200014" });
    expect(noName.headers.get("location")).toBe(`${SITE}/contact?sas_error=name`);
    // The Origin is allowed but the Referer points elsewhere: never redirected there.
    for (const referer of ["https://evil.example/phish", "javascript:alert(1)", `https://user:pw@acme.com/contact`, "//evil.example/x", `${SITE}.evil.example/contact`]) {
      const r = await send(own.publicKey, { name: "Xavier", phone: "12" }, { referer });
      expect(r.headers.get("location")).toBeNull();
      expect(r.status).toBe(400);
    }
    // The www twin is allowed, and its Referer must match the Origin exactly.
    const twin = await send(own.publicKey, { name: "Xavier", phone: "12" }, { origin: "https://www.acme.com", referer: "https://www.acme.com/contact" });
    expect(twin.headers.get("location")).toBe("https://www.acme.com/contact?sas_error=phone");
    const mixed = await send(own.publicKey, { name: "Xavier", phone: "12" }, { origin: "https://www.acme.com", referer: `${SITE}/contact` });
    expect(mixed.headers.get("location")).toBeNull();
    // A paused page: back with "closed".
    const paused = await make(acc, { name: "Paused form", connection: "own_form", language: "en", address: `${SITE}/old` });
    await pauseLeadPage(db, actor(), acc, paused.id);
    const closed = await send(paused.publicKey, { name: "Late Buyer", phone: "+972547200015" }, { referer: `${SITE}/old` });
    expect(closed.headers.get("location")).toBe(`${SITE}/old?sas_error=closed`);
    expect(await leadOf("+972547200015")).toBeUndefined();
    // A draft takes only test sends (the hidden preview field), marked as tests.
    const draft = await make(acc, { name: "Draft form", connection: "own_form", language: "en", address: `${SITE}/draft` }, false);
    expect((await send(draft.publicKey, { name: "Early Buyer", phone: "+972547200016" }, { referer: `${SITE}/draft` })).status).toBe(404);
    const test = await send(draft.publicKey, { name: "Test Buyer", phone: "+972547200017", consent: "yes", preview: previewTokenFor(draft.id, new Date()) }, { referer: `${SITE}/draft` });
    expect(test.status).toBe(303);
    expect((await subsOf((await leadOf("+972547200017")).id))[0]).toMatchObject({ via: "own_form", preview: true });
    expect((await leadPageReadiness(db, await account(), await fresh(draft))).find((c) => c.key === "own_form_lead")?.done).toBe(true);
  });

  it("a cross-site post sends only the origin as Referer: the consent record and the error redirect use the page's address (www twin too); an extra address keeps its origin", async () => {
    const recOf = async (phone: string) => (await db.select().from(consentRecords).where(eq(consentRecords.leadId, (await leadOf(phone)).id)))[0];
    // Origin-only Referer (the browser default strict-origin-when-cross-origin).
    expect((await send(own.publicKey, { name: "Noa Levi", phone: "+972547200040", consent: "yes" }, { referer: `${SITE}/` })).status).toBe(303);
    expect(await recOf("+972547200040")).toMatchObject({
      pageUrl: `${SITE}/contact`, wording: "Seller's own form on acme.com/contact", source: 'Lead page "Contact form" (acme.com/contact)',
    });
    // No Referer at all (Origin only): the same.
    expect((await send(own.publicKey, { name: "Noa Levi", phone: "+972547200041", consent: "yes" }, { referer: null })).status).toBe(303);
    expect((await recOf("+972547200041")).pageUrl).toBe(`${SITE}/contact`);
    // A full Referer (the seller's page sends one) wins, query dropped.
    expect((await send(own.publicKey, { name: "Noa Levi", phone: "+972547200042", consent: "yes" }, { referer: `${SITE}/offer?utm_source=fb` })).status).toBe(303);
    expect(await recOf("+972547200042")).toMatchObject({ pageUrl: `${SITE}/offer`, wording: "Seller's own form on acme.com/offer", source: 'Lead page "Contact form" (acme.com/offer)' });
    // The www twin: its own origin with the address's path.
    expect((await send(own.publicKey, { name: "Noa Levi", phone: "+972547200043", consent: "yes" }, { origin: "https://www.acme.com", referer: "https://www.acme.com/" })).status).toBe(303);
    expect(await recOf("+972547200043")).toMatchObject({ pageUrl: "https://www.acme.com/contact", wording: "Seller's own form on www.acme.com/contact" });
    // An "Other addresses" host: the origin only.
    expect((await send(own.publicKey, { name: "Noa Levi", phone: "+972547200044", consent: "yes" }, { origin: "https://staging.acme.com", referer: "https://staging.acme.com/" })).status).toBe(303);
    expect(await recOf("+972547200044")).toMatchObject({
      pageUrl: "https://staging.acme.com/", wording: "Seller's own form on staging.acme.com", source: 'Lead page "Contact form" (staging.acme.com)',
    });

    // Refused sends go back to the form's page, not the site root.
    const bad = (h: Parameters<typeof send>[2]) => send(own.publicKey, { name: "Dana Cohen", phone: "12" }, h);
    expect((await bad({ referer: `${SITE}/` })).headers.get("location")).toBe(`${SITE}/contact?sas_error=phone`);
    expect((await bad({ referer: null })).headers.get("location")).toBe(`${SITE}/contact?sas_error=phone`);
    expect((await bad({ origin: "https://www.acme.com", referer: "https://www.acme.com/" })).headers.get("location")).toBe("https://www.acme.com/contact?sas_error=phone");
    expect((await bad({ origin: "https://staging.acme.com", referer: "https://staging.acme.com/" })).headers.get("location")).toBe("https://staging.acme.com/?sas_error=phone");
    expect((await bad({ referer: `${SITE}/offer?name=Dana` })).headers.get("location")).toBe(`${SITE}/offer?sas_error=phone`);
    // Still never anywhere else.
    expect((await bad({ origin: "https://evil.example", referer: "https://evil.example/" })).headers.get("location")).toBeNull();
    expect((await bad({ referer: "https://evil.example/" })).headers.get("location")).toBeNull();
  });

  it("what each connection type stores as consent: ours (link, snippet) the exact line shown; the own form where the buyer ticked it", async () => {
    const env = { APP_URL: APP };
    const recOf = async (phone: string) => (await db.select().from(consentRecords).where(eq(consentRecords.leadId, (await leadOf(phone)).id)))[0];
    const direct = (p: LeadPage, phone: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) => submitLeadPage(db, {
      key: p.publicKey, headers: new Headers(headers), ip: ip(), env,
      body: { ft: formTimingToken(p.id, Date.now() - 5000), name: "Tal Amir", phone, consent: "on", ...extra },
    });
    const link = await make(acc, { name: "Link page", connection: "link", language: "en" });
    const snippet = await make(acc, { name: "Snippet page", connection: "snippet", language: "en", address: `${SITE}/pricing` });
    expect((await direct(link, "+972547200050", { origin: APP })).kind).toBe("handover");
    const l = await recOf("+972547200050");
    expect(l.wording).toContain("Polar Demo and its automated assistant");
    expect(l).toMatchObject({ source: `Lead page "Link page" (localhost:3000/p/${link.publicKey})`, pageUrl: `${APP}/p/${link.publicKey}` });
    // The snippet names its page; without that and with an origin-only Referer, the page's address.
    expect((await direct(snippet, "+972547200051", { origin: SITE, referer: `${SITE}/` }, { page_url: `${SITE}/pricing/team?utm_source=x` })).kind).toBe("handover");
    const s = await recOf("+972547200051");
    expect(s).toMatchObject({ wording: l.wording, source: 'Lead page "Snippet page" (acme.com/pricing/team)', pageUrl: `${SITE}/pricing/team` });
    expect((await direct(snippet, "+972547200052", { origin: SITE, referer: `${SITE}/` })).kind).toBe("handover");
    expect(await recOf("+972547200052")).toMatchObject({ wording: l.wording, source: 'Lead page "Snippet page" (acme.com/pricing)', pageUrl: `${SITE}/pricing` });
    // The own form (through the route, origin-only Referer).
    expect((await send(own.publicKey, { name: "Tal Amir", phone: "+972547200053", consent: "yes" }, { referer: `${SITE}/` })).status).toBe(303);
    expect(await recOf("+972547200053")).toMatchObject({
      wording: "Seller's own form on acme.com/contact", source: 'Lead page "Contact form" (acme.com/contact)', pageUrl: `${SITE}/contact`,
    });
  });

  it("rate limits: the sixth send from one IP in 10 minutes goes back with sas_error=busy", async () => {
    const one = "10.9.7.7";
    for (let i = 0; i < 5; i++) {
      expect((await send(own.publicKey, { name: "Repeat Buyer", phone: `+97254720010${i}` }, { ip: one })).headers.get("location")).toMatch(/^\/h\//);
    }
    const r = await send(own.publicKey, { name: "Repeat Buyer", phone: "+972547200109" }, { ip: one });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${SITE}/contact?sas_error=busy`);
    expect(await leadOf("+972547200109")).toBeUndefined();
    // The same refusal from a page that is not allowed: no redirect at all.
    const evil = await send(own.publicKey, { name: "Repeat Buyer", phone: "+972547200108" }, { ip: one, origin: "https://evil.example", referer: "https://evil.example/" });
    expect(evil.status).toBe(429);
    expect(evil.headers.get("location")).toBeNull();
  });

  it("account isolation: the page key fixes the account (the same address on another seller's page writes only there)", async () => {
    expect((await send(ownB.publicKey, { name: "Bea Seller", phone: "+972547200020", consent: "yes" })).status).toBe(303);
    expect(await leadOf("+972547200020", accB)).toMatchObject({ leadPageId: ownB.id });
    expect(await leadOf("+972547200020", acc)).toBeUndefined();
    const [sub] = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.pageId, ownB.id));
    expect(sub.accountId).toBe(accB);
  });

  it("an existing lead without consent never gets it back from the own form", async () => {
    await send(own.publicKey, { name: "Lior Ben", phone: "+972547200030" });
    const lead = await leadOf("+972547200030");
    expect((await send(own.publicKey, { name: "Lior Ben", phone: "+972547200030", consent: "yes" })).status).toBe(303);
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, lead.id))).toEqual([]);
    expect((await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "lead_page.consent_not_restored")))).length).toBe(1);
  });

  it("where they came from: Orders (after the submission only) and the top 8 sources, then Other", async () => {
    const page = await make(acc, { name: "Sources form", connection: "own_form", language: "en", address: `${SITE}/sources` });
    for (let i = 0; i < 10; i++) {
      // Source s0 brings two leads; the others one each.
      for (let j = 0; j < (i === 0 ? 2 : 1); j++) {
        const r = await send(page.publicKey, { name: "Source Buyer", phone: `+9725472003${i}${j}`, utm_source: `s${i}` }, { referer: `${SITE}/sources` });
        expect(r.status).toBe(303);
      }
    }
    // An order after the submission counts; an order from before it does not.
    const lead0 = await leadOf("+972547200300");
    const lead9 = await leadOf("+972547200390");
    await t.client.exec("set session_replication_role = replica");
    try {
      await t.client.query(
        `insert into orders (id, account_id, lead_id, quote_id, order_form_id, number, currency, amount_due_minor, recurring_minor, created_at)
         values ($1, $2, $3, $4, $5, 9001, 'ILS', 100, 0, now() + interval '1 minute'), ($6, $2, $7, $8, $9, 9002, 'ILS', 100, 0, now() - interval '1 day')`,
        [crypto.randomUUID(), acc, lead0.id, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), lead9.id, crypto.randomUUID(), crypto.randomUUID()],
      );
    } finally {
      await t.client.exec("set session_replication_role = origin");
    }
    const rows = await bySource(db, acc, page.id, rangeOfDays(30, new Date(Date.now() + 120_000)));
    expect(rows).toHaveLength(SOURCE_TOP + 1);
    expect(rows[0]).toEqual({ sourceKey: "s0", visits: 0, opens: 0, leads: 2, orders: 1 });
    expect(rows.slice(1, SOURCE_TOP).every((r) => r.leads === 1 && r.orders === 0)).toBe(true);
    // s8 and s9 (one lead each; s9's order came before its submission) are "Other".
    expect(rows[SOURCE_TOP]).toMatchObject({ other: true, leads: 2, orders: 0 });
    expect(rows.map((r) => r.sourceKey)).not.toContain("s9");
  });
});

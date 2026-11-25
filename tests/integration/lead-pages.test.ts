/**
 * Lead pages phase 1 (slice a-1) on PGlite: the seller service (create, edit,
 * go live, pause, resume, banner, preview link, all audited), the public
 * submit (origin, rate limits, honeypot, timing, consent mapping, the
 * returning-buyer rule, account isolation), the hand-over (chat start with the
 * page's topic, the page_link SMS caps and country rule), and the numbers.
 * Mock SMS or a fake transport only; no model calls, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog, consentRecords, conversations, leadEvents, leadPageDaily, leadPages, leadPageSubmissions, leads, legalSections, markets, messages,
  sellerAccounts, users, voiceSessions, type LeadPage, type User,
} from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { leadInterest } from "@/lib/chat/start";
import { REPEAT_MS, submitLeadPage, type SubmitResult } from "@/lib/lead-pages/intake";
import { loadHandover, recordHandoverChoice } from "@/lib/lead-pages/handover";
import {
  addLeadPageOrigin, bumpDaily, createLeadPage, getLeadPage, goLiveLeadPage, issuePreviewLink, latestSubmissions, leadPageReadiness, listLeadPages,
  pageByKey, pagesOfLeads, pauseLeadPage, removeLeadPageBanner, resumeLeadPage, saveLeadPageBanner, updateLeadPage,
} from "@/lib/lead-pages/service";
import { bySource, listTotals, pageFunnel, rangeOfDays } from "@/lib/lead-pages/stats";
import { formTimingToken, leadCookieValue, previewTokenFor, submissionIdFromHandoverToken } from "@/lib/lead-pages/tokens";
import { MockSmsTransport } from "@/lib/sms/transport";
import type { FileStore } from "@/lib/sources/blob";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));

const APP = "http://localhost:3000";
const MG = `MG${"c".repeat(32)}`;
const LIVE_SMS = { transport: new MockSmsTransport(), env: { SMS_MODE: "live", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_MESSAGING_SERVICE_SID: MG, APP_URL: APP } };

/** A tiny PNG header (the banner check reads only the header). */
function png(w: number, h: number) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

class MemStore implements FileStore {
  files = new Map<string, Uint8Array>();
  async put(p: string, b: Uint8Array) { this.files.set(p, b); }
  async get(p: string) { return this.files.get(p) ?? null; }
  async del(p: string) { this.files.delete(p); }
}

describe("lead pages (a-1): service, submit, hand-over, numbers", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string, other: string;
  let page: LeadPage, otherPage: LeadPage;
  let ipN = 0;
  let phoneN = 1000;
  const actor = () => ({ userId: me.id, actingAs: false });
  const account = async (id = acc) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  const nextPhone = () => `+9725471${String(++phoneN).padStart(5, "0")}`;
  const submit = async (p: LeadPage, body: Record<string, unknown>, opts: { origin?: string | null; cookie?: string; ip?: string; ftAgeMs?: number } = {}): Promise<SubmitResult> => {
    const h: Record<string, string> = {};
    if (opts.origin !== null) h.origin = opts.origin ?? APP;
    if (opts.cookie) h.cookie = opts.cookie;
    return submitLeadPage(db, {
      key: p.publicKey, headers: new Headers(h), ip: opts.ip ?? `10.0.0.${++ipN}`, env: { APP_URL: APP },
      body: { ft: formTimingToken(p.id, Date.now() - (opts.ftAgeMs ?? 5000)), consent: "on", ...body },
    });
  };
  const handover = (r: SubmitResult) => {
    if (r.kind !== "handover") throw new Error(`expected a hand-over, got ${JSON.stringify(r)}`);
    return r;
  };
  const subOf = async (id: string) => (await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.id, id)))[0];
  const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.replace(/\s/g, "")}@x.test` });
      if (!p.ok) throw new Error();
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    };
    acc = await mk("Polar Demo");
    other = await mk("Other Co");
    for (const a of [acc, other]) {
      await ensureDraftVersion(db, a);
      await publishDraftVersion(db, actor(), a);
      await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, a));
    }
  });
  afterAll(async () => { await t.close(); });

  it("creates a draft page (audited) and lists it for its own account only", async () => {
    const r = await createLeadPage(db, actor(), await account(), {
      name: "Spring offer", connection: "link", language: "en", fields: { company: "on" },
      openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    page = r.page;
    expect(page).toMatchObject({ status: "draft", connection: "link", address: null, language: "en" });
    expect(page.publicKey).toMatch(/^[0-9A-Za-z]{12}$/);
    expect((await audits("lead_page.created")).map((a) => a.targetId)).toContain(page.id);
    // The hosted page comes later. The address: required for the snippet only (optional for the own form and a button or link).
    expect(await createLeadPage(db, actor(), await account(), { name: "x", connection: "hosted", language: "en", address: "acme.com" })).toMatchObject({ ok: false, errors: { connection: expect.any(String) } });
    expect(await createLeadPage(db, actor(), await account(), { name: "x", connection: "snippet", language: "en" })).toMatchObject({ ok: false, errors: { address: "Enter the address of the page the form is on." } });
    expect(await createLeadPage(db, actor(), await account(other), { name: "x", connection: "own_form", language: "en" })).toMatchObject({ ok: true, page: { connection: "own_form", address: null } });
    // A market of another account is refused.
    const [otherMarket] = await db.insert(markets).values({ id: crypto.randomUUID(), accountId: other, name: "UK", countries: ["GB"] }).returning();
    expect(await createLeadPage(db, actor(), await account(), { name: "x", connection: "link", language: "en", marketId: otherMarket.id })).toMatchObject({ ok: false, errors: { marketId: expect.any(String) } });

    const o = await createLeadPage(db, actor(), await account(other), { name: "Other page", connection: "link", language: "he" });
    if (!o.ok) throw new Error();
    otherPage = o.page;
    expect((await listLeadPages(db, acc)).map((p) => p.id)).toEqual([page.id]);
    expect(await getLeadPage(db, acc, otherPage.id)).toBeNull();
    expect(await updateLeadPage(db, actor(), await account(), otherPage.id, { name: "Hijack", connection: "link", language: "en" })).toMatchObject({ ok: false });
    expect((await getLeadPage(db, other, otherPage.id))!.name).toBe("Other page");
  });

  it("go live is blocked by the privacy notice; then live, paused and resumed (audited)", async () => {
    expect(await goLiveLeadPage(db, actor(), acc, page.id)).toEqual({ ok: false, reason: "blocked", blockers: ["privacy_notice"] });
    for (const [a, lang] of [[acc, "en"], [acc, "he"], [other, "he"]] as const) {
      await db.insert(legalSections).values({ accountId: a, sectionKey: "privacy_notice", title: lang === "he" ? "הודעת פרטיות" : "Privacy notice", language: lang, version: 1, body: "We keep your details to answer your request." });
    }
    expect((await leadPageReadiness(db, await account(), page)).map((c) => [c.key, c.done])).toEqual([["privacy_notice", true], ["account_live", true], ["form_opens", false], ["test_lead", false]]);
    expect(await pauseLeadPage(db, actor(), acc, page.id)).toMatchObject({ ok: true, page: { status: "paused" } });
    expect(await resumeLeadPage(db, actor(), acc, page.id)).toMatchObject({ ok: true, page: { status: "live" } });
    const live = await goLiveLeadPage(db, actor(), acc, page.id);
    expect(live).toMatchObject({ ok: true, page: { status: "live" } });
    if (live.ok) page = live.page;
    expect(page.wentLiveAt).not.toBeNull();
    expect(await goLiveLeadPage(db, actor(), other, page.id)).toEqual({ ok: false, reason: "not_found" });
    const o = await goLiveLeadPage(db, actor(), other, otherPage.id);
    if (o.ok) otherPage = o.page;
    expect((await audits("lead_page.paused")).length).toBe(1);
    expect((await audits("lead_page.resumed")).length).toBe(1);
    expect((await audits("lead_page.went_live")).length).toBe(2);
  });

  it("a submission creates the lead, the submission and the event; the chat starts naming the page's topic", async () => {
    const phone = nextPhone();
    const r = handover(await submit(page, { name: "Rina Mizrahi", phone, company: "Cafe Rina", sites: "4", utm_source: "facebook", utm_campaign: "Spring" }));
    expect(r.newLeadId).not.toBeNull();
    const sub = await subOf(r.submissionId);
    expect(sub).toMatchObject({ accountId: acc, pageId: page.id, via: "link", leadCreated: true, consent: true, preview: false, language: "en", sourceKey: "facebook / spring" });
    // A posted `sites` (an older form) is ignored: no longer a field.
    expect(sub.answers).toEqual({ firstName: "Rina" });
    const [lead] = await db.select().from(leads).where(eq(leads.id, sub.leadId));
    expect(lead).toMatchObject({ accountId: acc, phone, fullName: "Rina Mizrahi", company: "Cafe Rina", origin: "webhook", sourceLabel: "Spring offer", leadPageId: page.id, language: "en" });
    const [consent] = await db.select().from(consentRecords).where(eq(consentRecords.leadId, lead.id));
    expect(consent.wording).toContain("Polar Demo and its automated assistant");
    expect(consent.source).toBe(`Lead page "Spring offer" (localhost:3000/p/${page.publicKey})`);
    expect(consent.pageUrl).toBe(`${APP}/p/${page.publicKey}`);
    const ev = (await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id))).find((e) => e.type === "lead_page.submitted");
    expect(ev?.data).toMatchObject({ pageId: page.id, submissionId: r.submissionId, topic: "Fridge monitoring", created: true });
    expect(await leadInterest(db, acc, lead.id)).toBe("Fridge monitoring");
    // The token holds the submission id only.
    expect(submissionIdFromHandoverToken(r.token)).toBe(r.submissionId);

    const h = await loadHandover(db, { token: r.token, cookie: null, ip: "10.9.0.1" });
    expect(h).toMatchObject({ kind: "ready", variant: "chat", firstName: "Rina", sms: "mocked" });
    const [conv] = await db.select().from(conversations).where(eq(conversations.leadId, lead.id));
    expect(conv.channel).toBe("chat");
    const [first] = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(first.actor).toBe("agent");
    expect(first.body).toContain("You asked about Fridge monitoring.");
    expect((await subOf(r.submissionId)).conversationId).toBe(conv.id);
    // Reloading the hand-over writes nothing new: one chat, one SMS attempt.
    await loadHandover(db, { token: r.token, cookie: null, ip: "10.9.0.1" });
    expect(await db.select().from(conversations).where(eq(conversations.leadId, lead.id))).toHaveLength(1);
    expect((await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id))).filter((e) => e.type.startsWith("sms."))).toHaveLength(1);

    // The buyer picks: stored once, and the chat open recorded.
    expect(await recordHandoverChoice(db, { token: r.token, choice: "text", cookie: null, staffViewer: async () => false })).toEqual({ ok: true });
    expect(await subOf(r.submissionId)).toMatchObject({ chatChoice: "text" });
    expect((await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id))).some((e) => e.type === "chat.opened" || e.type.includes("opened"))).toBe(true);
  });

  it("returning buyer: a stranger typing a known phone gets a separate lead and its own chat; the same browser gets the lead's chat", async () => {
    const phone = nextPhone();
    const first = handover(await submit(page, { name: "Dana Levi", phone }));
    const leadId = first.newLeadId!;
    await loadHandover(db, { token: first.token, cookie: null, ip: "10.9.0.1" });
    // Another browser, same phone: a new unverified lead (never the existing one), its own chat, no SMS tried.
    const sentBefore = LIVE_SMS.transport.sent.length;
    const second = handover(await submit(page, { name: "Someone Else", phone }));
    expect(second.newLeadId).not.toBeNull();
    expect(second.newLeadId).not.toBe(leadId);
    expect(await subOf(second.submissionId)).toMatchObject({ leadId: second.newLeadId, leadCreated: true, consent: true, answers: { firstName: "Someone", claimedPhone: phone } });
    const h = await loadHandover(db, { token: second.token, cookie: null, ip: "10.9.0.2", sms: LIVE_SMS });
    expect(h).toMatchObject({ kind: "ready", variant: "chat", firstName: "Someone", sms: null });
    expect(LIVE_SMS.transport.sent.length).toBe(sentBefore);
    if (h.kind !== "ready" || !h.chat) throw new Error();
    expect(h.chat.ctx.lead.id).toBe(second.newLeadId);

    // The same browser (sas_lp cookie for the existing lead): its chat, and a double click returns the same hand-over.
    const cookie = `sas_lp=${leadCookieValue(leadId)}`;
    const own = handover(await submit(page, { name: "Dana Levi", phone }, { cookie }));
    expect(own).toMatchObject({ repeat: true, submissionId: first.submissionId });
    expect(await loadHandover(db, { token: own.token, cookie: leadCookieValue(leadId), ip: "10.9.0.4" })).toMatchObject({ variant: "chat" });
  });

  it("consent: unticked saves no consent and no chat; the form never gives consent back; an existing consent gets the new record", async () => {
    const unticked = handover(await submit(page, { name: "No Consent", phone: nextPhone(), consent: "" }));
    const sub = await subOf(unticked.submissionId);
    expect(sub).toMatchObject({ leadCreated: true, consent: false });
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, sub.leadId))).toHaveLength(0);
    expect(await loadHandover(db, { token: unticked.token, cookie: null, ip: "10.9.1.1" })).toMatchObject({ variant: "received", sms: null });
    expect(await db.select().from(conversations).where(eq(conversations.leadId, sub.leadId))).toHaveLength(0);

    // The same phone again from the same browser (after the 10-minute repeat window), box ticked: consent is not restored from the public form.
    await db.update(leadPageSubmissions).set({ createdAt: new Date(Date.now() - REPEAT_MS - 60_000) }).where(eq(leadPageSubmissions.id, unticked.submissionId));
    const ticked = handover(await submit(page, { name: "No Consent", phone: (await db.select().from(leads).where(eq(leads.id, sub.leadId)))[0].phone }, { cookie: `sas_lp=${leadCookieValue(sub.leadId)}` }));
    expect(await subOf(ticked.submissionId)).toMatchObject({ leadCreated: false, consent: false });
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, sub.leadId))).toHaveLength(0);
    expect((await db.select().from(leadEvents).where(eq(leadEvents.leadId, sub.leadId))).map((e) => e.type)).toContain("lead_page.consent_not_restored");

    // A lead that has consent gets the new record (the exact line, this page).
    const phone = nextPhone();
    const hc = handover(await submit(page, { name: "Has Consent", phone }));
    await db.update(leadPageSubmissions).set({ createdAt: new Date(Date.now() - REPEAT_MS - 60_000) }).where(eq(leadPageSubmissions.id, hc.submissionId));
    const re = handover(await submit(page, { name: "Has Consent", phone }, { cookie: `sas_lp=${leadCookieValue(hc.newLeadId!)}` }));
    const s2 = await subOf(re.submissionId);
    expect(s2).toMatchObject({ leadCreated: false, consent: true });
    expect(await db.select().from(consentRecords).where(eq(consentRecords.leadId, s2.leadId))).toHaveLength(2);
  });

  it("opted out: kept as it is, neutral hand-over; a paused account takes no lead", async () => {
    const phone = nextPhone();
    const [lead] = await db.insert(leads).values({ accountId: acc, fullName: "Gone", phone, language: "en", origin: "manual", status: "opted_out" }).returning();
    // The same browser (its cookie): today's neutral hand-over. Another browser gets its own lead (lead-pages-returning.test.ts).
    const r = handover(await submit(page, { name: "Gone Again", phone }, { cookie: `sas_lp=${leadCookieValue(lead.id)}` }));
    expect(await subOf(r.submissionId)).toMatchObject({ leadId: lead.id, leadCreated: false, consent: false });
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0]).toMatchObject({ fullName: "Gone", status: "opted_out" });
    expect(await loadHandover(db, { token: r.token, cookie: leadCookieValue(lead.id), ip: "10.9.2.1", sms: LIVE_SMS })).toMatchObject({ variant: "received", chat: null });

    await db.update(sellerAccounts).set({ status: "paused" }).where(eq(sellerAccounts.id, other));
    const before = (await db.select().from(leads).where(eq(leads.accountId, other))).length;
    expect(await submit(otherPage, { name: "Paused Buyer", phone: nextPhone() })).toEqual({ kind: "thanks" });
    expect((await db.select().from(leads).where(eq(leads.accountId, other))).length).toBe(before);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, other));
  });

  it("spam checks: origin, honeypot, timing; each refusal counted, never a row", async () => {
    const rejected = async () => (await db.select().from(leadPageDaily).where(eq(leadPageDaily.pageId, page.id))).reduce((a, r) => a + r.rejected, 0);
    const leadsBefore = (await db.select().from(leads).where(eq(leads.accountId, acc))).length;
    const r0 = await rejected();
    expect(await submit(page, { name: "Bot", phone: nextPhone() }, { origin: "https://evil.example" })).toEqual({ kind: "refused", reason: "origin" });
    expect((await getLeadPage(db, acc, page.id))!.checks).toMatchObject({ refusedOrigin: "https://evil.example" });
    expect(await submit(page, { name: "Bot", phone: nextPhone() }, { origin: null })).toEqual({ kind: "refused", reason: "origin" });
    expect(await submit(page, { name: "Bot", phone: nextPhone(), sas_url: "http://x" })).toEqual({ kind: "thanks" });
    // Too fast (under 1 s): refused with the wait, so the form's script sends once more after it.
    expect(await submit(page, { name: "Bot", phone: nextPhone() }, { ftAgeMs: 400 })).toEqual({ kind: "refused", reason: "timing", retryAfterMs: expect.any(Number) });
    expect(await submit(page, { name: "Bot", phone: nextPhone(), ft: "" })).toEqual({ kind: "refused", reason: "timing" });
    expect(await submit(page, { name: "B", phone: "12" })).toEqual({ kind: "invalid", errors: ["name", "phone"] });
    expect(await rejected()).toBe(r0 + 5);
    expect((await db.select().from(leads).where(eq(leads.accountId, acc))).length).toBe(leadsBefore);
    // Unknown key: nothing.
    expect(await submitLeadPage(db, { key: "AAAAAAAAAAAA", body: {}, headers: new Headers({ origin: APP }), ip: "1.1.1.1" })).toEqual({ kind: "not_found" });
  });

  it("rate limits: 5 per IP in 10 minutes, 3 per phone and page a day (429)", async () => {
    const ip = "10.77.0.1";
    for (let i = 0; i < 5; i++) expect((await submit(page, { name: "Burst Buyer", phone: nextPhone() }, { ip })).kind).toBe("handover");
    expect(await submit(page, { name: "Burst Buyer", phone: nextPhone() }, { ip })).toMatchObject({ kind: "busy" });
    const phone = nextPhone();
    for (let i = 0; i < 3; i++) expect((await submit(page, { name: "Same Phone", phone })).kind).toBe("handover");
    expect(await submit(page, { name: "Same Phone", phone })).toMatchObject({ kind: "busy" });
  });

  it("account isolation: a page's key writes only into its own account", async () => {
    const phone = nextPhone();
    const r = handover(await submit(otherPage, { name: "Other Buyer", phone }));
    const sub = await subOf(r.submissionId);
    expect(sub.accountId).toBe(other);
    const [lead] = await db.select().from(leads).where(eq(leads.id, sub.leadId));
    expect(lead.accountId).toBe(other);
    expect(await db.select().from(leads).where(and(eq(leads.accountId, acc), eq(leads.phone, phone)))).toHaveLength(0);
    // The seller reads of account A never see B's submissions.
    expect(await latestSubmissions(db, acc, otherPage.id)).toHaveLength(0);
    expect((await pagesOfLeads(db, acc, [lead.id])).size).toBe(0);
    expect((await pagesOfLeads(db, other, [lead.id])).get(lead.id)).toEqual([otherPage.id]);
  });

  it("drafts take only preview submissions; paused pages are closed", async () => {
    const d = await createLeadPage(db, actor(), await account(), { name: "Draft page", connection: "link", language: "en" });
    if (!d.ok) throw new Error();
    expect(await submit(d.page, { name: "Early Bird", phone: nextPhone() })).toEqual({ kind: "not_found" });
    const link = await issuePreviewLink(db, actor(), acc, d.page.id);
    expect(link?.path).toMatch(new RegExp(`^/p/${d.page.publicKey}\\?preview=`));
    const r = handover(await submit(d.page, { name: "Seller Test", phone: nextPhone(), preview: previewTokenFor(d.page.id, new Date()) }));
    expect(await subOf(r.submissionId)).toMatchObject({ preview: true });
    await pauseLeadPage(db, actor(), acc, d.page.id);
    expect(await submit(d.page, { name: "Late Bird", phone: nextPhone() })).toEqual({ kind: "refused", reason: "closed" });
  });

  it("page_link SMS: only to the account's selling markets, at most 3 per IP a day", async () => {
    // A UK number on an Israel-only account: refused (SMS pumping), even with a live transport.
    const uk = handover(await submit(page, { name: "Far Away", phone: "+447700900123" }));
    const sentBefore = LIVE_SMS.transport.sent.length;
    expect(await loadHandover(db, { token: uk.token, cookie: null, ip: "10.9.3.1", sms: LIVE_SMS })).toMatchObject({ sms: "refused", variant: "chat" });
    expect(LIVE_SMS.transport.sent.length).toBe(sentBefore);
    // Per IP: the fourth hand-over from one address that day sends nothing.
    const ip = "10.9.4.1";
    const outcomes: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const r = handover(await submit(page, { name: "Busy Phone", phone: nextPhone() }));
      outcomes.push((await loadHandover(db, { token: r.token, cookie: null, ip, sms: LIVE_SMS })).kind === "ready" ? (await subOf(r.submissionId)).sms : null);
    }
    expect(outcomes).toEqual(["sent", "sent", "sent", "refused"]);
  });

  it("an expired hand-over says so; the same browser goes on to its chat", async () => {
    const r = handover(await submit(page, { name: "Slow Buyer", phone: nextPhone() }));
    await loadHandover(db, { token: r.token, cookie: null, ip: "10.9.5.1" });
    const later = new Date(Date.now() + 31 * 60_000);
    expect(await loadHandover(db, { token: r.token, cookie: null, ip: "10.9.5.1", now: later })).toMatchObject({ kind: "expired", chatPath: null });
    const withCookie = await loadHandover(db, { token: r.token, cookie: leadCookieValue(r.newLeadId!), ip: "10.9.5.1", now: later });
    expect(withCookie).toMatchObject({ kind: "expired", chatPath: expect.stringMatching(/^\/chat\//) });
    expect(await loadHandover(db, { token: "forged.token", cookie: null, ip: "10.9.5.1" })).toEqual({ kind: "not_found" });
  });

  it("banner: checked, kept under its sha256, replaced and removed (audited); never on Preview", async () => {
    const store = new MemStore();
    expect(await saveLeadPageBanner(db, actor(), acc, page.id, new TextEncoder().encode("<svg/>"), store, {})).toEqual({ ok: false, reason: "not_an_image" });
    expect(await saveLeadPageBanner(db, actor(), acc, page.id, png(1600, 500), store, { VERCEL_ENV: "preview" })).toEqual({ ok: false, reason: "preview" });
    const a = await saveLeadPageBanner(db, actor(), acc, page.id, png(1600, 500), store, {});
    if (!a.ok) throw new Error(a.reason);
    expect(a.page.banner).toMatchObject({ contentType: "image/png", width: 1600, height: 500, size: 64 });
    expect(a.page.banner!.blobPath).toBe(`lead-pages/development/${acc}/${page.id}/${a.page.banner!.sha256}.png`);
    const b = await saveLeadPageBanner(db, actor(), acc, page.id, png(1200, 300), store, {});
    if (!b.ok) throw new Error();
    expect([...store.files.keys()]).toEqual([b.page.banner!.blobPath]);
    expect(await saveLeadPageBanner(db, actor(), other, page.id, png(10, 10), store, {})).toEqual({ ok: false, reason: "not_found" });
    expect((await removeLeadPageBanner(db, actor(), acc, page.id, store))).toMatchObject({ ok: true, page: { banner: null } });
    expect(store.files.size).toBe(0);
    expect((await audits("lead_page.banner_added")).length).toBe(1);
    expect((await audits("lead_page.banner_replaced")).length).toBe(1);
    expect((await audits("lead_page.banner_removed")).length).toBe(1);
    page = (await getLeadPage(db, acc, page.id))!;
  });

  it("edits audit the changed fields; origins are their own entry", async () => {
    const r = await updateLeadPage(db, actor(), await account(), page.id, { name: "Spring offer 2", connection: "link", language: "en", fields: { company: "on" }, openingTopic: page.openingTopic });
    expect(r).toMatchObject({ ok: true, page: { name: "Spring offer 2" } });
    expect((await audits("lead_page.updated")).at(-1)?.details).toEqual({ fields: ["name"] });
    expect(await addLeadPageOrigin(db, actor(), await account(), page.id, "staging.acme.com")).toMatchObject({ ok: true, page: { extraOrigins: ["staging.acme.com"] } });
    expect((await audits("lead_page.origins_changed")).at(-1)?.details).toEqual({ added: ["staging.acme.com"], removed: [] });
    page = (await getLeadPage(db, acc, page.id))!;
    expect((await pageByKey(db, page.publicKey))?.account.id).toBe(acc);
  });

  it("numbers: visits and opens from the counters; a cohort funnel without previews or test leads", async () => {
    const fresh = await createLeadPage(db, actor(), await account(), { name: "Funnel page", connection: "link", language: "en" });
    if (!fresh.ok) throw new Error();
    let fp = (await goLiveLeadPage(db, actor(), acc, fresh.page.id) as { page: LeadPage }).page;
    const now = new Date();
    for (let i = 0; i < 10; i++) await bumpDaily(db, acc, fp.id, now, i < 6 ? "facebook / spring" : "", "views", true);
    const a = handover(await submit(fp, { name: "Talker One", phone: nextPhone(), utm_source: "facebook", utm_campaign: "spring" }));
    const b = handover(await submit(fp, { name: "Quiet Two", phone: nextPhone() }));
    handover(await submit(fp, { name: "Preview Three", phone: nextPhone(), preview: previewTokenFor(fp.id, now) }));
    // Talker writes in the chat; Quiet calls by voice from the chat (a buyer voice session that connected).
    await loadHandover(db, { token: a.token, cookie: null, ip: "10.9.6.1" });
    await loadHandover(db, { token: b.token, cookie: null, ip: "10.9.6.2" });
    const conv = async (leadId: string) => (await db.select().from(conversations).where(eq(conversations.leadId, leadId)))[0];
    const ca = await conv(a.newLeadId!);
    await db.insert(messages).values({ accountId: acc, conversationId: ca.id, actor: "buyer", body: "How much?" });
    const cb = await conv(b.newLeadId!);
    await db.insert(voiceSessions).values({ accountId: acc, conversationId: cb.id, connectedAt: new Date(Date.now() + 1000), status: "ended", model: "scripted", mode: "scripted", ticketHash: "t".repeat(64) } as typeof voiceSessions.$inferInsert);
    const f = await pageFunnel(db, acc, fp.id, rangeOfDays(30));
    expect(f).toMatchObject({ visits: 10, opens: 10, leftDetails: 2, startedTalking: 2, gotQuote: 0, ordered: 0 });
    expect(f.percents).toEqual([null, "100%", "20%", "100%", "0%", "—"]);
    const totals = await listTotals(db, acc, rangeOfDays(30));
    expect(totals.perPage.get(fp.id)).toMatchObject({ leftDetails: 2 });
    expect(totals.totals.leftDetails).toBeGreaterThanOrEqual(2);
    expect((await listTotals(db, other, rangeOfDays(30))).perPage.has(fp.id)).toBe(false);
    const sources = await bySource(db, acc, fp.id, rangeOfDays(30));
    expect(sources).toEqual([
      { sourceKey: "facebook / spring", visits: 6, opens: 6, leads: 1, orders: 0 },
      { sourceKey: "", visits: 4, opens: 4, leads: 1, orders: 0 },
    ]);
    fp = (await getLeadPage(db, acc, fp.id))!;
    expect((await leadPageReadiness(db, await account(), fp)).find((c) => c.key === "form_opens")?.done).toBe(true);
  });
});

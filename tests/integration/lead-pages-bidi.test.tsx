/**
 * Lead pages polish (preview and bidi lane), on PGlite:
 * - a Hebrew page of a seller whose trade name has Latin letters and digits ("Polar Demo 2026-11-18 19:16:31"):
 *   the hosted form, the snippet's config and the live preview show the consent line with the seller's and the
 *   agent's names isolated (<bdi>, or parts the snippet isolates), while the consent record stores the exact plain
 *   sentence (no markup, no control characters); the "received" lines isolate the names as the connecting line does;
 * - the preview's First message tab: an approved opening template is what the chat really sends (the same
 *   decision as lib/chat/start.ts), checked against a real lead page submission and chat start.
 * No model call, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { consentRecords, leadPageSubmissions, legalSections, markets, messages, messageTemplates, sellerAccounts, users, type LeadPage, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "10.7.0.1" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const { ensureChatStarted } = await import("@/lib/chat/start");
const { submitLeadPage } = await import("@/lib/lead-pages/intake");
const { createLeadPage, goLiveLeadPage, pageByKey } = await import("@/lib/lead-pages/service");
const { snippetConfig } = await import("@/lib/lead-pages/snippet-config");
const { formTimingToken } = await import("@/lib/lead-pages/tokens");
const { handoverReceivedLine } = await import("@/lib/lead-pages/handover-text");
const { leadPagePreviewData, previewOpenerTemplate } = await import("@/lib/lead-pages/preview");
const { leadPageConsentLine } = await import("@/lib/leads/consent-line");
const { chatNames } = await import("@/lib/simulator/service");
const { DraftProvider, EMPTY_DRAFT } = await import("@/app/app/[account]/lead-pages/draft");
const { LeadPagePreview, previewFirstMessage, previewSignatures } = await import("@/app/app/[account]/lead-pages/preview");
const { default: FormPage } = await import("@/app/p/[key]/page");

const APP = "http://localhost:3000";
const SELLER = "Polar Demo 2026-11-18 19:16:31";
/** Bidi controls (LRE…RLO, LRI…PDI, LRM/RLM/ALM) and markup: none of them may be in a stored consent wording. */
const MARKS = /[‪-‮⁦-⁩‎‏؜<>]/;
const TEXT = {
  title: "Preview", tabs: { form: "Form", handover: "Hand-over", first: "First message" }, changed: "changed",
  noteSnippet: "n", noteOwn: "o", sample: "s", close: "Close", afterSave: null,
};

describe("lead pages: names isolated on screen, the stored consent line plain; the preview's first message as sent", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let ipN = 0;

  const live = async (input: Record<string, unknown>) => {
    const r = await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name: `Page ${++ipN}`, connection: "link", language: "he", ...input });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const l = await goLiveLeadPage(db, { userId: me.id, actingAs: false }, account.id, r.page.id);
    if (!l.ok) throw new Error(JSON.stringify(l));
    return l.page;
  };
  /** A real submission, then the chat started as the hand-over starts it: the lead, its consent record and the chat's first message. */
  const submitAndStart = async (page: LeadPage, name: string) => {
    const sub = await submitLeadPage(db, {
      key: page.publicKey, headers: new Headers({ origin: APP }), ip: `10.8.0.${++ipN}`, env: { APP_URL: APP },
      body: { ft: formTimingToken(page.id, Date.now() - 5000), consent: "on", name, phone: `+97254730${String(ipN).padStart(4, "0")}` },
    });
    if (sub.kind !== "handover") throw new Error(JSON.stringify(sub));
    const [row] = await db.select({ leadId: leadPageSubmissions.leadId }).from(leadPageSubmissions).where(eq(leadPageSubmissions.id, sub.submissionId));
    const [consent] = await db.select().from(consentRecords).where(eq(consentRecords.leadId, row.leadId!));
    const started = await ensureChatStarted(db, { accountId: account.id, leadId: row.leadId! });
    if (!started.started) throw new Error(JSON.stringify(started));
    const [first] = await db.select({ body: messages.body }).from(messages).where(and(eq(messages.accountId, account.id), eq(messages.id, started.messageId)));
    return { consent, first: first.body };
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-bidi", email: "bidi@p.test", firstName: "B", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: SELLER, market: "IL", languages: ["he", "en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@bidi.test" });
    if (!p.ok) throw new Error();
    const id = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, id);
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, id);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, id));
    for (const language of ["he", "en"]) await db.insert(legalSections).values({ accountId: id, sectionKey: "privacy_notice", title: "Privacy", language, version: 1, body: "x" });
    account = (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  });
  afterAll(async () => { await t.close(); });

  it("the hosted form, the snippet and the preview isolate the names in the consent line; the stored wording is the exact plain sentence", async () => {
    const names = await chatNames(db, account, "he");
    expect(names.seller).toBe(SELLER);
    const plain = leadPageConsentLine("he", names.seller, names.agent);
    expect(plain).toBe(`בשליחה, את/ה מסכים/ה ש-${SELLER} והעוזר האוטומטי ${names.agent} ייצרו איתך קשר בנוגע לפנייה ב-SMS, וואטסאפ, מייל או שיחה בצ'אט. אפשר להפסיק בכל עת.`);
    const shown = `ש-<bdi>${SELLER}</bdi> והעוזר האוטומטי <bdi>${names.agent}</bdi> ייצרו`;

    // The hosted form (/p/<key>).
    const page = await live({});
    const html = renderToStaticMarkup(await FormPage({ params: Promise.resolve({ key: page.publicKey }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('lang="he" dir="rtl"');
    expect(html).toContain(shown);

    // The snippet's config: the whole line (older scripts) and the same line in parts, names at odd indexes.
    const cfg = await snippetConfig(db, (await pageByKey(db, (await live({ connection: "snippet", address: "https://shop.example.com/contact" })).publicKey))!);
    if (!cfg || "closed" in cfg && cfg.closed) throw new Error();
    const consent = (cfg as { consent: { line: string; parts: string[] } }).consent;
    expect(consent.line).toBe(plain);
    expect(consent.parts.join("")).toBe(plain);
    expect(consent.parts.filter((_, i) => i % 2)).toEqual([SELLER, names.agent]);

    // The live preview's Form tab.
    const data = await leadPagePreviewData(db, account, { page: null, topics: [], markets: [] });
    const preview = renderToStaticMarkup(
      <DraftProvider value={{ draft: { ...EMPTY_DRAFT, connection: "link", language: "he" }, setBanner: () => {} }}><LeadPagePreview data={data} text={TEXT} /></DraftProvider>,
    );
    expect(preview).toContain(shown);

    // Stored: the exact plain sentence, for the hosted form and the snippet alike (no <bdi>, no isolate characters).
    const { consent: rec } = await submitAndStart(page, "דנה לוי");
    expect(rec.wording).toBe(plain);
    expect(rec.wording).not.toMatch(MARKS);
  });

  it("the received lines isolate a Latin or digits name in a Hebrew line, as the connecting line does; English unchanged", async () => {
    const page = await live({});
    const sent = renderToStaticMarkup(await FormPage({ params: Promise.resolve({ key: page.publicKey }), searchParams: Promise.resolve({ sent: "1" }) }));
    expect(sent).toContain(`התקבלו ב-⁨${SELLER}⁩ ונחזור`);
    expect(handoverReceivedLine({ seller: SELLER }, "Dana", "he")).toBe(`תודה, ⁨Dana⁩. הפרטים שלך התקבלו ב-⁨${SELLER}⁩ ונחזור אליך בהקדם.`);
    expect(handoverReceivedLine({ seller: "פולאר" }, "דנה", "he")).toBe("תודה, דנה. הפרטים שלך התקבלו ב-פולאר ונחזור אליך בהקדם.");
    expect(handoverReceivedLine({ seller: SELLER }, null, "en")).toBe(`Thanks. ${SELLER} received your details and will get back to you.`);
  });

  it("the First message tab shows the approved opening template the chat really sends, for the page's language and market; else the opener", async () => {
    const before = await leadPagePreviewData(db, account, { page: null, topics: [], markets: [] });
    expect(before.openerTemplates).toEqual({});
    const draftHe = { ...EMPTY_DRAFT, language: "he", topic: "" };
    expect(previewFirstMessage(draftHe, before)).toBe(before.texts.he.openers[""]);

    // An approved Hebrew opener (and a pending English one, which the chat never uses).
    await db.insert(messageTemplates).values([
      { accountId: account.id, contentSid: "HX1", name: "opener_he", language: "he", purpose: "opener", status: "approved", body: "שלום {{1}}, כאן {{2}}. איך אפשר לעזור?" },
      { accountId: account.id, contentSid: "HX2", name: "opener_en", language: "en", purpose: "opener", status: "pending", body: "Hi {{1}} from {{2}}" },
    ]);
    const data = await leadPagePreviewData(db, account, { page: null, topics: [], markets: [] });
    // As the chat start decides: the lead's language, else the market's languages in order (here the account's:
    // he, en), so an English page of this account opens with the Hebrew template too.
    const he = `שלום דנה, כאן ${SELLER}. איך אפשר לעזור?`;
    const en = `שלום Dana, כאן ${SELLER}. איך אפשר לעזור?`;
    expect(data.openerTemplates).toEqual({ "|he": he, "|en": en });
    expect(previewFirstMessage(draftHe, data)).toBe(he);
    expect(previewFirstMessage({ ...draftHe, topic: "keep" }, data)).toBe(he);
    expect(previewFirstMessage({ ...draftHe, language: "en" }, data)).toBe(en);
    // The dot follows it: the First message tab's signature is the text shown.
    expect(previewSignatures(draftHe, data).first).toBe(he);
    const html = renderToStaticMarkup(
      <DraftProvider value={{ draft: draftHe, setBanner: () => {} }}><LeadPagePreview data={data} text={TEXT} initialTab="first" /></DraftProvider>,
    );
    expect(html).toContain(`data-preview-opener="">${he}</div>`);

    // What the chat really sends to a new lead named Dana from a Hebrew page, and from an English one.
    expect((await submitAndStart(await live({}), "דנה")).first).toBe(he);
    expect((await submitAndStart(await live({ language: "en" }), "Dana")).first).toBe(en);

    // A market that sells in English only: an English page there gets the opener (no template in its languages).
    const [m] = await db.insert(markets).values({ id: crypto.randomUUID(), accountId: account.id, name: "UK", countries: ["GB"], overrides: { languages: ["en"] } }).returning();
    expect(await previewOpenerTemplate(db, account, m.id, "en")).toBeNull();
    expect(await previewOpenerTemplate(db, account, m.id, "he")).toBe(he);
    const withMarket = await leadPagePreviewData(db, account, { page: null, topics: [], markets: [m] });
    expect(withMarket.openerTemplates[`${m.id}|en`]).toBeUndefined();
    expect(previewFirstMessage({ ...draftHe, language: "en", marketId: m.id }, withMarket)).toBe(withMarket.texts.en.openers[""]);
    // And a real English lead in that market gets the opener, as the preview shows.
    expect((await submitAndStart(await live({ language: "en", marketId: m.id }), "Dana")).first).toBe(withMarket.texts.en.openers[""]);
  });
});

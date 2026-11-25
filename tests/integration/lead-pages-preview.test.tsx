/**
 * Lead pages › Add a page / Edit: the live preview (owner's request, design agreed with UX).
 * On PGlite: what the server works out for the preview (lib/lead-pages/preview.ts), checked
 * against the real buyer path (the agent's first message of a chat started from a lead page
 * submission is exactly the preview's opener, in English and Hebrew), and the preview's markup
 * for each connection, language, field choice, banner and voice gate (the same components as the
 * real pages). The interactions (tabs kept while editing, the dot, the chosen file) run in a real
 * browser: tests/e2e/lead-page-preview.spec.ts. No model call, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { agentVersions, leadPageSubmissions, legalSections, messages, sellerAccounts, users, type LeadPage, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { ensureChatStarted } from "@/lib/chat/start";
import { submitLeadPage } from "@/lib/lead-pages/intake";
import { createLeadPage, goLiveLeadPage } from "@/lib/lead-pages/service";
import { formTimingToken } from "@/lib/lead-pages/tokens";
import { SHOW_ABOUT_TOPIC } from "@/lib/lead-pages/form-text";
import { leadPagePreviewData, previewVoiceOffered, type LeadPagePreviewData } from "@/lib/lead-pages/preview";
import { DraftProvider, EMPTY_DRAFT, type LeadPageDraft } from "@/app/app/[account]/lead-pages/draft";
import { LeadPagePreview, previewSignatures, type LeadPagePreviewText, type PreviewTab } from "@/app/app/[account]/lead-pages/preview";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));

const APP = "http://localhost:3000";
const TOPICS = [{ en: "Fridge monitoring", he: "ניטור מקררים" }, { en: "Cold rooms" }];
const TEXT: LeadPagePreviewText = {
  title: "Preview", tabs: { form: "Form", handover: "Hand-over", first: "First message" }, changed: "changed",
  noteSnippet: "On your page it takes your page's font.", noteOwn: "Your own form stays as it is.", sample: "Sample buyer Dana. Nothing here is sent.",
  close: "Close", afterSave: { snippet: "You get the snippet when you save.", own_form: "You get your form's address when you save.", link: "You get the link for your button when you save." },
};

describe("lead pages: the live preview on Add a page / Edit", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let data: LeadPagePreviewData;
  let ipN = 0;

  const render = (draft: Partial<LeadPageDraft>, opts: { tab?: PreviewTab; data?: LeadPagePreviewData } = {}) => renderToStaticMarkup(
    <DraftProvider value={{ draft: { ...EMPTY_DRAFT, ...draft }, setBanner: () => {} }}>
      <LeadPagePreview data={opts.data ?? data} text={TEXT} initialTab={opts.tab} />
    </DraftProvider>,
  );
  /** The buyer's screen inside the frame. */
  const screen = (html: string) => html.match(/<div class="lpv-screen" aria-hidden="true"><div class="lpv-inert" inert="">([\s\S]*)<\/div><\/div><\/div><p/)?.[1] ?? "";

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [me] = await db.insert(users).values({ clerkId: "u-prev", email: "prev@p.test", firstName: "P", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@prev.test" });
    if (!p.ok) throw new Error();
    const id = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    const draft = await ensureDraftVersion(db, id);
    await db.update(agentVersions).set({ playbook: { ...draft.playbook, opener: { topics: TOPICS, defaultTopic: 0 } } }).where(eq(agentVersions.id, draft.id));
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, id);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, id));
    for (const language of ["en", "he"]) {
      await db.insert(legalSections).values({ accountId: id, sectionKey: "privacy_notice", title: "Privacy notice", language, version: 1, body: "We keep your details." });
    }
    account = (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
    data = await leadPagePreviewData(db, account, { page: null, topics: TOPICS, markets: [] });
  });
  afterAll(async () => { vi.unstubAllEnvs(); await t.close(); });

  /** A real submission from a live page with this topic, then the chat started as the hand-over starts it: the agent's first message. */
  const realOpener = async (language: "en" | "he", topic: { en: string; he?: string } | null, name: string) => {
    const r = await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name: `Page ${++ipN}`, connection: "link", language, openingTopic: topic });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const live = await goLiveLeadPage(db, { userId: me.id, actingAs: false }, account.id, r.page.id);
    if (!live.ok) throw new Error(JSON.stringify(live));
    const page: LeadPage = live.page;
    const sub = await submitLeadPage(db, {
      key: page.publicKey, headers: new Headers({ origin: APP }), ip: `10.9.0.${ipN}`, env: { APP_URL: APP },
      body: { ft: formTimingToken(page.id, Date.now() - 5000), consent: "on", name, phone: `+97254720${String(ipN).padStart(4, "0")}` },
    });
    if (sub.kind !== "handover") throw new Error(JSON.stringify(sub));
    const [row] = await db.select({ leadId: leadPageSubmissions.leadId }).from(leadPageSubmissions).where(eq(leadPageSubmissions.id, sub.submissionId));
    const started = await ensureChatStarted(db, { accountId: account.id, leadId: row.leadId! });
    if (!started.started) throw new Error(JSON.stringify(started));
    const [first] = await db.select({ body: messages.body }).from(messages).where(and(eq(messages.accountId, account.id), eq(messages.id, started.messageId)));
    return first.body;
  };

  it("the First message tab is the real opener for the chosen topic, in English and Hebrew, for a new lead named Dana", async () => {
    // Topic 0 in English and Hebrew; topic 1 has no Hebrew version (the default topic's Hebrew is used); no topic.
    expect(data.texts.en.openers["0"]).toBe(await realOpener("en", TOPICS[0], "Dana Levi"));
    expect(data.texts.he.openers["0"]).toBe(await realOpener("he", TOPICS[0], "דנה לוי"));
    expect(data.texts.en.openers["1"]).toBe(await realOpener("en", TOPICS[1], "Dana Cohen"));
    expect(data.texts.he.openers["1"]).toBe(await realOpener("he", TOPICS[1], "דנה כהן"));
    expect(data.texts.en.openers[""]).toBe(await realOpener("en", null, "Dana Mor"));
    expect(data.texts.en.openers["0"]).toMatch(/^Hi Dana, .*You asked about Fridge monitoring\./);
    expect(data.texts.en.openers["1"]).toContain("You asked about Cold rooms.");
    expect(data.texts.he.openers["0"]).toContain("דנה");
    expect(data.texts.he.openers["0"]).toContain("ניטור מקררים");
    // Shown in the tab for the chosen topic and language (switched on the client: precomputed, no network).
    for (const [language, topic] of [["en", "1"], ["he", "0"]] as const) {
      const html = render({ language, topic }, { tab: "first" });
      expect(screen(html)).toContain(`data-preview-opener="">${data.texts[language].openers[topic].replace(/'/g, "&#x27;").replace(/"/g, "&quot;")}</div>`);
      expect(screen(html)).toContain(`lang="${language}"`);
    }
  });

  it("the Form tab: Name and Phone always, Company and Email as chosen; the consent tick; the privacy link where a notice exists; the brand colour", () => {
    const plain = screen(render({ connection: "link" }));
    expect(plain).toContain("Full name");
    expect(plain).toContain("Mobile number");
    expect(plain).not.toContain('name="company"');
    expect(plain).not.toContain('name="email"');
    expect(plain).not.toMatch(/name="consent" checked=""/);
    expect(plain).toContain("Privacy notice");
    expect(plain).toContain("--brand:");
    const more = screen(render({ connection: "link", company: true, email: true, consent: true }));
    expect(more).toContain("Company (optional)");
    expect(more).toContain('name="email"');
    expect(more).toMatch(/name="consent" checked=""/);
    expect(more).toContain("By sending, you agree that <bdi>Polar Demo</bdi> and its automated assistant <bdi>");
    // The About line follows SHOW_ABOUT_TOPIC, as on the real form.
    expect(more.includes("data-lp-about")).toBe(SHOW_ABOUT_TOPIC);
  });

  it("the Form tab follows the form language and direction (Hebrew right to left); no privacy link without a notice for that market and language", () => {
    expect(data.privacy).toEqual(["|en", "|he"]);
    const he = screen(render({ connection: "link", language: "he" }));
    expect(he).toContain('lang="he" dir="rtl"');
    expect(he).toContain("שם מלא");
    expect(he).toContain("השאירו פרטים");
    expect(he).toContain('class="lp-link"');
    expect(screen(render({ connection: "link", language: "he" }, { data: { ...data, privacy: ["|en"] } }))).not.toContain('class="lp-link"');
    const en = screen(render({ connection: "link", language: "en" }));
    expect(en).toContain('lang="en" dir="ltr"');
  });

  it("each connection: our form on a sample page with the font note; your own form's note; the hosted form with the initials tile", () => {
    const snippet = render({ connection: "snippet" });
    expect(screen(snippet)).toContain('data-preview-screen="snippet"');
    expect(screen(snippet)).not.toContain("lp-tile");
    expect(snippet).toContain("On your page it takes your page&#x27;s font.");
    const own = render({ connection: "own_form" });
    expect(screen(own)).toContain("Your own form stays as it is.");
    expect(screen(own)).not.toContain('name="phone"');
    // The other two tabs stay.
    expect(own).toContain('data-preview-tab="handover"');
    expect(own).toContain('data-preview-tab="first"');
    const link = screen(render({ connection: "link" }));
    expect(link).toContain('class="lp-root lp-root--form"');
    expect(link).toContain('class="lp-tile" aria-hidden="true">PD</span>');
    // The "when you save" notes on Add (the checked card's shows); none on Edit.
    expect(snippet).toContain('data-for="link" data-preview-after="link">You get the link for your button when you save.');
    expect(renderToStaticMarkup(
      <DraftProvider value={{ draft: EMPTY_DRAFT, setBanner: () => {} }}><LeadPagePreview data={data} text={{ ...TEXT, afterSave: null }} /></DraftProvider>,
    )).not.toContain("data-preview-after");
  });

  it("nothing in the frame can be used: inert and hidden from assistive tech; the tabs stay accessible", () => {
    const html = render({ connection: "link" });
    expect(html).toContain('<div class="lpv-screen" aria-hidden="true"><div class="lpv-inert" inert="">');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/role="tab" id="[^"]+-tab-form" aria-selected="true"/);
    expect(html).toContain('role="tablist" aria-label="Preview"');
    expect(html).toContain('role="tabpanel"');
    // Never a form or a link to a page in the preview; the submit button posts nowhere.
    expect(screen(html)).not.toContain("<form");
    expect(screen(html)).not.toContain("<main");
    expect(screen(html)).not.toContain("<h1");
  });

  it("the Hand-over tab: initials tile or the saved banner, thanks Dana, the connecting line, the buttons by the voice gate, the by-line", async () => {
    const tile = screen(render({ language: "en" }, { tab: "handover" }));
    expect(tile).toContain('data-handover="chat"');
    expect(tile).toContain("Thanks, Dana");
    expect(tile).toMatch(/Connecting you with .+, Polar Demo(&#x27;|')s automated assistant/);
    expect(tile).toContain("lp-tile");
    expect(tile).toContain("Conversation by Sales at Scale");
    // Voice off (VOICE_REALTIME unset): Continue to the chat, shown enabled.
    expect(data.voiceOffered).toBe(false);
    expect(tile).toContain("Continue to the chat");
    expect(tile).not.toContain("disabled");
    const he = screen(render({ language: "he" }, { tab: "handover" }));
    expect(he).toContain("תודה, דנה");
    expect(he).toContain('dir="rtl" data-handover="chat"');

    vi.stubEnv("VOICE_REALTIME", "scripted");
    expect(await previewVoiceOffered(db, account)).toBe(true);
    const voice = await leadPagePreviewData(db, account, { page: null, topics: TOPICS, markets: [] });
    vi.unstubAllEnvs();
    const both = screen(render({}, { tab: "handover", data: voice }));
    expect(both).toContain("Talk now");
    expect(both).toContain("Chat in writing");
    expect(await previewVoiceOffered(db, { ...account, voiceBuyerCallsOff: true })).toBe(false);

    const banner = screen(render({}, { tab: "handover", data: { ...data, savedBanner: { src: "/api/lp/k/banner/abc", width: 1600, height: 400 } } }));
    expect(banner).toContain('<img src="/api/lp/k/banner/abc" width="1600" height="400"');
    expect(banner).not.toContain("lp-tile");
  });

  it("a change marks only the tabs it changes (the dot), and the About line only when it shows", () => {
    const base: LeadPageDraft = { ...EMPTY_DRAFT, connection: "link", topic: "0" };
    const s0 = previewSignatures(base, data);
    const banner = previewSignatures({ ...base, banner: "blob:x" }, data);
    expect(banner.handover).not.toBe(s0.handover);
    expect(banner.first).toBe(s0.first);
    // On the snippet the banner is not on the form; on a button or link it is (the hosted form's header).
    expect(previewSignatures({ ...base, connection: "snippet", banner: "blob:x" }, data).form).toBe(previewSignatures({ ...base, connection: "snippet" }, data).form);
    expect(banner.form).not.toBe(s0.form);
    const topic = previewSignatures({ ...base, topic: "1" }, data);
    expect(topic.first).not.toBe(s0.first);
    expect(topic.handover).toBe(s0.handover);
    expect(topic.form === s0.form).toBe(!SHOW_ABOUT_TOPIC);
    const company = previewSignatures({ ...base, company: true }, data);
    expect([company.form !== s0.form, company.handover === s0.handover, company.first === s0.first]).toEqual([true, true, true]);
  });
});

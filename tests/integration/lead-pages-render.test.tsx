/**
 * Lead pages (slice a-1): render tests of the hosted form (/p/<key>) and the
 * hand-over (/h/<token>) in English and Hebrew, with and without a banner,
 * voice off and on, the returning buyer, no consent and an expired link.
 * Template opener only (no model call); SMS mock (no network).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { leadPages, leadPageSubmissions, legalSections, sellerAccounts, users, type LeadPage, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { ensureDraftVersion, publishDraftVersion } from "@/lib/agent/service";
import { submitLeadPage } from "@/lib/lead-pages/intake";
import { createLeadPage, goLiveLeadPage } from "@/lib/lead-pages/service";
import { formTimingToken, previewTokenFor } from "@/lib/lead-pages/tokens";
import { createTestDb, type TestDb } from "../helpers/db";
import { SHOW_ABOUT_TOPIC } from "@/lib/lead-pages/form-text";

const holder = vi.hoisted(() => ({ db: null as unknown, ip: "10.1.0.1", cookie: null as string | null, referer: null as string | null }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return holder.db; } }));
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": holder.ip, ...(holder.referer ? { referer: holder.referer } : {}) }),
  cookies: async () => ({ get: (n: string) => (n === "sas_lp" && holder.cookie ? { name: n, value: holder.cookie } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { default: FormPage } = await import("@/app/p/[key]/page");
const { default: PrivacyPage } = await import("@/app/p/[key]/privacy/page");
const { default: HandoverPage } = await import("@/app/h/[token]/page");

const APP = "http://localhost:3000";
const SHA = "ab".repeat(32);
/** With LP_RENDER_DIR set, the rendered buyer pages are also written there as HTML (visual check). */
const save = (name: string, html: string) => {
  const dir = process.env.LP_RENDER_DIR;
  if (!dir) return;
  const css = ["components/sas/sas.css", "app/chat/[token]/chat.css", "app/p/[key]/lead-page.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body style="margin:0">${html}</body></html>`);
};

describe("lead pages (a-1): hosted form and hand-over render", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: string;
  let en: LeadPage, he: LeadPage;
  let ipN = 0;
  let phoneN = 2000;
  const nextPhone = () => `+9725472${String(++phoneN).padStart(5, "0")}`;
  const form = async (p: LeadPage, sp: Record<string, string> = {}) => renderToStaticMarkup(await FormPage({ params: Promise.resolve({ key: p.publicKey }), searchParams: Promise.resolve(sp) }));
  const hand = async (token: string) => {
    holder.ip = `10.2.0.${++ipN}`;
    return renderToStaticMarkup(await HandoverPage({ params: Promise.resolve({ token }) }));
  };
  const submit = async (p: LeadPage, body: Record<string, unknown>) => {
    const r = await submitLeadPage(db, {
      key: p.publicKey, headers: new Headers({ origin: APP }), ip: `10.3.0.${++ipN}`, env: { APP_URL: APP },
      body: { ft: formTimingToken(p.id, Date.now() - 5000), consent: "on", ...body },
    });
    if (r.kind !== "handover") throw new Error(JSON.stringify(r));
    return r;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await ensureDraftVersion(db, acc);
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    await db.update(sellerAccounts).set({ status: "live" }).where(eq(sellerAccounts.id, acc));
    for (const lang of ["en", "he"]) {
      await db.insert(legalSections).values({ accountId: acc, sectionKey: "privacy_notice", title: lang === "he" ? "הודעת פרטיות" : "Privacy notice", language: lang, version: 1, body: "We keep your details to answer your request." });
    }
    const account = (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc)))[0];
    const mk = async (language: string, name: string) => {
      const r = await createLeadPage(db, { userId: me.id, actingAs: false }, account, { name, connection: "link", language, fields: { company: "on" }, openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" } });
      if (!r.ok) throw new Error();
      const live = await goLiveLeadPage(db, { userId: me.id, actingAs: false }, acc, r.page.id);
      if (!live.ok) throw new Error();
      return live.page;
    };
    en = await mk("en", "Spring offer");
    he = await mk("he", "מבצע אביב");
  });
  afterAll(async () => { vi.unstubAllEnvs(); await t.close(); });

  it("the hosted form (en, no banner): initials tile, fields, ticked consent line for Israel, honeypot, timing token, privacy link", async () => {
    holder.referer = "https://www.facebook.com/ads";
    const html = await form(en, { utm_source: "facebook", utm_campaign: "spring", fbclid: "abc" });
    holder.referer = null;
    save("hosted-en", html);
    expect(html).toContain('lang="en" dir="ltr"');
    // The page's opening topic, one muted line above the title (new wording behind SHOW_ABOUT_TOPIC).
    if (SHOW_ABOUT_TOPIC) expect(html).toMatch(/data-lp-about="">About: Fridge monitoring<\/p><h1 class="lp-title">Leave your details/);
    else expect(html).not.toContain("About: Fridge monitoring");
    expect(html).toContain("Leave your details");
    expect(html).toContain('class="lp-tile" aria-hidden="true">PD</span>');
    expect(html).not.toContain("lp-banner");
    expect(html).toContain("Full name");
    expect(html).toContain("Mobile number");
    expect(html).toContain("Company (optional)");
    expect(html).not.toContain("Email (optional)");
    expect(html).toContain("By sending, you agree that <bdi>Polar Demo</bdi> and its automated assistant <bdi>");
    expect(html).toMatch(/name="consent" checked=""/);
    expect(html).toMatch(/<input tabindex="-1" autoComplete="off" name="sas_url" value=""\/>/);
    expect(html).toMatch(/name="ft" value="[0-9a-z]+\.[A-Za-z0-9_-]{22}"/);
    expect(html).toContain('name="utm_source" value="facebook"');
    expect(html).toContain('name="referrer" value="www.facebook.com"');
    expect(html).toContain(`href="/p/${en.publicKey}/privacy"`);
    expect(html).toContain(`action="/api/lp/${en.publicKey}/submit"`);
    // No personal details anywhere in the URLs of the page.
    expect(html).not.toMatch(/\?[^"]*(name|phone)=/);
  });

  it("the hosted form (he, banner): the banner whole with its size, nothing over it; Hebrew right to left", async () => {
    await db.update(leadPages).set({ banner: { blobPath: "x", contentType: "image/webp", size: 10, sha256: SHA, width: 1600, height: 500 } }).where(eq(leadPages.id, he.id));
    const html = await form(he);
    expect(html).toContain('lang="he" dir="rtl"');
    expect(html).toContain("השאירו פרטים");
    if (SHOW_ABOUT_TOPIC) expect(html).toContain("בנושא: ניטור מקררים");
    expect(html).toContain("שם מלא");
    expect(html).toContain("והעוזר האוטומטי");
    expect(html).toContain(`<img src="/api/lp/${he.publicKey}/banner/${SHA}" width="1600" height="500"`);
    expect(html).toContain("aspect-ratio:1600 / 500");
    expect(html).not.toContain("lp-tile");
    await db.update(leadPages).set({ banner: null }).where(eq(leadPages.id, he.id));
  });

  it("the form's other states: an error after a no-JS post, the plain thanks, a paused page, a draft (closed unless preview), the privacy page", async () => {
    expect(await form(en, { e: "phone" })).toContain("Enter a valid mobile number.");
    expect(await form(en, { e: "busy" })).toContain("Too many attempts.");
    expect(await form(en, { sent: "1" })).toContain("Thanks. Polar Demo received your details and will get back to you.");
    await db.update(leadPages).set({ status: "paused" }).where(eq(leadPages.id, en.id));
    expect(await form(en)).toContain("This form is not taking requests right now.");
    await db.update(leadPages).set({ status: "draft" }).where(eq(leadPages.id, en.id));
    // A real page that is not live: the hosted frame with the closed line (never a bare 404), even with ?sent=1.
    const closed = await form(en);
    expect(closed).toContain('data-lp-closed=""');
    expect(closed).toContain("This form is not taking requests right now.");
    expect(closed).not.toContain('name="phone"');
    expect(await form(en, { sent: "1" })).toContain("This form is not taking requests right now.");
    // A key that does not exist is still a 404.
    await expect(FormPage({ params: Promise.resolve({ key: "AAAAAAAAAAAA" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    const token = previewTokenFor(en.id, new Date());
    const preview = await form(en, { preview: token });
    expect(preview).toContain('name="preview"');
    // A preview visit sends its view with the token (the server ticks "The form opened from the link" without counting it).
    const findBeacon = (n: unknown): { url: string; body: string } | null | undefined => {
      if (!n || typeof n !== "object") return undefined;
      const props = (n as { props?: Record<string, unknown> }).props;
      if (props && "beacon" in props) return props.beacon as { url: string; body: string } | null;
      for (const c of [props?.children].flat()) { const f = findBeacon(c); if (f !== undefined) return f; }
      return undefined;
    };
    const tree = await FormPage({ params: Promise.resolve({ key: en.publicKey }), searchParams: Promise.resolve({ preview: token }) });
    const b = findBeacon(tree);
    expect(b?.url).toBe(`/api/lp/${en.publicKey}/e`);
    expect(JSON.parse(b!.body)).toEqual({ t: "view", preview: token });
    // No topic: no About line.
    await db.update(leadPages).set({ openingTopic: null }).where(eq(leadPages.id, en.id));
    expect(await form(en, { preview: token })).not.toContain("data-lp-about");
    await db.update(leadPages).set({ openingTopic: { en: "Fridge monitoring", he: "ניטור מקררים" } }).where(eq(leadPages.id, en.id));
    await db.update(leadPages).set({ status: "live" }).where(eq(leadPages.id, en.id));
    const privacy = renderToStaticMarkup(await PrivacyPage({ params: Promise.resolve({ key: he.publicKey }), searchParams: Promise.resolve({}) }));
    expect(privacy).toContain("הודעת פרטיות");
    expect(privacy).toContain("חזרה לטופס");
  });

  it("the hand-over (en, voice off): thanks, connecting line, one button, the chat mounted under it off screen", async () => {
    const r = await submit(en, { name: "Rina Mizrahi", phone: nextPhone() });
    const html = await hand(r.token);
    save("handover-en", html);
    expect(html).toContain('data-handover="chat"');
    // The ring, the lines and the buttons in one block, centred above the by-line.
    expect(html).toMatch(/<div class="lp-hand"><div class="lp-hand__mid">.*Continue to the chat.*<\/div><p class="lp-by">Conversation by Sales at Scale<\/p><\/div>/s);
    expect(html).toContain("Thanks, Rina");
    expect(html).toMatch(/Connecting you with .+, Polar Demo(&#x27;|')s automated assistant/);
    expect(html).toContain("Continue to the chat");
    expect(html).not.toContain("Talk now");
    expect(html).not.toContain("Chat in writing");
    // The buttons show and work at once (owner, 26 Nov): no minimum wait, the ring calm.
    expect(html).not.toMatch(/data-handover-continue=""[^>]*disabled=""|disabled=""[^>]*data-handover-continue=""/);
    expect(html).toContain('data-ring="done"');
    expect(html).toContain('class="lp-offstage" inert="" aria-hidden="true" data-handover-chat="handover"');
    // No opener after Send (owner, 26 Nov): the chat waits for the buyer's choice.
    expect(html).not.toContain("You asked about Fridge monitoring.");
    expect(html).toContain("Conversation by Sales at Scale");
    // Mock SMS: never the "sent" line.
    expect(html).not.toContain("We also sent this link to your phone.");
    expect(html).toContain('class="lp-tile"');
    // The chat token never shows in a URL on the hand-over (only the replaceState target, in the client props).
    expect(html).not.toMatch(/href="\/chat\/(?!stop\/)/);
  });

  it("the hand-over (he, banner, voice on, SMS sent): Talk now and Chat in writing, the SMS line, Hebrew right to left", async () => {
    vi.stubEnv("VOICE_REALTIME", "scripted");
    await db.update(leadPages).set({ banner: { blobPath: "x", contentType: "image/png", size: 10, sha256: SHA, width: 1200, height: 400 } }).where(eq(leadPages.id, he.id));
    const r = await submit(he, { name: "רינה מזרחי", phone: nextPhone() });
    await db.update(leadPageSubmissions).set({ sms: "sent" }).where(eq(leadPageSubmissions.id, r.submissionId));
    const html = await hand(r.token);
    vi.unstubAllEnvs();
    await db.update(leadPages).set({ banner: null }).where(eq(leadPages.id, he.id));
    expect(html).toContain('lang="he" dir="ltr"');
    expect(html).toContain('dir="rtl" data-handover="chat"');
    expect(html).toContain("תודה, רינה");
    expect(html).toContain("לדבר עכשיו");
    expect(html).toContain("התכתבות בצ&#x27;אט");
    expect(html).toContain("שלחנו את הקישור גם לטלפון שלך.");
    expect(html).toContain(`<img src="/api/lp/${he.publicKey}/banner/${SHA}" width="1200" height="400"`);
    expect(html).not.toContain("lp-tile");
    expect(html).toContain("השיחה מופעלת על ידי Sales at Scale");
    // The prefix letter before a Latin agent name gets a hyphen (it rendered as part of the name), the name stays isolated.
    expect(html).toMatch(/מחברים אותך ל-⁨[A-Za-z][^⁩]*⁩/);
  });

  it("the returning number from another browser: the same screens as a new buyer, its own fresh chat; never the existing lead's chat or name", async () => {
    const phone = nextPhone();
    const first = await submit(en, { name: "Dana Levi", phone });
    await hand(first.token);
    const again = await submit(en, { name: "Someone Else", phone });
    expect(again.newLeadId).not.toBeNull();
    expect(again.newLeadId).not.toBe(first.newLeadId);
    const back = await hand(again.token);
    expect(back).toContain('data-handover="chat"');
    expect(back).toContain("Thanks, Someone");
    expect(back).toContain("Continue to the chat");
    // Its own fresh chat, prepared without the opener (it follows the buyer's choice).
    expect(back).toContain('data-handover-chat="handover"');
    expect(back).not.toContain("You asked about Fridge monitoring.");
    expect(back).not.toContain("Dana");
    expect(back).not.toContain("Welcome back");
    expect(back).not.toContain("received your details");
    expect(back).not.toContain("We also sent this link to your phone.");
  });

  it("no consent: received, no buttons, no chat; an expired link says so; a forged one is a 404", async () => {
    const r = await submit(he, { name: "בלי הסכמה", phone: nextPhone(), consent: "" });
    const html = await hand(r.token);
    expect(html).toContain('data-handover="received"');
    // The Latin trade name isolated in the Hebrew line (as on the connecting line).
    expect(html).toContain("תודה, בלי. הפרטים שלך התקבלו ב-\u2068Polar Demo\u2069 ונחזור");
    expect(html).not.toContain("lp-offstage");
    await db.update(leadPageSubmissions).set({ createdAt: new Date(Date.now() - 40 * 60_000) }).where(eq(leadPageSubmissions.id, r.submissionId));
    expect(await hand(r.token)).toContain("תוקף הדף פג.");
    await expect(hand("AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

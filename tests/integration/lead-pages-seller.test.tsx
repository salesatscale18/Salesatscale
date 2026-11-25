/**
 * Lead pages phase 1, slice a-2 (seller side) on PGlite with two demo
 * accounts: the demo seed's live page (banner through the normal banner save),
 * the server actions (save, go live, pause, resume, banner, preview link) and
 * their account checks, the numbers (preview and test leads left out), the
 * Leads `?page=` filter, the lead card's and the conversation's source lines,
 * and render tests of the list, the add form and one page.
 * No model call, no network: the blob store is an in-memory store.
 *
 * With LP_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import {
  auditLog, conversations, leadPageSubmissions, leadPages, leads, sellerAccounts, users, type LeadPage, type SellerAccount, type User,
} from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { t as msg } from "@/lib/i18n";
import { OWN_FORM_ERROR_TEXT } from "@/lib/lead-pages/refusal";
import { OWN_FORM_ERRORS } from "@/lib/lead-pages/rules";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, files: new Map<string, Uint8Array>() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@/lib/sources/blob", async (orig) => {
  const real = await orig<typeof import("@/lib/sources/blob")>();
  const store = {
    async put(p: string, b: Uint8Array) { holder.files.set(p, b); },
    async get(p: string) { return holder.files.get(p) ?? null; },
    async del(p: string) { holder.files.delete(p); },
  };
  return { ...real, fileStore: () => store, blobEnvironment: () => "development" as const };
});
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

const { createDemoAccount } = await import("@/lib/demo/seed");
const { DEMO_LEAD_PAGE, seedDemoLeadPage } = await import("@/lib/demo/lead-page-seed");
const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { createLeadPage, listLeadPages, getLeadPage, latestLeadsOfPage, leadPageSourceOf } = await import("@/lib/lead-pages/service");
const { listTotals, pageFunnel, rangeOfDays } = await import("@/lib/lead-pages/stats");
const { listLeads } = await import("@/lib/leads/service");
const actions = await import("@/app/app/[account]/lead-pages/actions");
const { default: ListPage } = await import("@/app/app/[account]/lead-pages/page");
const { default: NewPage } = await import("@/app/app/[account]/lead-pages/new/page");
const { default: PageView } = await import("@/app/app/[account]/lead-pages/[pageId]/page");
const { default: EditPage } = await import("@/app/app/[account]/lead-pages/[pageId]/edit/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

const css = ["components/sas/sas.css", "app/app/[account]/lead-pages/lead-pages.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
const save = (name: string, html: string) => {
  const dir = process.env.LP_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Params = Record<string, string>;
type Page = (p: { params: Promise<Params>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Params, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
const form = (v: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.append(k, val);
  return f;
};
/** Runs a server action and returns the URL it redirected to, or its returned state. */
const run = async (p: Promise<unknown>): Promise<{ url?: string; state?: unknown }> => {
  try {
    return { state: await p };
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return { url };
    throw e;
  }
};
/** A tiny PNG header (the banner check reads only the header). */
function png(w: number, h: number, size = 64) {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

describe("lead pages (a-2): seller pages, actions, filter and numbers", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User, seller: User;
  let a: SellerAccount, b: SellerAccount, c: SellerAccount;
  let demoPage: LeadPage, otherPage: LeadPage;
  const as = (account: SellerAccount) => { holder.access = { account, user: seller, actingAs: false, role: "seller_admin" }; };
  const audits = async (accountId: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action)));
  const leadByName = async (accountId: string, name: string) => (await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.fullName, name))))[0];

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u", email: "u@seller.test", role: "user", firstName: "Sam" },
    ]).returning();
    const ra = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    const rb = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!ra.ok || !rb.ok) throw new Error("demo seed refused");
    [a] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, ra.summary.accountId));
    [b] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, rb.summary.accountId));
    const p = parseCreateAccount({ tradeName: "Empty Co", market: "GB", languages: ["en"], timezone: "Europe/London", currency: "GBP", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@empty.test" });
    if (!p.ok) throw new Error("account input");
    c = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
    [demoPage] = await listLeadPages(db, a.id);
    [otherPage] = await listLeadPages(db, b.id);
    as(a);
  }, 180_000);
  afterAll(async () => { await t.close(); });

  it("the demo seed: one live Button or link page, its banner saved through the banner save, counters and two submissions", async () => {
    expect(await listLeadPages(db, a.id)).toHaveLength(1);
    expect(demoPage).toMatchObject({ name: DEMO_LEAD_PAGE.name, status: "live", connection: "link", language: "en" });
    expect(demoPage.wentLiveAt).not.toBeNull();
    // Saved like a seller's upload: in the blob store under its sha256, with its pixel size; audited.
    expect(demoPage.banner).toMatchObject({ contentType: "image/webp", size: 80008 });
    expect(demoPage.banner!.width).toBeGreaterThan(1000);
    expect(holder.files.has(demoPage.banner!.blobPath)).toBe(true);
    expect(demoPage.banner!.blobPath).toBe(`lead-pages/development/${a.id}/${demoPage.id}/${demoPage.banner!.sha256}.webp`);
    expect(await audits(a.id, "lead_page.banner_added")).toHaveLength(1);
    expect(await audits(a.id, "lead_page.went_live")).toHaveLength(1);
    const subs = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.pageId, demoPage.id));
    expect(subs).toHaveLength(2);
    // The funnel counts the two leads' chats, their quotes and the signed order.
    const f = await pageFunnel(db, a.id, demoPage.id, rangeOfDays(30));
    expect(f).toMatchObject({ leftDetails: 2, startedTalking: 2, gotQuote: 2, ordered: 1 });
    expect(f.opens).toBeGreaterThan(100);
    expect(f.visits).toBe(f.opens);

    // Where nothing can be stored (tests without a store, Preview), the page is seeded without the banner.
    const bare = await seedDemoLeadPage(db, { userId: admin.id, actingAs: true }, c.id, { now: new Date(), store: null, submissions: [] }).catch((e: Error) => e);
    // Account c is not live and has no privacy notice: the seed's go-live check refuses (the demo account always passes it).
    expect(bare).toBeInstanceOf(Error);
    const noStore = await seedDemoLeadPage(db, { userId: admin.id, actingAs: true }, b.id, { now: new Date(), store: null, submissions: [] });
    expect(noStore.bannerSaved).toBe(false);
    expect((await getLeadPage(db, b.id, noStore.pageId))!.banner).toBeNull();
    await db.delete(leadPages).where(eq(leadPages.id, noStore.pageId));
    await db.delete(leadPages).where(and(eq(leadPages.accountId, c.id)));
  });

  it("list: totals and each page's funnel; filters in the URL; the empty state", async () => {
    const html = await render(ListPage, { account: a.slug });
    save("list", html);
    const s = text(html);
    expect(s).toContain("Lead pages");
    expect(s).toContain(DEMO_LEAD_PAGE.name);
    expect(s).toContain("Button or link");
    expect(s).toContain("polar-demo.example/restaurants");
    expect(html).toContain('data-status="lead_page.live"');
    expect(html).toMatch(/data-cell="leads"><strong>2<\/strong>/);
    expect(html).toMatch(/data-cell="orders">1</);
    // A button or link has no visits: a dash in the row and on the card.
    expect(html).toMatch(/data-cell="visits"><span class="lpg-dash"/);
    expect(s).toMatch(/Visits — Not counted for a button, a link or your own form/);
    expect(s).toMatch(/Leads 2 \d+ opened the form/);
    expect(s).toMatch(/Orders 1 50% of leads/);
    expect(s).not.toMatch(/Visitors/);
    for (const sp of [{ status: "draft" }, { q: "zzz" }] as Record<string, string>[]) expect(text(await render(ListPage, { account: a.slug }, sp))).toContain("No pages match.");
    expect(text(await render(ListPage, { account: a.slug }, { q: "fridge", status: "live" }))).toContain(DEMO_LEAD_PAGE.name);
    // Another account's pages never show.
    expect(text(await render(ListPage, { account: b.slug }, {}))).not.toContain(a.id);
    as(c);
    const empty = await render(ListPage, { account: c.slug });
    save("list-empty", empty);
    expect(text(empty)).toContain("No lead pages yet");
    as(a);
  });

  it("add form: the snippet (default) and Button or link can be chosen, the pixel switch and note, the ad-details switch and the banner help", async () => {
    const html = await render(NewPage, { account: a.slug });
    save("add", html);
    const s = text(html);
    expect((html.match(/<input type="radio" disabled="" name="connection" value="(snippet|own_form|hosted)"\/>/g) ?? []).length).toBe(1);
    expect(html).toContain('<input type="radio" name="connection" checked="" value="snippet"/>');
    expect(html).toContain('<input type="radio" name="connection" value="own_form"/>');
    expect(html).toContain('<input type="radio" name="connection" value="link"/>');
    expect(s).not.toContain("Coming next");
    // Slice b: the snippet's parts (shown by CSS for the checked card).
    expect(s).toContain("Tell my page's ad pixel when a lead is sent");
    expect(html).toMatch(/name="tellPagePixel" checked=""/);
    expect(s).toContain("Address of your page");
    expect(s).toContain("You get the snippet when you save.");
    // The right column is the live preview; the snippet, the link, the other addresses and the checks are on the page's view after saving.
    expect(html).toContain('data-preview=""');
    expect(html).not.toContain("data-snippet-card");
    expect(html).not.toContain("data-origins");
    expect(html).not.toContain('name="newOrigin"');
    expect(s).toContain("Later");
    expect(s).toContain("Your ad pixel is not told about leads from this link.");
    expect(s).toContain("Carry ad details through to the lead");
    expect(s).toContain("at most 40% of the screen height");
    expect(s).toContain("At least 1200 px wide");
    expect(s).toContain("JPG, PNG or WebP, up to 2 MB");
    expect(s).toContain("your company's initials");
    expect(s).not.toMatch(/Meta pixel ID|Google tag ID|pixel received|logo/i);
    // The demo's home market is Israel: the consent box is ticked by default.
    expect(html).toMatch(/name="consentTicked" checked=""/);
  });

  it("add form: the address helper follows the connection card (required / recommended / optional, last for a button or link); only Company and Email are optional fields; the banner field", async () => {
    const html = await render(NewPage, { account: a.slug });
    // One address input, with one label and one helper per connection (CSS shows the checked card's).
    expect(html.match(/name="address"/g)?.length).toBe(1);
    const field = html.match(/<label class="lpg-field lpg-field--address" data-address-field="">([\s\S]*?)<\/label>/)?.[1] ?? "";
    const part = (who: string, cls: string) => field.match(new RegExp(`<span class="${cls}" data-for="${who}">([^<]*)</span>`))?.[1];
    // Marked as required in its label (only for "Our form on your page").
    expect(field).toContain('<span class="lpg-field__label" data-for="snippet">Address of your page <span class="lpg-req">(required)</span></span>');
    expect(field.match(/lpg-req/g)?.length).toBe(1);
    expect(part("snippet", "sas-small")).toMatch(/^Required\. Where the form will be, like https:\/\/example\.com\/offer\./);
    expect(part("own_form", "lpg-field__label")).toBe("Address of the page with your form (recommended)");
    expect(part("own_form", "sas-small")).toMatch(/^Optional, but recommended\. .*Without an address, the first send is refused/);
    expect(part("link", "lpg-field__label")).toBe("Address of the page with the button (optional)");
    expect(part("link", "sas-small")).toBe("Where your button or link is, like https://example.com/offer.");
    // The address is second in "The page" block, in the DOM (keyboard) order too; for a button or link it is last
    // there (the demo page is a button or link), and no CSS reorders it.
    const at = (h: string, needle: string) => h.indexOf(needle);
    expect(at(html, 'name="name"')).toBeLessThan(at(html, 'name="address"'));
    expect(at(html, 'name="address"')).toBeLessThan(at(html, 'name="marketId"'));
    const linkEdit = await render(EditPage, { account: a.slug, pageId: demoPage.id });
    expect(linkEdit.match(/name="address"/g)?.length).toBe(1);
    expect(at(linkEdit, 'name="language"')).toBeLessThan(at(linkEdit, 'name="address"'));
    expect(at(linkEdit, 'name="address"')).toBeLessThan(at(linkEdit, 'name="field_company"'));
    const css = fs.readFileSync(path.join(process.cwd(), "app/app/[account]/lead-pages/lead-pages.css"), "utf8");
    expect(css).not.toMatch(/lpg-field--address\s*\{\s*order/);
    // What the buyer fills in: Name and Phone fixed, Company and Email optional; no "Number of sites".
    expect([...html.matchAll(/name="field_([a-z]+)"/g)].map((m) => m[1])).toEqual(["company", "email"]);
    expect(text(html)).not.toMatch(/Number of sites|sites/i);
    expect(text(html)).toContain("We read the name and phone, and the company and email when your form sends them.");
    // The banner: a file input for JPG, PNG or WebP, the empty thumbnail, no chosen file yet.
    expect(html).toContain('data-banner-field=""');
    expect(html).toContain('<input type="file" accept="image/jpeg,image/png,image/webp" name="banner"/>');
    expect(html).toContain('data-banner="none"');
    expect(html).not.toContain("data-banner-chosen");
    expect(text(html)).toContain("Choose image");
  });

  it("save: creates a draft in the caller's account; field errors come back; another account's page is refused", async () => {
    as(a);
    const bad = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, name: "", language: "en", connection: "link", intent: "draft" })));
    expect(bad.state).toMatchObject({ errors: { name: expect.any(String) } });
    // The hosted page is not offered yet: refused on the server even when posted.
    expect((await run(actions.saveLeadPageAction(null, form({ slug: a.slug, name: "X", language: "en", connection: "hosted", address: "acme.com" })))).state).toMatchObject({ errors: { connection: expect.any(String) } });

    const ok = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, name: "Winter offer", language: "en", connection: "link", marketId: "", openingTopic: "0", field_company: "on", field_sites: "on", carryAdDetails: "on", intent: "draft" })));
    expect(ok.url).toMatch(new RegExp(`^/app/${a.slug}/lead-pages/[0-9a-f-]{36}\\?saved=draft&created=1#link$`));
    const id = ok.url!.split("/").pop()!.split("?")[0];
    const made = await getLeadPage(db, a.id, id);
    expect(made).toMatchObject({ name: "Winter offer", status: "draft", accountId: a.id, form: { fields: { company: true, email: false }, consentTicked: false }, tracking: { carryAdDetails: true } });
    // A stale form still posting the removed "Number of sites" box: ignored.
    expect(made!.form.fields).not.toHaveProperty("sites");
    expect(made!.openingTopic?.en).toBeTruthy();
    expect((await audits(a.id, "lead_page.created")).map((x) => x.targetId)).toContain(id);

    // Edit with another account's page id: refused, and the page is unchanged.
    const hijack = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, pageId: otherPage.id, name: "Hijack", language: "en", connection: "link" })));
    expect(hijack.state).toEqual({ errors: { form: "This page no longer exists." } });
    expect((await getLeadPage(db, b.id, otherPage.id))!.name).toBe(otherPage.name);

    // Save and go live (the demo account is live and has its privacy notices).
    const live = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, pageId: id, name: "Winter offer", language: "en", connection: "link", intent: "live" })));
    expect(live.url).toBe(`/app/${a.slug}/lead-pages/${id}?saved=live`);
    expect((await getLeadPage(db, a.id, id))!.status).toBe("live");
  });

  it("banner: upload, a refused file and remove, through the actions", async () => {
    as(a);
    const r = await createLeadPage(db, { userId: seller.id, actingAs: false }, a, { name: "Banner test", connection: "link", language: "en" });
    if (!r.ok) throw new Error("create");
    const id = r.page.id;
    const base = { slug: a.slug, pageId: id, name: "Banner test", language: "en", connection: "link" };
    const up = await run(actions.saveLeadPageAction(null, form({ ...base, intent: "save", banner: new File([png(1600, 400)], "b.png", { type: "image/png" }) })));
    expect(up.url).toBe(`/app/${a.slug}/lead-pages/${id}?saved=saved`);
    const withBanner = (await getLeadPage(db, a.id, id))!;
    expect(withBanner.banner).toMatchObject({ contentType: "image/png", width: 1600, height: 400 });
    expect(holder.files.has(withBanner.banner!.blobPath)).toBe(true);
    // Too large, or not an image: the page is saved, the banner is not, and the edit page says why.
    const big = await run(actions.saveLeadPageAction(null, form({ ...base, banner: new File([png(10, 10, 2 * 1024 * 1024 + 1)], "big.png") })));
    expect(big.url).toBe(`/app/${a.slug}/lead-pages/${id}/edit?banner_error=too_large`);
    const svg = await run(actions.saveLeadPageAction(null, form({ ...base, banner: new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "x.svg", { type: "image/svg+xml" }) })));
    expect(svg.url).toContain("banner_error=not_an_image");
    const edit = await render(EditPage, { account: a.slug, pageId: id }, { banner_error: "too_large" });
    save("edit-banner-error", edit);
    expect(text(edit)).toContain("The page is saved, but not the banner: The image is larger than 2 MB.");
    expect(edit).toContain(`/api/lp/${withBanner.publicKey}/banner/${withBanner.banner!.sha256}`);
    // Remove: the initials tile again, and the stored file goes.
    const rm = await run(actions.saveLeadPageAction(null, form({ ...base, intent: "remove_banner" })));
    expect(rm.url).toBe(`/app/${a.slug}/lead-pages/${id}/edit?saved=banner_removed`);
    expect((await getLeadPage(db, a.id, id))!.banner).toBeNull();
    expect(holder.files.has(withBanner.banner!.blobPath)).toBe(false);
    expect((await audits(a.id, "lead_page.banner_removed")).map((x) => x.targetId)).toContain(id);
  });

  it("go live, pause, resume and the preview link check the account; go live is blocked without a privacy notice or a live account", async () => {
    as(a);
    const op = (o: string, pageId: string, slug = a.slug) => run(actions.setLeadPageStatusAction(form({ slug, pageId, op: o })));
    // Another account's page: back to the list, nothing changes, nothing is audited for it.
    expect((await op("pause", otherPage.id)).url).toBe(`/app/${a.slug}/lead-pages`);
    expect((await getLeadPage(db, b.id, otherPage.id))!.status).toBe(otherPage.status);
    expect((await run(actions.previewLinkAction(form({ slug: a.slug, pageId: otherPage.id })))).url).toBe(`/app/${a.slug}/lead-pages`);
    expect((await audits(b.id, "lead_page.preview_link"))).toHaveLength(0);

    expect((await op("pause", demoPage.id)).url).toBe(`/app/${a.slug}/lead-pages/${demoPage.id}?saved=paused`);
    expect((await getLeadPage(db, a.id, demoPage.id))!.status).toBe("paused");
    const paused = await render(PageView, { account: a.slug, pageId: demoPage.id }, { saved: "paused" });
    expect(text(paused)).toContain("This page is paused.");
    expect(paused).toContain('data-status-op="resume"');
    expect((await op("resume", demoPage.id)).url).toBe(`/app/${a.slug}/lead-pages/${demoPage.id}?saved=live`);
    expect((await getLeadPage(db, a.id, demoPage.id))!.status).toBe("live");
    expect(await audits(a.id, "lead_page.paused")).toHaveLength(1);
    expect(await audits(a.id, "lead_page.resumed")).toHaveLength(1);

    // An account that is not live and has no privacy notice: both block going live.
    as(c);
    const r = await createLeadPage(db, { userId: seller.id, actingAs: false }, c, { name: "UK page", connection: "link", language: "en" });
    if (!r.ok) throw new Error("create");
    const blocked = await op("live", r.page.id, c.slug);
    expect(blocked.url).toBe(`/app/${c.slug}/lead-pages/${r.page.id}?blocked=privacy_notice,account_not_live`);
    expect((await getLeadPage(db, c.id, r.page.id))!.status).toBe("draft");
    const view = await render(PageView, { account: c.slug, pageId: r.page.id }, { blocked: "privacy_notice,account_not_live" });
    save("page-empty", view);
    const s = text(view);
    expect(s).toContain("This page can't go live yet. Missing: Privacy notice in the form's language; Your account is live.");
    expect(s).toContain("No leads from this page yet.");
    expect(s).toContain("No visits or leads in this period.");
    expect(view).toContain('data-status-op="live"');
    expect(view).toMatch(/data-check="privacy_notice"(?![^>]*data-done)/);

    // Preview link: audited, shown on the page for 24 hours.
    const pl = await run(actions.previewLinkAction(form({ slug: c.slug, pageId: r.page.id })));
    expect(pl.url).toMatch(new RegExp(`^/app/${c.slug}/lead-pages/${r.page.id}\\?pl=[^&#]+#link$`));
    expect(await audits(c.id, "lead_page.preview_link")).toHaveLength(1);
    const token = decodeURIComponent(new URL(pl.url!, "http://x").searchParams.get("pl")!);
    const withPreview = await render(PageView, { account: c.slug, pageId: r.page.id }, { pl: token });
    expect(withPreview).toMatch(/data-preview-link="">http[^<]*\/p\/[0-9A-Za-z]{12}\?preview=/);
    // A forged token is not shown.
    expect(await render(PageView, { account: c.slug, pageId: r.page.id }, { pl: "forged" })).not.toContain("data-preview-link");
    as(a);
    // Another account's page id: not found.
    await expect(render(PageView, { account: a.slug, pageId: otherPage.id })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render(EditPage, { account: a.slug, pageId: otherPage.id })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("one page with data: the funnel (no visits for a link), where they came from, the link, checks, setup and latest leads", async () => {
    as(a);
    const html = await render(PageView, { account: a.slug, pageId: demoPage.id });
    save("page", html);
    const s = text(html);
    expect(html).toMatch(/data-step="visits"><span class="lpg-funnel__label">Visits<\/span>.*?>—</);
    expect(s).toMatch(/Left details 2/);
    expect(s).toMatch(/Started talking 2 100%/);
    expect(s).toMatch(/Ordered 1 50%/);
    expect(s).toContain("Where they came from");
    expect(s).toContain("facebook / restaurants-nov");
    expect(s).toContain("Direct or unknown");
    expect(html).toMatch(/data-hosted-link="">http[^<]*\/p\/[0-9A-Za-z]{12}</);
    expect(s).toContain("Copy link");
    expect(s).toContain("Fridge monitoring · restaurants");
    expect(s).toMatch(/Banner Image, \d+ × \d+/);
    // Latest leads: names only (never an email), and the link to Leads filtered by this page.
    expect(s).toContain("Yoni Demo");
    expect(s).toContain("Avi Demo");
    expect(s).not.toMatch(/@[a-z-]+\.example/);
    expect(html).toContain(`/leads?view=all&amp;page=${demoPage.id}`);
    expect(s).toContain("All 2 leads from this page");
    // The 7-day period: both leads came in within the week; fewer form opens than in 30 days.
    const week = await render(PageView, { account: a.slug, pageId: demoPage.id }, { days: "7" });
    expect(week).toMatch(/aria-current="true">Last 7 days</);
    expect(text(week)).toMatch(/Left details 2 /);
    const opened = (h: string) => Number(/Opened the form (\d+)/.exec(text(h))![1]);
    expect(opened(week)).toBeLessThan(opened(html));
  });

  it("numbers leave out preview submissions and test leads; the list's totals count a lead once", async () => {
    const before = await pageFunnel(db, a.id, demoPage.id, rangeOfDays(30));
    const yoni = await leadByName(a.id, "Yoni Demo");
    const lior = await leadByName(a.id, "Lior Demo");
    const [testLead] = await db.insert(leads).values({ accountId: a.id, fullName: "Test Buyer", phone: "+972500000999", language: "en", origin: "manual", isTest: true }).returning();
    const at = new Date(Date.now() - 60_000);
    const r = await createLeadPage(db, { userId: seller.id, actingAs: false }, a, { name: "Second", connection: "link", language: "en" });
    if (!r.ok) throw new Error("create");
    try {
      await db.insert(leadPageSubmissions).values([
        { id: crypto.randomUUID(), accountId: a.id, pageId: demoPage.id, leadId: lior.id, via: "link", leadCreated: false, consent: true, preview: true, language: "en", sourceKey: "", createdAt: at },
        { id: crypto.randomUUID(), accountId: a.id, pageId: demoPage.id, leadId: testLead.id, via: "link", leadCreated: true, consent: true, preview: false, language: "en", sourceKey: "", createdAt: at },
      ]);
      const after = await pageFunnel(db, a.id, demoPage.id, rangeOfDays(30));
      expect(after.leftDetails).toBe(before.leftDetails);
      // A second page with one of the same leads: each page counts it, the totals once.
      await db.insert(leadPageSubmissions).values({ id: crypto.randomUUID(), accountId: a.id, pageId: r.page.id, leadId: yoni.id, via: "link", leadCreated: false, consent: true, language: "en", sourceKey: "", createdAt: at });
      const totals = await listTotals(db, a.id, rangeOfDays(30), { pageIds: [demoPage.id, r.page.id] });
      expect(totals.perPage.get(r.page.id)?.leftDetails).toBe(1);
      expect(totals.perPage.get(demoPage.id)?.leftDetails).toBe(2);
      expect(totals.totals.leftDetails).toBe(2);
      // Latest leads mark the test (preview) submission; the count matches the Leads filter (test leads left out).
      const latest = await latestLeadsOfPage(db, a.id, demoPage.id, 10);
      expect(latest.rows.find((x) => x.leadId === lior.id)?.preview).toBe(true);
      expect(latest.total).toBe(3);
      // Another account sees none of it.
      expect((await latestLeadsOfPage(db, b.id, demoPage.id)).rows).toHaveLength(0);
      expect((await pageFunnel(db, b.id, demoPage.id, rangeOfDays(30))).leftDetails).toBe(0);
    } finally {
      await db.delete(leadPageSubmissions).where(and(eq(leadPageSubmissions.accountId, a.id), eq(leadPageSubmissions.leadId, lior.id)));
      await db.delete(leads).where(eq(leads.id, testLead.id));
      await db.delete(leadPages).where(eq(leadPages.id, r.page.id));
    }
  });

  it("Leads: ?page=<id> shows only that page's leads with a removable chip; another account's page is ignored", async () => {
    as(a);
    const only = await listLeads(db, a.id, { leadPageId: demoPage.id });
    expect(only.rows.map((r) => r.lead.fullName).sort()).toEqual(["Avi Demo", "Yoni Demo"]);
    expect((await listLeads(db, a.id, { leadPageId: otherPage.id })).total).toBe(0);
    expect((await listLeads(db, a.id, { leadPageId: "not-a-uuid" })).total).toBe(0);
    const html = await render(LeadsPage, { account: a.slug }, { view: "all", page: demoPage.id });
    save("leads-chip", html);
    const s = text(html);
    expect(s).toContain(`Page: ${DEMO_LEAD_PAGE.name}`);
    expect(html).toContain(`data-page-filter="${demoPage.id}"`);
    expect(html).toMatch(/class="lpg-chip__x" href="\/app\/[^"?]+\/leads\?view=all"/);
    expect(s).toContain("Yoni Demo");
    expect(s).not.toContain("Lior Demo");
    // Another account's page id: no chip, no filter.
    const foreign = await render(LeadsPage, { account: a.slug }, { view: "all", page: otherPage.id });
    expect(foreign).not.toContain("data-page-filter");
    expect(text(foreign)).toContain("Lior Demo");
  });

  it("the lead card says Lead page · {name} (a link to the page) with its source; the conversation header says via {name}", async () => {
    as(a);
    const avi = await leadByName(a.id, "Avi Demo");
    expect(await leadPageSourceOf(db, a.id, avi)).toMatchObject({ pageId: demoPage.id, name: DEMO_LEAD_PAGE.name, sourceKey: "facebook / restaurants-nov" });
    expect(await leadPageSourceOf(db, b.id, avi)).toBeNull();
    const card = await render(LeadCardPage, { account: a.slug, leadId: avi.id });
    save("lead-card", card);
    expect(card).toContain(`data-lead-page-source="${demoPage.id}"`);
    expect(card).toMatch(new RegExp(`<a href="/app/${a.slug}/lead-pages/${demoPage.id}">[^<]*Lead page · ${DEMO_LEAD_PAGE.name}`));
    expect(text(card)).toContain("facebook / restaurants-nov");
    expect(text(card)).not.toMatch(/\d sites?\b/);
    const [conv] = await db.select().from(conversations).where(and(eq(conversations.accountId, a.id), eq(conversations.leadId, avi.id)));
    const inbox = await render(ConversationsPage, { account: a.slug }, { c: conv.id });
    expect(inbox).toContain(`data-via-page="${demoPage.id}"`);
    expect(text(inbox)).toContain(`via ${DEMO_LEAD_PAGE.name}`);
    // A lead from no page: the old line.
    const lior = await leadByName(a.id, "Lior Demo");
    expect(await render(LeadCardPage, { account: a.slug, leadId: lior.id })).not.toContain("data-lead-page-source");
  });

  it("slice b: a snippet page is saved with its pixel switch and other addresses; Save and preview; the page view's snippet card, checks and the \"Seen on\" suggestion; an empty funnel is one line", async () => {
    as(a);
    const saved = await run(actions.saveLeadPageAction(null, form({
      slug: a.slug, name: "Spring snippet", language: "en", connection: "snippet", address: "polar-demo.example/spring", marketId: "",
      originsShown: "1", newOrigin: "staging.polar-demo.example", tellPagePixel: "on", carryAdDetails: "on", intent: "draft",
    })));
    const id = saved.url!.split("/").pop()!.split("?")[0];
    let page = (await getLeadPage(db, a.id, id))!;
    expect(page).toMatchObject({ connection: "snippet", address: "https://polar-demo.example/spring", extraOrigins: ["staging.polar-demo.example"], tracking: { tellPagePixel: true, carryAdDetails: true } });
    // The snippet needs its page's address.
    expect((await run(actions.saveLeadPageAction(null, form({ slug: a.slug, name: "X", language: "en", connection: "snippet", address: "" })))).state).toMatchObject({ errors: { address: expect.any(String) } });

    // Edit: the live preview of the snippet's form; the snippet with Copy and the other addresses are on the page's view.
    const edit = await render(EditPage, { account: a.slug, pageId: id });
    save("snippet-edit", edit);
    expect(edit).toContain('data-preview-connection="snippet"');
    expect(text(edit)).toContain("On your page it takes your page's font.");
    expect(edit).not.toContain(`data-sas-lead-form=&quot;${page.publicKey}&quot;`);
    expect(edit).not.toContain('name="extraOrigin"');
    // Saving from Edit keeps the other addresses (the form no longer shows them).
    await run(actions.saveLeadPageAction(null, form({ slug: a.slug, pageId: id, name: "Spring snippet", language: "en", connection: "snippet", address: "polar-demo.example/spring", marketId: "", tellPagePixel: "on", carryAdDetails: "on", intent: "save" })));
    expect((await getLeadPage(db, a.id, id))!.extraOrigins).toEqual(["staging.polar-demo.example"]);
    // A post with the addresses shown (an older form): unticking removes the address, the switch off turns the pixel off; Save and preview gives a preview link on the page.
    const prev = await run(actions.saveLeadPageAction(null, form({
      slug: a.slug, pageId: id, name: "Spring snippet", language: "en", connection: "snippet", address: "polar-demo.example/spring", marketId: "", originsShown: "1", intent: "preview",
    })));
    expect(prev.url).toMatch(new RegExp(`^/app/${a.slug}/lead-pages/${id}\\?pl=[0-9a-z]+\\.[A-Za-z0-9_-]{22}#link$`));
    page = (await getLeadPage(db, a.id, id))!;
    expect(page).toMatchObject({ extraOrigins: [], tracking: { tellPagePixel: false } });
    const pl = decodeURIComponent(prev.url!.split("pl=")[1].split("#")[0]);

    // The page view: the snippet card, the preview link to the seller's own page, no leads yet in one line.
    await db.update(leadPages).set({ checks: { refusedOrigin: "https://polar-demo.webflow.io", refusedAt: new Date().toISOString() } }).where(eq(leadPages.id, id));
    let view = await render(PageView, { account: a.slug, pageId: id }, { pl });
    save("snippet-view", view);
    expect(view).toContain("data-snippet-card");
    expect(view).not.toContain("data-hosted-link");
    expect(view).toContain(`https://polar-demo.example/spring#sas-preview=${pl}`);
    expect(view).toContain("data-funnel-empty");
    expect(text(view)).toContain("No leads in this period yet.");
    expect(view).toContain('data-seen-origin="polar-demo.webflow.io"');
    expect(text(view)).toContain("Seen on polar-demo.webflow.io. Add it?");
    // Slice c: beside a suggestion, no "No other addresses." line.
    expect(text(view)).not.toContain("No other addresses.");
    expect(view).toContain('data-check="snippet_seen"');
    expect(view).not.toContain('data-check="form_opens"');
    // "Add it?" adds the address (audited); Remove takes it away.
    expect((await run(actions.addOriginAction(form({ slug: a.slug, pageId: id, host: "polar-demo.webflow.io" })))).url).toContain("saved=origin_added");
    expect((await getLeadPage(db, a.id, id))!.extraOrigins).toEqual(["polar-demo.webflow.io"]);
    expect((await run(actions.addOriginAction(form({ slug: a.slug, pageId: id, host: "not a host" })))).url).toContain("origin_error=1");
    expect((await audits(a.id, "lead_page.origins_changed")).length).toBeGreaterThanOrEqual(2);
    view = await render(PageView, { account: a.slug, pageId: id }, {});
    expect(view).not.toContain("data-seen-origin");
    expect(view).toContain('data-origin="polar-demo.webflow.io"');
    // Another account cannot add to this page.
    as(b);
    expect((await run(actions.addOriginAction(form({ slug: b.slug, pageId: id, host: "evil.example" })))).url).toBe(`/app/${b.slug}/lead-pages`);
    as(a);
    expect((await run(actions.removeOriginAction(form({ slug: a.slug, pageId: id, host: "polar-demo.webflow.io" })))).url).toContain("saved=origin_removed");
    expect((await getLeadPage(db, a.id, id))!.extraOrigins).toEqual([]);
    // Seen on the page: the check ticks and names the host.
    await db.update(leadPages).set({ checks: { snippetSeenAt: new Date().toISOString(), snippetOrigin: "https://polar-demo.example" } }).where(eq(leadPages.id, id));
    view = await render(PageView, { account: a.slug, pageId: id }, {});
    expect(view).toMatch(/data-check="snippet_seen" data-done=""/);
    expect(text(view)).toContain("Seen on polar-demo.example");
    // The demo page (a button or link with data) keeps its bars.
    expect(await render(PageView, { account: a.slug, pageId: demoPage.id }, {})).not.toContain("data-funnel-empty");
    // Without a suggestion and without addresses: the "No other addresses." line.
    view = await render(PageView, { account: a.slug, pageId: id }, {});
    expect(view).toContain("data-origins-none");
  });

  it("slice c: where they came from has Orders; the demo page's signed order counts on its source", async () => {
    as(a);
    const html = await render(PageView, { account: a.slug, pageId: demoPage.id });
    expect(html).toMatch(/<th scope="col" class="lpg-num">Orders<\/th>/);
    const orders = [...html.matchAll(/data-cell="orders">(\d+)</g)].map((m) => Number(m[1]));
    expect(orders.reduce((x, y) => x + y, 0)).toBe(1);
    expect(html).toMatch(/<th scope="col" class="lpg-num">Opened<\/th>/);
  });

  it("slice c: your own form: the add form's parts, Save and test, the page view's address, field names, consent note, example, test code, check and dashes", async () => {
    as(a);
    const add = await render(NewPage, { account: a.slug });
    const s = text(add);
    expect(add).not.toContain('data-own-form-card=""');
    expect(add).toContain('data-for="own_form" data-preview-after="own_form"');
    expect(s).toContain("Address of the page with your form");
    expect(s).toContain("You get your form's address when you save.");
    expect(s).toContain("Your form decides what the buyer fills in.");
    expect(s).toContain("you are responsible for it");
    expect(s).toContain("We don't tell your ad pixel about leads from your own form.");

    // The own form's address is optional (recommended): saved without one, its page view says what to do.
    const bare = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, name: "Own", language: "en", connection: "own_form", address: "", intent: "draft" })));
    expect(bare.state).toBeUndefined();
    const bareId = bare.url!.split("/").pop()!.split("?")[0];
    expect(await getLeadPage(db, a.id, bareId)).toMatchObject({ connection: "own_form", address: null });
    const bareView = await render(PageView, { account: a.slug, pageId: bareId });
    expect(bareView).toContain('data-own-no-address=""');
    expect(text(bareView)).toContain("Add your page's address so sends from it are accepted.");
    // The snippet still needs it: it is the address our form runs on.
    expect((await run(actions.saveLeadPageAction(null, form({ slug: a.slug, name: "Snip", language: "en", connection: "snippet", address: "" })))).state)
      .toMatchObject({ errors: { address: "Enter the address of the page the form is on." }, connection: "snippet", bannerSent: false });
    const saved = await run(actions.saveLeadPageAction(null, form({
      slug: a.slug, name: "Contact form", language: "en", connection: "own_form", address: "polar-demo.example/contact", marketId: "", carryAdDetails: "on", intent: "draft",
    })));
    const id = saved.url!.split("/").pop()!.split("?")[0];
    const page = (await getLeadPage(db, a.id, id))!;
    expect(page).toMatchObject({ connection: "own_form", address: "https://polar-demo.example/contact", status: "draft" });
    const action = `http://localhost:3000/api/lp/${page.publicKey}/submit`;

    const edit = await render(EditPage, { account: a.slug, pageId: id });
    save("own-edit", edit);
    expect(edit).toContain('<input type="radio" name="connection" checked="" value="own_form"/>');
    // The address it sends to, Save and test and the other addresses are on the page's view, not on Edit.
    expect(edit).not.toContain(`data-own-form-action="">${action}<`);
    expect(edit).not.toContain('name="newOrigin"');
    expect(edit).toContain('data-preview-connection="own_form"');
    // Save and test (a post from an older form): saved, then the page view with a 24-hour test code.
    const prev = await run(actions.saveLeadPageAction(null, form({
      slug: a.slug, pageId: id, name: "Contact form", language: "en", connection: "own_form", address: "polar-demo.example/contact", marketId: "", originsShown: "1", intent: "preview",
    })));
    expect(prev.url).toMatch(new RegExp(`^/app/${a.slug}/lead-pages/${id}\\?pl=[0-9a-z]+\\.[A-Za-z0-9_-]{22}#link$`));
    const pl = decodeURIComponent(prev.url!.split("pl=")[1].split("#")[0]);

    // Some leads from the form: the funnel shows dashes for visits and opens; the check ticks.
    const demoSubs = await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.pageId, demoPage.id));
    await db.insert(leadPageSubmissions).values(demoSubs.map((x, i) => ({
      id: crypto.randomUUID(), accountId: a.id, pageId: id, leadId: x.leadId, via: "own_form", leadCreated: false, consent: true, language: "en",
      answers: { firstName: "Demo" }, sourceKey: i ? "google / contact" : "", createdAt: new Date(),
    })));
    await db.update(leadPages).set({ checks: { refusedOrigin: "https://polar-demo.webflow.io", refusedAt: new Date().toISOString() } }).where(eq(leadPages.id, id));
    const view = await render(PageView, { account: a.slug, pageId: id }, { pl });
    save("own-view", view);
    const v = text(view);
    expect(view).toContain('data-own-form-card=""');
    expect(view).not.toContain("data-snippet-card");
    expect(view).not.toContain("data-hosted-link");
    expect(view).toContain(`data-own-form-action="">${action}<`);
    expect(v).toContain("Copy address");
    for (const f of ["name", "phone", "company", "email", "consent"]) expect(view).toContain(`data-field="${f}"`);
    expect(view).not.toContain('data-field="sites"');
    expect(view).not.toContain("data-own-no-address");
    expect(v).toContain("or full_name");
    expect(v).toContain("or tel, mobile");
    expect(v).toContain("or business");
    expect(v).toContain("Consent: true, on, yes or 1 when ticked");
    // The seller is responsible for the consent text; our recommended line to copy (with the names filled in).
    expect(v).toContain("You are responsible for the consent text on your own form.");
    expect(view).toMatch(/data-recommended-line="">By sending, you agree that [^<]+ and its automated assistant [^<]+ may contact you/);
    expect(v).toContain("Copy line");
    // The ready example posts to the address, with the test code.
    expect(view).toContain(`&lt;form method=&quot;post&quot; action=&quot;${action}&quot;&gt;`);
    expect(view).toContain(`name=&quot;preview&quot; value=&quot;${pl}&quot;`);
    expect(view).toContain("data-preview-field");
    expect(v).toContain("Copy example");
    expect(v).toContain("?sas_error=");
    // "If a send is refused": one row per code the endpoint can return (one list), each with the
    // approved buyer sentence in the page's form language.
    expect(v).toContain("If a send is refused");
    expect(v).toContain("Show your own message for each code.");
    expect([...view.matchAll(/data-error-code="([a-z]+)"/g)].map((m) => m[1])).toEqual([...OWN_FORM_ERRORS]);
    for (const code of OWN_FORM_ERRORS) {
      expect(view).toMatch(new RegExp(`data-error-code="${code}"><td><code dir="ltr">${code}</code></td><td>[^<]+</td><td lang="en" dir="ltr">${msg(OWN_FORM_ERROR_TEXT[code]).replace(/[.?]/g, "\\$&")}</td>`));
    }
    expect(v).toContain("A lead sent without consent is not refused: it is saved, and the buyer sees that you received their details.");
    // Checks: the own-form check, done.
    expect(view).toMatch(/data-check="own_form_lead" data-done=""/);
    expect(v).toContain("A lead arrived from your form");
    expect(view).not.toContain('data-check="form_opens"');
    // Funnel: visits and opens are dashes; the sources table has no visits or opened column, and has Orders.
    expect(view).toMatch(/data-step="visits"><span class="lpg-funnel__label">Visits<\/span>.*?>—</);
    expect(view).toMatch(/data-step="opens"><span class="lpg-funnel__label">Opened the form<\/span>.*?>—</);
    expect(v).toContain("Visits and opens are not counted: the form is your own.");
    expect(view).toContain('data-source-row="google / contact"');
    expect(view).not.toMatch(/<th scope="col" class="lpg-num">(Visits|Opened)<\/th>/);
    expect(view).toMatch(/<th scope="col" class="lpg-num">Orders<\/th>/);
    // Other addresses with the suggestion, and no "No other addresses." beside it.
    expect(v).toContain("Seen on polar-demo.webflow.io. Add it?");
    expect(view).not.toContain("data-origins-none");
    expect(v).toContain("Your own form's fields");
    // Without a test code: the button to get one.
    expect(text(await render(PageView, { account: a.slug, pageId: id }))).toContain("Get a test code");
    // Another account cannot see it.
    as(b);
    await expect(render(PageView, { account: b.slug, pageId: id })).rejects.toThrow("NEXT_NOT_FOUND");
    as(a);
    await db.delete(leadPages).where(eq(leadPages.id, id));
  });
});

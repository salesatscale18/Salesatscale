/**
 * Lead pages, "I tried to save a lead draft and it didn't work" (owner, 25 Nov), on PGlite:
 * - the add form marks its required fields, says "Close preview" on the preview sheet and has the
 *   Save line's place next to the buttons;
 * - the first save of a new page lands on its link / snippet / form address, marked once
 *   (`?created=1`), with its Copy as the primary button and a line per connection;
 * - every refusal on the page view shows next to its control: an address that can't be added
 *   (invalid, too many, the page's own settings), one that can't be removed; Go live blocked names
 *   the blocker with the way to fix it.
 * The browser side (focus, scroll, the pending state) runs in tests/e2e/lead-page-save.spec.ts.
 * No model call, no network. With LP_RENDER_DIR set, the page views are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { leadPages, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
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
const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { getLeadPage } = await import("@/lib/lead-pages/service");
const actions = await import("@/app/app/[account]/lead-pages/actions");
const { default: NewPage } = await import("@/app/app/[account]/lead-pages/new/page");
const { default: PageView } = await import("@/app/app/[account]/lead-pages/[pageId]/page");
const { default: EditPage } = await import("@/app/app/[account]/lead-pages/[pageId]/edit/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.append(k, val);
  return f;
};
const run = async (p: Promise<unknown>): Promise<{ url?: string; state?: unknown }> => {
  try {
    return { state: await p };
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return { url };
    throw e;
  }
};
const css = ["components/sas/sas.css", "app/app/[account]/lead-pages/lead-pages.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
const keep = (name: string, html: string) => {
  const dir = process.env.LP_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
/** The page's link / snippet / form address block. */
const card = (html: string) => html.match(/<section class="sas-panel lpg-card" id="link"[\s\S]*?<\/section>/)?.[0] ?? "";

describe("lead pages: a save never looks silent", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let seller: User;
  let a: SellerAccount, c: SellerAccount;
  const as = (account: SellerAccount) => { holder.access = { account, user: seller, actingAs: false, role: "seller_admin" }; };
  const create = async (v: Record<string, string>) => {
    const r = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, language: "en", marketId: "", ...v })));
    if (!r.url) throw new Error(`not saved: ${JSON.stringify(r.state)}`);
    return { url: r.url, id: r.url.split("/").pop()!.split("?")[0] };
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    let admin: User;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u", email: "u@seller.test", role: "user", firstName: "Sam" },
    ]).returning();
    const ra = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!ra.ok) throw new Error("demo seed refused");
    [a] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, ra.summary.accountId));
    const p = parseCreateAccount({ tradeName: "Empty Co", market: "GB", languages: ["en"], timezone: "Europe/London", currency: "GBP", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@empty.test" });
    if (!p.ok) throw new Error("account input");
    c = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
    as(a);
  }, 180_000);
  afterAll(async () => { await t.close(); });

  it("the add form: Name is marked required; the address only for Our form on your page; Close preview; the Save buttons in their foot", async () => {
    const html = await render(NewPage, { account: a.slug });
    expect(html).toContain('<span class="lpg-field__label">Name <span class="lpg-req">(required)</span></span>');
    expect(html).toContain('data-for="snippet">Address of your page <span class="lpg-req">(required)</span>');
    expect(html).toContain('data-for="own_form">Address of the page with your form (recommended)</span>');
    expect(html).toContain('data-for="link">Address of the page with the button (optional)</span>');
    // A new page starts on Our form on your page: the address input is required to assistive tech too.
    expect(html).toMatch(/<input [^>]*aria-required="true"[^>]*name="address"/);
    expect(html).toContain(">Close preview</button>");
    expect(html).toMatch(/data-save-foot=""[\s\S]*value="draft"[^>]*>Save draft<[\s\S]*value="live"/);
    expect(html).not.toContain("data-save-error");
    expect(html).toContain('aria-live="assertive" data-save-announce=""');
    // Edit of a Button or link page: the address is optional there.
    const r = await create({ name: "Optional address", connection: "link", intent: "draft" });
    const edit = await render(EditPage, { account: a.slug, pageId: r.id });
    expect(edit).toMatch(/<input [^>]*name="address"/);
    expect(edit).not.toMatch(/<input [^>]*aria-required[^>]*name="address"/);
  });

  it("the server refuses what the browser checks first, with the same messages", async () => {
    const bad = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, name: "Only a name", language: "en", connection: "snippet", intent: "draft" })));
    expect(bad.state).toMatchObject({ errors: { address: "Enter the address of the page the form is on." }, connection: "snippet" });
    const { quickPageErrors } = await import("@/lib/lead-pages/page-check");
    expect(quickPageErrors({ name: "Only a name", connection: "snippet", address: "" })).toEqual({ address: "Enter the address of the page the form is on." });
  });

  it("the first save of a new page: its block marked once, Copy first, and a line per connection", async () => {
    // Our form on your page.
    const s = await create({ name: "Snippet page", connection: "snippet", address: "example.com/offer", intent: "draft" });
    expect(s.url).toBe(`/app/${a.slug}/lead-pages/${s.id}?saved=draft&created=1#link`);
    let html = await render(PageView, { account: a.slug, pageId: s.id }, { saved: "draft", created: "1" });
    keep("created-snippet", html);
    let box = card(html);
    expect(box).toContain('data-snippet-card="" data-created=""');
    expect(text(box)).toContain("Saved as a draft. Here is your snippet.");
    expect(box).toMatch(/<button type="button" class="sas-btn sas-btn--primary sas-btn--sm"[^>]*>.*Copy snippet<\/button>/);
    // Not twice: the top "Saved as a draft." is the line in the block.
    expect(html).not.toContain('data-saved=""');
    // Later visits (no created=1): no mark, Copy back to secondary, the usual notice.
    html = await render(PageView, { account: a.slug, pageId: s.id }, { saved: "saved" });
    expect(card(html)).not.toContain("data-created");
    expect(card(html)).not.toContain("sas-btn--primary");
    expect(html).toContain('data-saved=""');

    // Your own form.
    const o = await create({ name: "Own form page", connection: "own_form", intent: "draft" });
    html = await render(PageView, { account: a.slug, pageId: o.id }, { saved: "draft", created: "1" });
    keep("created-own-form", html);
    box = card(html);
    expect(box).toContain('data-own-form-card="" data-created=""');
    expect(text(box)).toContain("Saved as a draft. Here is your form's address.");
    expect(box).toMatch(/class="sas-btn sas-btn--primary sas-btn--sm"[^>]*>.*Copy address<\/button>/);

    // Button or link, a draft: the link works for buyers once live, the preview link now.
    const l = await create({ name: "Link page", connection: "link", intent: "draft" });
    html = await render(PageView, { account: a.slug, pageId: l.id }, { saved: "draft", created: "1" });
    keep("created-link-draft", html);
    box = card(html);
    expect(box).toContain('data-link="" data-created=""');
    expect(text(box)).toContain("Saved as a draft. The link works for buyers after you press Go live. Use the preview link to try it now.");
    expect(box).toMatch(/class="sas-btn sas-btn--primary sas-btn--sm"[^>]*>.*Copy link<\/button>/);
    expect(box).toContain("Get a preview link");

    // Button or link, saved and live at once (the demo account can go live).
    const live = await create({ name: "Live link", connection: "link", intent: "live" });
    expect(live.url).toBe(`/app/${a.slug}/lead-pages/${live.id}?saved=live&created=1#link`);
    expect((await getLeadPage(db, a.id, live.id))!.status).toBe("live");
    html = await render(PageView, { account: a.slug, pageId: live.id }, { saved: "live", created: "1" });
    expect(text(card(html))).toContain("The page is live. Here is your link.");

    // Edits of a saved page are not "created".
    const again = await run(actions.saveLeadPageAction(null, form({ slug: a.slug, pageId: l.id, name: "Link page", language: "en", connection: "link", intent: "draft" })));
    expect(again.url).toBe(`/app/${a.slug}/lead-pages/${l.id}?saved=saved`);
  });

  it("a new page that can't go live: saved as a draft, the blocker named with the way to fix it", async () => {
    as(c);
    const r = await run(actions.saveLeadPageAction(null, form({ slug: c.slug, name: "UK page", language: "en", connection: "link", marketId: "", intent: "live" })));
    expect(r.url).toMatch(new RegExp(`^/app/${c.slug}/lead-pages/[0-9a-f-]{36}\\?blocked=privacy_notice,account_not_live&created=1$`));
    const id = r.url!.split("/").pop()!.split("?")[0];
    const html = await render(PageView, { account: c.slug, pageId: id }, { blocked: "privacy_notice,account_not_live", created: "1" });
    keep("created-blocked", html);
    const alert = html.match(/<div class="sas-alert sas-alert--danger" role="alert" data-blocked="[^"]*">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(text(alert)).toContain("This page can't go live yet. Missing: Privacy notice in the form's language; Your account is live.");
    expect(alert).toContain(`href="/app/${c.slug}/setup/order-form"`);
    expect(alert).toContain(`href="/app/${c.slug}/setup/go-live"`);
    expect(text(card(html))).toContain("Saved as a draft.");
    as(a);
  });

  it("other addresses: each refusal shows next to the Add field; a remove that fails does not say Address removed.", async () => {
    const s = await create({ name: "Origins page", connection: "snippet", address: "example.com/offer", intent: "draft" });
    const add = (host: string) => run(actions.addOriginAction(form({ slug: a.slug, pageId: s.id, host })));
    expect((await add("not a host")).url).toBe(`/app/${a.slug}/lead-pages/${s.id}?origin_error=1#link`);
    expect((await add("")).url).toBe(`/app/${a.slug}/lead-pages/${s.id}?origin_error=1#link`);
    let html = await render(PageView, { account: a.slug, pageId: s.id }, { origin_error: "1" });
    const origins = (h: string) => h.match(/<div class="lpg-preview" data-origins="">[\s\S]*?<\/div>\s*<\/section>/)?.[0] ?? "";
    expect(origins(html)).toContain('data-origin-error="1"');
    expect(text(origins(html))).toContain("That address could not be added. Enter a web address, like staging.example.com.");

    // Ten already: the eleventh is refused with the reason.
    await db.update(leadPages).set({ extraOrigins: Array.from({ length: 10 }, (_, i) => `s${i}.example.com`) }).where(eq(leadPages.id, s.id));
    expect((await add("eleven.example.com")).url).toBe(`/app/${a.slug}/lead-pages/${s.id}?origin_error=max#link`);
    html = await render(PageView, { account: a.slug, pageId: s.id }, { origin_error: "max" });
    keep("origin-error-max", html);
    expect(text(origins(html))).toContain("You can add up to 10 other addresses. Remove one first.");

    // The page's own settings no longer pass (an old page without its address): add and remove both say so.
    await db.update(leadPages).set({ address: null, extraOrigins: ["s0.example.com"] }).where(eq(leadPages.id, s.id));
    expect((await add("new.example.com")).url).toBe(`/app/${a.slug}/lead-pages/${s.id}?origin_error=page#link`);
    expect((await run(actions.removeOriginAction(form({ slug: a.slug, pageId: s.id, host: "s0.example.com" })))).url).toBe(`/app/${a.slug}/lead-pages/${s.id}?origin_error=page#link`);
    expect((await getLeadPage(db, a.id, s.id))!.extraOrigins).toEqual(["s0.example.com"]);
    html = await render(PageView, { account: a.slug, pageId: s.id }, { origin_error: "page" });
    expect(text(origins(html))).toContain("The addresses could not be changed. Open Edit, check the page and save it, then try again.");

    // Done: the notice is next to the list too (the redirect lands there), not only at the top.
    await db.update(leadPages).set({ address: "https://example.com/offer" }).where(eq(leadPages.id, s.id));
    expect((await run(actions.removeOriginAction(form({ slug: a.slug, pageId: s.id, host: "s0.example.com" })))).url).toBe(`/app/${a.slug}/lead-pages/${s.id}?saved=origin_removed#link`);
    html = await render(PageView, { account: a.slug, pageId: s.id }, { saved: "origin_removed" });
    expect(origins(html)).toContain('data-origin-saved=""');
    expect(text(origins(html))).toContain("Address removed.");
  });

  it("the page view's buttons show a pending state while their form is sent", async () => {
    const s = await create({ name: "Buttons page", connection: "link", intent: "draft" });
    const html = await render(PageView, { account: a.slug, pageId: s.id });
    // Go live, Get a preview link: real submit buttons (useFormStatus disables them while sending).
    expect(html).toMatch(/data-status-op="live"[\s\S]*?<button type="submit" class="sas-btn sas-btn--primary sas-btn--sm">/);
    expect(html).toMatch(/<button type="submit" class="sas-btn sas-btn--secondary sas-btn--sm">.*Get a preview link<\/button>/);
  });

  it("a banner that was not kept: said at the banner field too, not only at the top", async () => {
    const s = await create({ name: "Banner page", connection: "link", intent: "draft" });
    const html = await render(EditPage, { account: a.slug, pageId: s.id }, { banner_error: "too_large" });
    const field = html.match(/<div class="lpg-banner" data-banner-field="">[\s\S]*?<\/div><\/div>/)?.[0] ?? "";
    expect(field).toContain("data-banner-saved-error");
    expect(text(field)).toContain("The page is saved, but not the banner: The image is larger than 2 MB.");
  });
});

/**
 * A way out for lead pages on PGlite: Delete (a page with no real submissions; its test
 * submissions go with it, the test leads stay), Archive (a page with real submissions:
 * hidden from the list, numbers and lead source kept, closed to sends on all three
 * connection types, no snippet config, no preview), Unarchive (back as paused), all
 * audited, account-scoped and re-checked on the server when they run; the banner file is
 * removed on delete. Render tests of the ⋯ menu, the confirm step and "Show archived".
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
  auditLog, leadPageDaily, leadPages, leadPageSubmissions, leads, legalSections, sellerAccounts, users, type LeadPage, type SellerAccount, type User,
} from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, files: new Map<string, Uint8Array>(), deleted: [] as string[] }));
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
    async del(p: string) { holder.deleted.push(p); holder.files.delete(p); },
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
vi.mock("@/lib/voice/chat-viewer", () => ({ chatViewerIsStaff: async () => false }));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, publishDraftVersion } = await import("@/lib/agent/service");
const svc = await import("@/lib/lead-pages/service");
const { listTotals, pageFunnel, rangeOfDays } = await import("@/lib/lead-pages/stats");
const { submitLeadPage } = await import("@/lib/lead-pages/intake");
const { formTimingToken, previewTokenFor } = await import("@/lib/lead-pages/tokens");
const { isArchived } = await import("@/lib/lead-pages/archive");
const { t: msg } = await import("@/lib/i18n");
const actions = await import("@/app/app/[account]/lead-pages/actions");
const configRoute = await import("@/app/api/lp/[key]/config/route");
const submitRoute = await import("@/app/api/lp/[key]/submit/route");
const { default: ListPage } = await import("@/app/app/[account]/lead-pages/page");
const { default: PageView } = await import("@/app/app/[account]/lead-pages/[pageId]/page");
const { default: HostedForm } = await import("@/app/p/[key]/page");

const APP = "http://localhost:3000";
const SITE = "https://acme.com";

const css = ["components/sas/sas.css", "app/app/[account]/lead-pages/lead-pages.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
const save = (name: string, html: string) => {
  const dir = process.env.LP_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
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
function png(w: number, h: number) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
let ipN = 0;
const ip = () => `10.42.0.${++ipN}`;
let phoneN = 0;
const phone = () => `+97254730${String(++phoneN).padStart(4, "0")}`;
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });

describe("lead pages: delete, archive, unarchive", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let seller: User;
  let a: SellerAccount, b: SellerAccount;
  const actor = () => ({ userId: seller.id, actingAs: false });
  const as = (account: SellerAccount) => { holder.access = { account, user: seller, actingAs: false, role: "seller_admin" }; };
  const fresh = async (p: LeadPage) => (await db.select().from(leadPages).where(eq(leadPages.id, p.id)))[0];
  const audits = async (accountId: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action)));
  const make = async (account: SellerAccount, raw: Parameters<typeof svc.createLeadPage>[3], live = true) => {
    const r = await svc.createLeadPage(db, actor(), account, raw);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    if (!live) return r.page;
    const g = await svc.goLiveLeadPage(db, actor(), account.id, r.page.id);
    if (!g.ok) throw new Error(JSON.stringify(g));
    return g.page;
  };
  /** A real (non-preview) submission through the public submit, from our hosted form. */
  const realSend = async (p: LeadPage, name = "Real Buyer") => {
    const r = await submitLeadPage(db, {
      key: p.publicKey, headers: new Headers({ origin: APP }), ip: ip(), env: { APP_URL: APP },
      body: { ft: formTimingToken(p.id, Date.now() - 5000), consent: "on", name, phone: phone() },
    });
    if (r.kind !== "handover" && r.kind !== "thanks") throw new Error(JSON.stringify(r));
    return r;
  };
  const testSend = async (p: LeadPage, name = "Seller Test") => {
    const r = await submitLeadPage(db, {
      key: p.publicKey, headers: new Headers({ origin: APP }), ip: ip(), env: { APP_URL: APP },
      body: { ft: formTimingToken(p.id, Date.now() - 5000), consent: "on", name, phone: phone(), preview: previewTokenFor(p.id, new Date()) },
    });
    if (r.kind !== "handover" && r.kind !== "thanks") throw new Error(JSON.stringify(r));
    return r;
  };
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
    return (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [seller] = await db.insert(users).values({ clerkId: "c_way", email: "u@way.test", role: "super_admin", firstName: "Sam" }).returning();
    a = await makeAccount("Polar Demo", "polar-way@x.test");
    b = await makeAccount("Other Seller", "other-way@x.test");
    as(a);
  }, 120_000);
  afterAll(async () => { await t.close(); });

  it("delete: a page with no submissions goes (counters cascade, banner file removed, audited); another account cannot touch it", async () => {
    const p = await make(a, { name: "Empty page", connection: "link", language: "en" });
    const ban = await svc.saveLeadPageBanner(db, actor(), a.id, p.id, png(1600, 500), { put: async (k, v) => { holder.files.set(k, v); }, get: async () => null, del: async () => {} }, {});
    if (!ban.ok) throw new Error(ban.reason);
    const blobPath = ban.page.banner!.blobPath;
    expect(holder.files.has(blobPath)).toBe(true);
    await svc.bumpDaily(db, a.id, p.id, new Date(), "", "views");

    // Account isolation: the other account's action finds nothing.
    as(b);
    expect((await run(actions.deleteLeadPageAction(form({ slug: b.slug, pageId: p.id })))).url).toBe(`/app/${b.slug}/lead-pages`);
    expect(await fresh(p)).toBeDefined();
    expect(await svc.deleteLeadPage(db, actor(), b.id, p.id, null)).toEqual({ ok: false, reason: "not_found" });
    as(a);

    const r = await run(actions.deleteLeadPageAction(form({ slug: a.slug, pageId: p.id, back: "list" })));
    expect(r.url).toBe(`/app/${a.slug}/lead-pages?done=deleted`);
    expect(await fresh(p)).toBeUndefined();
    expect(await db.select().from(leadPageDaily).where(eq(leadPageDaily.pageId, p.id))).toHaveLength(0);
    expect(holder.deleted).toContain(blobPath);
    expect(holder.files.has(blobPath)).toBe(false);
    const [audit] = await audits(a.id, "lead_page.deleted");
    expect(audit).toMatchObject({ targetId: p.id, actorUserId: seller.id, details: { name: "Empty page", testSubmissions: 0, testLeads: 0, banner: true } });
    expect(await audits(b.id, "lead_page.deleted")).toHaveLength(0);
  });

  it("delete with only test submissions removes those rows and keeps the test leads in Leads", async () => {
    const p = await make(a, { name: "Tried once", connection: "link", language: "en" }, false);
    await testSend(p, "Seller Test One");
    await testSend(p, "Seller Test Two");
    expect(await svc.pageSubmissionCounts(db, a.id, p.id)).toEqual({ real: 0, test: 2, testLeads: 2 });
    const leadIds = (await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.pageId, p.id))).map((s) => s.leadId);

    // The confirm step names the page and says the test leads stay.
    const html = await render(ListPage, { account: a.slug }, { confirm: p.id });
    save("way-list-confirm", html);
    expect(html).toContain(`data-confirm-for="${p.id}"`);
    expect(text(html)).toContain(msg("lead_pages.delete.title", { name: "Tried once" }));
    expect(text(html)).toContain(msg("lead_pages.delete.test_leads", { count: 2 }));
    expect(html).toContain('data-confirm-test-leads="2"');

    const r = await svc.deleteLeadPage(db, actor(), a.id, p.id, null);
    expect(r).toMatchObject({ ok: true });
    expect(await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.pageId, p.id))).toHaveLength(0);
    for (const id of leadIds) expect((await db.select().from(leads).where(eq(leads.id, id)))[0]).toMatchObject({ accountId: a.id, leadPageId: null });
    expect((await audits(a.id, "lead_page.deleted")).find((x) => x.targetId === p.id)?.details).toMatchObject({ testSubmissions: 2, testLeads: 2 });
  });

  it("delete is refused once a page has a real submission (re-checked on the server); archive is refused without one", async () => {
    const p = await make(a, { name: "Has a lead", connection: "link", language: "en" });
    const q = await make(a, { name: "No lead yet", connection: "link", language: "en" });
    await realSend(p);
    expect(await svc.deleteLeadPage(db, actor(), a.id, p.id, null)).toEqual({ ok: false, reason: "has_submissions" });
    // The client cannot pick the action: Delete for a page with leads lands back with the reason.
    expect((await run(actions.deleteLeadPageAction(form({ slug: a.slug, pageId: p.id })))).url).toBe(`/app/${a.slug}/lead-pages/${p.id}?way_error=has_submissions`);
    expect((await run(actions.deleteLeadPageAction(form({ slug: a.slug, pageId: p.id, back: "list", archived: "1" })))).url).toBe(`/app/${a.slug}/lead-pages?archived=1&way_error=has_submissions`);
    expect(await fresh(p)).toBeDefined();
    expect((await run(actions.archiveLeadPageAction(form({ slug: a.slug, pageId: q.id })))).url).toBe(`/app/${a.slug}/lead-pages/${q.id}?way_error=no_submissions`);
    expect(isArchived(await fresh(q))).toBe(false);
    // The confirm step is not shown for a page Delete does not apply to.
    expect(await render(ListPage, { account: a.slug }, { confirm: p.id })).not.toContain("data-confirm-for");
    // The page view shows the refusal.
    expect(text(await render(PageView, { account: a.slug, pageId: p.id }, { way_error: "has_submissions" }))).toContain(msg("lead_pages.way_error.has_submissions"));
  });

  it("archive: hidden from the list unless shown, numbers and the lead's source kept, closed on all three connection types; unarchive brings it back paused", async () => {
    const link = await make(a, { name: "Spring link", connection: "link", language: "en" });
    const snippet = await make(a, { name: "Spring snippet", connection: "snippet", language: "en", address: `${SITE}/offer` });
    const own = await make(a, { name: "Spring own form", connection: "own_form", language: "en", address: `${SITE}/contact` });
    const handover = await realSend(link, "Dana Levi");
    const sub = (await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.pageId, link.id)))[0];
    // Snippet and own form: one real submission each, through the route.
    const snipSend = await submitRoute.POST(new Request(`${APP}/api/lp/${snippet.publicKey}/submit`, {
      method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", origin: SITE, "x-forwarded-for": ip() },
      body: JSON.stringify({ ft: formTimingToken(snippet.id, Date.now() - 5000), consent: "on", name: "Snip Buyer", phone: phone() }),
    }), ctx(snippet.publicKey));
    expect(snipSend.status).toBe(200);
    const ownSend = await submitRoute.POST(new Request(`${APP}/api/lp/${own.publicKey}/submit`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, referer: `${SITE}/contact`, "x-forwarded-for": ip() },
      body: new URLSearchParams({ name: "Own Buyer", phone: phone(), consent: "yes" }).toString(),
    }), ctx(own.publicKey));
    expect(ownSend.status).toBe(303);
    expect(handover.kind).toBe("handover");

    const range = rangeOfDays(30);
    const before = await pageFunnel(db, a.id, link.id, range);
    expect(before.leftDetails).toBe(1);

    for (const p of [link, snippet, own]) {
      const r = await run(actions.archiveLeadPageAction(form({ slug: a.slug, pageId: p.id, back: "list" })));
      expect(r.url).toBe(`/app/${a.slug}/lead-pages?done=archived`);
      const f = await fresh(p);
      expect(f).toMatchObject({ status: "paused" });
      expect(f.options).toMatchObject({ archivedAt: expect.any(String), archivedBy: seller.id });
    }
    expect((await audits(a.id, "lead_page.archived")).map((x) => x.targetId).sort()).toEqual([link.id, snippet.id, own.id].sort());

    // The list hides them; ?archived=1 shows them, with the Archived pill.
    const listed = (await svc.listLeadPages(db, a.id)).map((p) => p.id);
    expect(listed).not.toContain(link.id);
    expect((await svc.listLeadPages(db, a.id, { includeArchived: true })).map((p) => p.id)).toContain(link.id);
    const hidden = await render(ListPage, { account: a.slug });
    expect(hidden).not.toContain(`data-page="${link.id}"`);
    expect(hidden).toContain('data-show-archived="off"');
    const shown = await render(ListPage, { account: a.slug }, { archived: "1" });
    save("way-list-archived", shown);
    expect(shown).toContain(`data-page="${link.id}"`);
    expect(shown).toContain('data-show-archived="on"');
    expect(text(shown)).toContain(msg("status.lead_page.archived"));
    // Totals: archived pages count only while shown.
    const visibleIds = (await svc.listLeadPages(db, a.id)).map((p) => p.id);
    const hiddenTotal = (await listTotals(db, a.id, range, { pageIds: visibleIds })).totals.leftDetails;
    expect((await listTotals(db, a.id, range, { pageIds: [...visibleIds, link.id, snippet.id, own.id] })).totals.leftDetails).toBe(hiddenTotal + 3);
    expect(hidden).toContain(`data-kpi="leads"><span class="sas-metric__label">${msg("lead_pages.kpi.leads")}</span><span class="sas-metric__value">${hiddenTotal}</span>`);
    expect(shown).toContain(`data-kpi="leads"><span class="sas-metric__label">${msg("lead_pages.kpi.leads")}</span><span class="sas-metric__value">${hiddenTotal + 3}</span>`);
    // Numbers and the lead's source are kept; the page view stays reachable (and the Leads ?page= filter finds it).
    expect(await pageFunnel(db, a.id, link.id, range)).toEqual(before);
    expect(await svc.leadPageSourceOf(db, a.id, { id: sub.leadId, leadPageId: null })).toMatchObject({ pageId: link.id, name: "Spring link" });
    expect(await svc.getLeadPage(db, a.id, link.id)).toMatchObject({ id: link.id });
    const view = await render(PageView, { account: a.slug, pageId: link.id }, { done: "archived" });
    save("way-page-archived", view);
    expect(view).toContain("data-archived-note");
    expect(view).toContain(`href="/app/${a.slug}/lead-pages?archived=1"`);
    expect(view).toContain('data-menu-op="unarchive"');
    expect(view).not.toContain('data-status-op="resume"');
    expect(view).not.toContain('data-menu-op="delete"');
    // No preview link for an archived page (it takes no sends, a preview neither).
    expect(view).toContain('hidden="" data-preview-make=""');

    // Sends are refused: hosted form shows the closed text, the snippet config is 404, the own form gets "closed".
    expect(await submitLeadPage(db, {
      key: link.publicKey, headers: new Headers({ origin: APP }), ip: ip(), env: { APP_URL: APP },
      body: { ft: formTimingToken(link.id, Date.now() - 5000), consent: "on", name: "Late Buyer", phone: phone() },
    })).toEqual({ kind: "refused", reason: "closed" });
    // Not even with a preview token.
    expect(await submitLeadPage(db, {
      key: link.publicKey, headers: new Headers({ origin: APP }), ip: ip(), env: { APP_URL: APP },
      body: { ft: formTimingToken(link.id, Date.now() - 5000), consent: "on", name: "Late Test", phone: phone(), preview: previewTokenFor(link.id, new Date()) },
    })).toEqual({ kind: "refused", reason: "closed" });
    expect(await svc.issuePreviewLink(db, actor(), a.id, link.id)).toBeNull();
    const hosted = await render(HostedForm, { key: link.publicKey }, { preview: previewTokenFor(link.id, new Date()) });
    expect(hosted).toContain("data-lp-closed");
    expect(hosted).not.toContain("<form");
    const cfg = await configRoute.GET(new Request(`${APP}/api/lp/${snippet.publicKey}/config`, { headers: { origin: SITE, "x-forwarded-for": ip() } }), ctx(snippet.publicKey));
    expect(cfg.status).toBe(404);
    const snipLate = await submitRoute.POST(new Request(`${APP}/api/lp/${snippet.publicKey}/submit`, {
      method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", origin: SITE, "x-forwarded-for": ip() },
      body: JSON.stringify({ ft: formTimingToken(snippet.id, Date.now() - 5000), consent: "on", name: "Snip Late", phone: phone() }),
    }), ctx(snippet.publicKey));
    expect(snipLate.status).toBe(403);
    expect(await snipLate.json()).toEqual({ error: "closed" });
    const ownLate = await submitRoute.POST(new Request(`${APP}/api/lp/${own.publicKey}/submit`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, referer: `${SITE}/contact`, "x-forwarded-for": ip() },
      body: new URLSearchParams({ name: "Own Late", phone: phone(), consent: "yes" }).toString(),
    }), ctx(own.publicKey));
    expect(ownLate.status).toBe(303);
    expect(ownLate.headers.get("location")).toBe(`${SITE}/contact?sas_error=closed`);
    expect(await db.select().from(leadPageSubmissions).where(eq(leadPageSubmissions.pageId, link.id))).toHaveLength(1);

    // Resume / go live are refused while archived; Unarchive brings it back paused (never live).
    expect(await svc.resumeLeadPage(db, actor(), a.id, link.id)).toEqual({ ok: false, reason: "archived" });
    expect((await run(actions.setLeadPageStatusAction(form({ slug: a.slug, pageId: link.id, op: "resume" })))).url).toBe(`/app/${a.slug}/lead-pages/${link.id}?way_error=archived`);
    expect((await fresh(link)).status).toBe("paused");
    as(b);
    expect((await run(actions.unarchiveLeadPageAction(form({ slug: b.slug, pageId: link.id })))).url).toBe(`/app/${b.slug}/lead-pages`);
    expect(isArchived(await fresh(link))).toBe(true);
    as(a);
    const u = await run(actions.unarchiveLeadPageAction(form({ slug: a.slug, pageId: link.id })));
    expect(u.url).toBe(`/app/${a.slug}/lead-pages/${link.id}?done=unarchived`);
    const back = await fresh(link);
    expect(back.status).toBe("paused");
    expect(back.options).not.toHaveProperty("archivedAt");
    expect(back.options).not.toHaveProperty("archivedBy");
    expect(await audits(a.id, "lead_page.unarchived")).toHaveLength(1);
    expect((await svc.listLeadPages(db, a.id)).map((p) => p.id)).toContain(link.id);
    expect(await svc.unarchiveLeadPage(db, actor(), a.id, link.id)).toEqual({ ok: false, reason: "not_archived" });
    expect(text(await render(PageView, { account: a.slug, pageId: link.id }, { done: "unarchived" }))).toContain(msg("lead_pages.done.unarchived"));
    // Another account cannot archive it.
    expect(await svc.archiveLeadPage(db, actor(), b.id, link.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("the ⋯ menu: Edit, Pause or Resume, and Delete or Archive by the page's submissions", async () => {
    const empty = await make(a, { name: "Menu empty", connection: "link", language: "en" });
    const full = await make(a, { name: "Menu full", connection: "link", language: "en" });
    await realSend(full);
    const html = await render(ListPage, { account: a.slug });
    const menuOf = (id: string) => {
      const start = html.indexOf(`data-page-menu="${id}"`);
      return html.slice(start, html.indexOf("</details>", start));
    };
    const m1 = menuOf(empty.id);
    expect(m1).toContain('data-menu-op="edit"');
    expect(m1).toContain('data-menu-op="pause"');
    expect(m1).toContain('data-menu-op="delete"');
    expect(m1).toContain(`confirm=${empty.id}`);
    expect(m1).not.toContain('data-menu-op="archive"');
    expect(m1).toContain('name="back" value="list"');
    expect(m1).toContain(msg("lead_pages.menu.label", { name: "Menu empty" }));
    const m2 = menuOf(full.id);
    expect(m2).toContain('data-menu-op="archive"');
    expect(m2).not.toContain('data-menu-op="delete"');
    expect(html).toContain("data-menu-enhancer");
    // The open menu, for the visual check.
    save("way-list-menu", html.replace(`<details class="sas-rowmenu lpg-menu" data-page-menu="${full.id}"`, `<details open="" class="sas-rowmenu lpg-menu" data-page-menu="${full.id}"`));
    // Pause from the list lands back on the list.
    expect((await run(actions.setLeadPageStatusAction(form({ slug: a.slug, pageId: empty.id, op: "pause", back: "list" })))).url).toBe(`/app/${a.slug}/lead-pages?done=paused`);
    const paused = await render(ListPage, { account: a.slug }, { done: "paused" });
    expect(paused).toContain('data-done="paused"');
    const menuP = paused.slice(paused.indexOf(`data-page-menu="${empty.id}"`));
    expect(menuP.slice(0, menuP.indexOf("</details>"))).toContain('data-menu-op="resume"');
    // The page view has the same menu and its confirm step.
    const view = await render(PageView, { account: a.slug, pageId: empty.id }, { confirm: empty.id });
    save("way-page-confirm", view);
    expect(view).toContain(`data-page-menu="${empty.id}"`);
    expect(view).toContain("data-confirm-delete");
    expect(text(view)).toContain(msg("lead_pages.delete.title", { name: "Menu empty" }));
    expect(view).not.toContain("data-confirm-test-leads");
    // Deleted from the list: the notice.
    expect(text(await render(ListPage, { account: a.slug }, { done: "deleted" }))).toContain(msg("lead_pages.done.deleted"));
  });
});

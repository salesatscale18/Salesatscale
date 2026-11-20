/**
 * Leads V2 (UX L-1 to L-5), rendered on PGlite over the demo seed: views and
 * counts (Needs you from the same items as the Overview), the What's needed
 * filter, rows that open where the item is handled, Who's on it, Deal value,
 * the rose edge in every view, test leads and other accounts left out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { catalogVersions, conversations, leadEvents, leads, orders, quotes, quoteVersions, sellerAccounts, users, type Lead, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
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
const { getAccountById } = await import("@/lib/accounts/service");
const { needsYou } = await import("@/lib/overview/service");
const { listLeads } = await import("@/lib/leads/service");
const { leadListFacts } = await import("@/lib/leads/list-facts");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { countItemsByGroup, NEEDS_GROUPS } = await import("@/lib/overview/needs-groups");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { takeOver, handBack } = await import("@/lib/agent/conversation");

const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const props = (account: string, sp: Record<string, string> = {}) => ({ params: Promise.resolve({ account }), searchParams: Promise.resolve(sp) });
const NOW = new Date();
const H = 3_600_000;
/** The rows of the Leads table, by lead name: the row's markup. */
const rows = (html: string) => {
  const body = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return body.split("<tr ").slice(1).map((r) => ({ html: r, name: r.match(/<bdi>([^<]+)<\/bdi><\/strong>/)?.[1] ?? "" }));
};
const row = (html: string, name: string) => rows(html).find((r) => r.name === name);
const tabCount = (html: string, tab: string) => Number(html.split(`data-tab="${tab}">`)[1]?.match(/class="sas-num[^"]*">(\d+)</)?.[1]);

describe("Leads V2 (LQ-L)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let account: SellerAccount;
  let other: SellerAccount;
  let hana: Lead, ido: Lead, ilan: Lead, quinn: Lead, sam: Lead, otto: Lead, tess: Lead;
  let seq = 97_000;

  const as = (a: SellerAccount) => { holder.access = { account: a, user: admin, actingAs: false, role: "seller_admin" }; };
  const mkLead = async (acc: SellerAccount, fullName: string, status: Lead["status"], hoursAgo: number, extra: Partial<typeof leads.$inferInsert> = {}) => {
    const [l] = await db.insert(leads).values({
      accountId: acc.id, fullName, company: `${fullName} Co`, phone: `+97250${String(seq++).padStart(7, "0")}`, language: "en", origin: "manual", status,
      lastActivityAt: new Date(NOW.getTime() - hoursAgo * H), ...extra,
    }).returning();
    return l;
  };
  const mkQuote = async (acc: SellerAccount, leadId: string, status: "sent" | "awaiting_approval", oneTime: number, recurring = 0) => {
    const [cv] = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, acc.id)).limit(1);
    const id = randomUUID();
    await db.insert(quotes).values({ id, accountId: acc.id, leadId, number: seq++, status });
    await db.insert(quoteVersions).values({
      id: randomUUID(), accountId: acc.id, quoteId: id, version: 1, catalogVersionId: cv.id, currency: "ILS", pricesIncludeTax: true, taxRateBp: 0,
      oneTimeSubtotalMinor: oneTime, oneTimeDiscountMinor: 0, oneTimeTaxMinor: 0, oneTimeTotalMinor: oneTime,
      recurringSubtotalMinor: recurring, recurringDiscountMinor: 0, recurringTaxMinor: 0, recurringTotalMinor: recurring, recurringPeriod: recurring ? "month" : null,
      approvalReasons: [], validUntil: new Date(NOW.getTime() + 7 * 86_400_000), createdByActor: "agent",
    });
    return id;
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_lql", email: "lql@platform.test", firstName: "Dana", role: "super_admin" }).returning();
    const a = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: NOW });
    const b = await createDemoAccount(db, admin, { ownerEmail: "owner2@platform.test", now: NOW });
    if (!a.ok || !b.ok) throw new Error("demo seed refused");
    account = (await getAccountById(db, a.summary.accountId))!;
    other = (await getAccountById(db, b.summary.accountId))!;
    // Handed to a person, nobody took it: waits 30 h and 2 h.
    hana = await mkLead(account, "Hana Handoff", "human_handling", 30);
    ilan = await mkLead(account, "Ilan Handoff", "human_handling", 2);
    // Handed to a person who owns it: someone holds the chat, so it is in With your team, not Needs you.
    ido = await mkLead(account, "Ido Handoff", "human_handling", 2, { ownerUserId: admin.id });
    // A price to approve (and nothing else).
    quinn = await mkLead(account, "Quinn Quote", "agent_handling", 1);
    await mkQuote(account, quinn.id, "awaiting_approval", 50_000);
    // The agent is on it, a quote sent.
    sam = await mkLead(account, "Sam Sent", "agent_handling", 3);
    await mkQuote(account, sam.id, "sent", 246_620, 10_620);
    otto = await mkLead(account, "Otto Optout", "opted_out", 4);
    // A test lead (Test lab) and another account's handed lead never show.
    tess = await mkLead(account, "Tess Testlead", "human_handling", 50, { isTest: true });
    await mkLead(other, "Olga Otheraccount", "human_handling", 60);
  }, 180_000);
  afterAll(async () => { await t.close(); });
  beforeEach(() => as(account));

  it("Needs you opens by default, lists exactly the leads with open items, with the count in a rose badge", async () => {
    const items = await needsYou(db, account.id, new Date());
    const withItems = new Set(items.map((i) => i.leadId));
    const html = await page(LeadsPage(props(account.slug)));
    expect(html).toContain('data-view="needs_you"');
    expect(html).toMatch(/data-tab="needs_you">Needs you <span class="sas-num sas-ltab__badge">\d+<\/span>/);
    expect(tabCount(html, "needs_you")).toBe(withItems.size);
    const names = rows(html).map((r) => r.name);
    expect(names).toContain("Hana Handoff");
    expect(names).toContain("Ilan Handoff");
    expect(names).toContain("Quinn Quote");
    expect(names).not.toContain("Ido Handoff");
    expect(names).not.toContain("Sam Sent");
    expect(names).not.toContain("Tess Testlead");
    expect(names).not.toContain("Olga Otheraccount");
    expect(names.length).toBe(Math.min(50, withItems.size));
    // Waiting longest first: Hana (30 h) before Ilan (2 h).
    expect(names.indexOf("Hana Handoff")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("Hana Handoff")).toBeLessThan(names.indexOf("Ilan Handoff"));
    expect(html).toContain("Oldest first. An item leaves this view as soon as it is done.");
    // The view's columns.
    expect(html).toContain('data-sort-col="need"');
    expect(html).toMatch(/aria-sort="descending"[^>]*data-sort-col="waiting"/);
  });

  it("rows: no buttons; the whole row opens where the item is handled; Who's on it; the rose edge", async () => {
    const html = await page(LeadsPage(props(account.slug)));
    const h = row(html, "Hana Handoff")!;
    expect(h.html).toContain(`href="/app/${account.slug}/leads/${hana.id}"`);
    expect(h.html).toContain('data-who="waiting"');
    expect(h.html).toContain(">Waiting for a person<");
    expect(h.html).toContain(">Asked for a person<");
    expect(h.html).toMatch(/data-label="Waiting"[^>]*>30 h</);
    expect(h.html).toContain("data-needs");
    expect(row(html, "Ilan Handoff")!.html).toContain('data-who="waiting"');
    // Ido's owner holds the chat: not in Needs you; With your team shows who is on it.
    expect(row(html, "Ido Handoff")).toBeUndefined();
    const team = await page(LeadsPage(props(account.slug, { view: "with_team" })));
    expect(row(team, "Ido Handoff")!.html).toContain('data-who="person"');
    expect(row(team, "Ido Handoff")!.html).toContain("<bdi>You</bdi>");
    const q = row(html, "Quinn Quote")!;
    expect(q.html).toMatch(new RegExp(`href="/app/${account.slug}/orders\\?tab=approval&amp;quote=[0-9a-f-]+"`));
    expect(q.html).toContain(">Price to approve<");
    expect(q.html).toContain('data-who="agent"');
    // No action buttons anywhere in the list (L-4).
    const tbody = html.split("<tbody>")[1].split("</tbody>")[0];
    expect(tbody).not.toContain("sas-btn");
    expect(tbody).not.toContain("<button");
  });

  it("What's needed filter: groups in order with lead counts, empty ones greyed; a group narrows the list", async () => {
    const html = await page(LeadsPage(props(account.slug)));
    const menu = html.split('data-testid="need-filter"')[1].split("</details>")[0];
    const order = [...menu.matchAll(/data-group="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["person", "calls", "questions", "payments", "prices", "forms", "follow_ups"]);
    expect(menu).toMatch(/data-group="prices">.*?<span class="sas-num">[1-9]\d*<\/span>/);
    expect(menu).toMatch(/<span role="listitem" class="sas-lf__opt" aria-disabled="true" data-group="follow_ups">/);
    const prices = await page(LeadsPage(props(account.slug, { need: "prices" })));
    expect(prices).toContain("What&#x27;s needed: Prices to approve");
    const names = rows(prices).map((r) => r.name);
    expect(names).toContain("Quinn Quote");
    expect(names).not.toContain("Hana Handoff");
    // The group survives a filter change (hidden field) and the phone sheet offers it as a select.
    expect(prices).toContain('<input type="hidden" name="need" value="prices"/>');
    expect(prices).toMatch(/<select class="sas-select" name="need">/);
  });

  it("status views: Agent working, With your team, Closed, All; a lead can be in Needs you and its status view", async () => {
    const agent = await page(LeadsPage(props(account.slug, { view: "agent_working" })));
    const agentNames = rows(agent).map((r) => r.name);
    expect(agentNames).toEqual(expect.arrayContaining(["Sam Sent", "Quinn Quote"]));
    expect(agentNames).not.toContain("Hana Handoff");
    expect(agent).toContain(">Next step<");
    // Sam: the quote is with the buyer; Deal value one-time with the monthly part under it.
    const s = row(agent, "Sam Sent")!;
    expect(s.html).toContain(">Quote sent<");
    expect(s.html).toContain("₪2,466.20");
    expect(s.html).toContain("+ ₪106.20/mo");
    expect(s.html).not.toContain("data-needs");
    // Quinn needs you: the rose edge and its item stay in every view.
    expect(row(agent, "Quinn Quote")!.html).toContain("data-needs");
    expect(row(agent, "Quinn Quote")!.html).toContain(">Price to approve<");

    const team = await page(LeadsPage(props(account.slug, { view: "with_team" })));
    expect(rows(team).map((r) => r.name)).toEqual(expect.arrayContaining(["Hana Handoff", "Ido Handoff"]));
    expect(rows(team).map((r) => r.name)).not.toContain("Sam Sent");
    // Old status links still work.
    expect(await page(LeadsPage(props(account.slug, { view: "human_handling" })))).toContain('data-view="with_team"');

    const closed = await page(LeadsPage(props(account.slug, { view: "closed" })));
    const o = row(closed, "Otto Optout")!;
    expect(o.html).toContain(">Opted out<");
    expect(o.html).toContain('data-who="none"');

    const all = await page(LeadsPage(props(account.slug, { view: "all" })));
    expect(rows(all).map((r) => r.name)).toEqual(expect.arrayContaining(["Hana Handoff", "Sam Sent", "Otto Optout"]));
    expect(rows(all).map((r) => r.name)).not.toContain("Tess Testlead");
    expect(tabCount(all, "all")).toBe(rows(all).length > 0 ? tabCount(all, "agent_working") + tabCount(all, "with_team") + tabCount(all, "won") + tabCount(all, "closed") : 0);
    // Stage chip without "· person handling" (Who's on it says it).
    expect(all).not.toContain("person handling");
  });

  it("Needs you can sort newest first and by group; the phone Sort menu offers the view's sorts", async () => {
    const newest = await page(LeadsPage(props(account.slug, { need: "person", sort: "waiting", dir: "asc" })));
    const n = rows(newest).map((r) => r.name);
    expect(n.indexOf("Ilan Handoff")).toBeGreaterThanOrEqual(0);
    expect(n.indexOf("Ilan Handoff")).toBeLessThan(n.indexOf("Hana Handoff"));
    expect(newest).toContain("Sort: Newest");
    const byGroup = await page(LeadsPage(props(account.slug, { sort: "need", dir: "asc" })));
    const g = rows(byGroup).map((r) => r.html.match(/data-group="([a-z_]+)"/)?.[1] ?? "");
    const rank = ["person", "calls", "questions", "payments", "prices", "forms", "follow_ups"];
    expect(g.map((x) => rank.indexOf(x))).toEqual([...g.map((x) => rank.indexOf(x))].sort((a, b) => a - b));
    const agent = await page(LeadsPage(props(account.slug, { view: "agent_working" })));
    expect(agent).toContain("Sort: Latest activity");
    expect(agent).toMatch(/>Oldest activity<\/a>/);
    expect(agent).toMatch(/href="[^"]*sort=value&amp;dir=desc"[^>]*>Deal value<\/a>/);
  });

  it("with nothing waiting, Agent working opens by default", async () => {
    // A plain account: one lead the agent handles, nothing for the team.
    const [quiet] = await db.insert(sellerAccounts).values({
      slug: "quiet-lql", tradeName: "Quiet Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS",
      plan: "pilot", monthlySpendCapMinor: 100_000, status: "live",
    }).returning();
    await mkLead(quiet, "Avi Agent", "agent_handling", 1);
    as(quiet);
    expect(await needsYou(db, quiet.id, new Date())).toHaveLength(0);
    const html = await page(LeadsPage(props(quiet.slug)));
    expect(html).toContain('data-view="agent_working"');
    expect(html).toMatch(/data-tab="needs_you">Needs you <span class="sas-num">0<\/span>/);
    expect(row(html, "Avi Agent")!.html).toContain(">Waiting for the buyer’s reply<");
    const empty = await page(LeadsPage(props(quiet.slug, { view: "needs_you" })));
    expect(empty).toContain("Nothing needs you right now.");
    // L-6: the Overview card says so too, with no group rows and no footer.
    const ov = await page(OverviewPage(props(quiet.slug)));
    const card = ov.split('id="needs-h"')[1].split("</section>")[0];
    expect(card).toContain('data-needs-empty="">Nothing needs you right now.</p>');
    expect(card).not.toContain("data-needs-group");
    expect(card).not.toContain("Open in Leads");
  });

  it("L-6: the Overview Needs you card counts per group, in order, and opens Leads > Needs you filtered to the group", async () => {
    const items = await needsYou(db, account.id, new Date());
    const counts = countItemsByGroup(items);
    const html = await page(OverviewPage(props(account.slug)));
    const card = html.split('id="needs-h"')[1].split("</section>")[0];
    expect(card).toContain(`data-needs-total="${items.length}"`);
    expect(card).toContain(`${items.length} items`);
    const shown = [...card.matchAll(/data-needs-group="([a-z_]+)"/g)].map((m) => m[1]);
    expect(shown).toEqual(NEEDS_GROUPS.filter((g) => counts[g] > 0));
    expect(shown).toContain("person");
    expect(shown).toContain("prices");
    expect(card).toMatch(new RegExp(`href="/app/${account.slug}/leads\\?view=needs_you&amp;need=prices" data-needs-group="prices">[\\s\\S]*?>Prices to approve<[\\s\\S]*?sas-ovn__count">${counts.prices}<`));
    // Hana has waited 30 h, the oldest item here.
    const oldest = Math.max(...items.map((i) => Date.now() - i.at.getTime()));
    expect(card).toContain(`Oldest waiting: <strong class="sas-num">${oldest >= 48 * H ? `${Math.floor(oldest / (24 * H))} days` : `${Math.floor(oldest / H)} h`}</strong>`);
    expect(card).toContain(`href="/app/${account.slug}/leads?view=needs_you">Open in Leads`);
    // The old per-item list and its buttons are gone; the funnel is full width, outside the markets row.
    expect(card).not.toContain("sas-btn");
    const row = html.split('class="sas-ov__row sas-ovn-row"')[1].split('aria-labelledby="funnel-h"')[0];
    expect(row).toContain('id="needs-h"');
    expect(row).toContain('aria-labelledby="markets-h"');
    // A group link lands on the filtered Leads view.
    const leadsHtml = await page(LeadsPage(props(account.slug, { view: "needs_you", need: "person" })));
    expect(rows(leadsHtml).length).toBe(new Set(items.filter((i) => i.kind === "human_handling").map((i) => i.leadId)).size);
  });

  it("Next step outside Needs you: who has the chat, or Waiting for a person; Needs you keeps Asked for a person only while nobody holds the chat", async () => {
    const team = await page(LeadsPage(props(account.slug, { view: "with_team" })));
    const h = row(team, "Hana Handoff")!;
    expect(h.html).toContain(">Waiting for a person</span>");
    expect(h.html).not.toContain(">Asked for a person<");
    // The person's name (here the viewer: "You"), isolated, never an email.
    const i = row(team, "Ido Handoff")!;
    expect(i.html).toContain(">You’re handling the chat</span>");
    expect(i.html).not.toContain("lql@platform.test");
    expect(i.html).toContain(`href="/app/${account.slug}/leads/${ido.id}"`);
    // The rose edge stays: they still need you.
    expect(h.html).toContain("data-needs");
    const needs = await page(LeadsPage(props(account.slug, { need: "person" })));
    expect(row(needs, "Ilan Handoff")!.html).toContain(">Asked for a person<");
    // Someone holds Ido's chat (an owner), so Needs you leaves it out.
    expect(row(needs, "Ido Handoff")).toBeUndefined();
  });

  it("Take over: whoever took the chat is on it (Next step and Who's on it agree), from the conversation, not the lead's owner", async () => {
    // The demo's Uri (אורי דמו): handed off, then taken over with the Take over service by the demo's creator (the viewer).
    const uri = (await db.select().from(leads).where(eq(leads.accountId, account.id))).find((l) => l.fullName === "אורי דמו")!;
    expect(uri.ownerUserId).toBeNull();
    const team = await page(LeadsPage(props(account.slug, { view: "with_team" })));
    const u = row(team, "אורי דמו")!;
    expect(u.html).toContain(">You’re handling the chat</span>");
    expect(u.html).toContain('data-who="person"');
    expect(u.html).not.toContain(">Waiting for a person<");
    const [conv] = await db.select().from(conversations).where(and(eq(conversations.accountId, account.id), eq(conversations.leadId, uri.id), eq(conversations.status, "human")));
    const [mate] = await db.insert(users).values({ clerkId: "c_lql_mate", email: "noa.mate@platform.test", firstName: "Noa", lastName: "Levi", role: "user" }).returning();
    const actor = (id: string) => ({ userId: id, actingAs: false });
    try {
      // A teammate takes it over: their name, never their email, in both cells.
      expect((await handBack(db, actor(admin.id), account.id, conv.id)).ok).toBe(true);
      expect((await takeOver(db, actor(mate.id), account.id, conv.id)).ok).toBe(true);
      const facts = await leadListFacts(db, account.id, [uri.id]);
      expect(facts.get(uri.id)?.handler?.id).toBe(mate.id);
      expect((await leadListFacts(db, other.id, [uri.id])).size).toBe(0);
      const html = await page(LeadsPage(props(account.slug, { view: "with_team" })));
      const r = row(html, "אורי דמו")!;
      expect(r.html).toContain(">⁨Noa Levi⁩ is handling the chat</span>");
      expect(r.html).toMatch(/data-who="person"><bdi>Noa Levi<\/bdi>/);
      expect(r.html).not.toContain("noa.mate@");
      // Handed back: the agent has it again.
      expect((await handBack(db, actor(mate.id), account.id, conv.id)).ok).toBe(true);
      const back = row(await page(LeadsPage(props(account.slug, { view: "agent_working" }))), "אורי דמו")!;
      expect(back.html).toContain('data-who="agent"');
      expect(back.html).not.toContain("is handling the chat");
    } finally {
      await takeOver(db, actor(admin.id), account.id, conv.id);
    }
  });

  it("fits its card at 1440 and 1280 with 2 markets: fixed columns, What's needed takes the rest, Market folds under the company (LQ fix 1)", async () => {
    // Render: the demo account has 2 markets, so the Market column shows; no min-width forces a sideways scroll.
    const html = await page(LeadsPage(props(account.slug)));
    const table = html.match(/<table [^>]*class="sas-table sas-table--stack sas-ltable"[^>]*>/)![0];
    expect(table).toContain("data-market-col");
    expect(table).not.toMatch(/min-width/);
    const head = html.split("<thead>")[1].split("</thead>")[0];
    const cols = [...head.matchAll(/<th [^>]*class="([^"]+)"/g)].map((m) => m[1].match(/sas-lcol--(\w+)|sas-ltable__chev/)?.[0]);
    expect(cols).toEqual(["sas-lcol--lead", "sas-lcol--step", "sas-lcol--stage", "sas-lcol--value", "sas-lcol--who", "sas-lcol--market", "sas-lcol--when", "sas-ltable__chev"]);
    // The market also as a muted line under the company (shown when the table is narrower).
    expect(row(html, "Hana Handoff")!.html).toMatch(/class="sas-small sas-lrow__mkt" data-market="[^"]+">[^<]+</);
    // CSS numbers (a render test cannot measure layout): the fixed columns leave What's needed at least 240px
    // in the card at 1440 (about 1142px, with Market) and at 1280 (about 982px, Market folded).
    const css = readFileSync("components/sas/sas.css", "utf8");
    const block = css.slice(css.indexOf("/* LQ fix 1 (lane lq-fix1)"));
    expect(block).toMatch(/\.sas-table\.sas-ltable \{ table-layout: fixed; width: 100%; \}/);
    const w = (c: string) => Number(block.match(new RegExp(`\\.sas-ltable th\\.sas-lcol--${c} \\{ width: (\\d+)px; \\}`))?.[1]);
    const chev = Number(block.match(/th\.sas-ltable__chev, [^{]+\{ width: (\d+)px;/)?.[1]);
    const fixed = ["lead", "stage", "value", "who", "when"].map(w).reduce((a, b) => a + b, 0) + chev;
    expect(Number.isFinite(fixed)).toBe(true);
    const fold = Number(block.match(/@container ltable \(max-width: (\d+)px\)/)?.[1]);
    expect(1142 - fixed - w("market")).toBeGreaterThanOrEqual(240);
    expect(fold).toBeLessThan(1142);
    expect(fold + 1 - fixed - w("market")).toBeGreaterThanOrEqual(240);
    expect(982 - fixed).toBeGreaterThanOrEqual(240);
  });

  it("every filter defaults to Any; Stage is a picker like What's needed; order numbers in detail lines use the text font (LQ fix 1)", async () => {
    const html = await page(LeadsPage(props(account.slug)));
    for (const label of ["Stage", "Source", "Language", "Last activity"]) expect(html).toContain(`<option value="" selected="">${label}: Any</option>`);
    expect(html).toContain('<option value="all" selected="">Market: Any</option>');
    expect(html).not.toMatch(/>(Stage|Source|Language|Last activity|Market): All</);
    // Desktop Stage: a direct child of the toolbar (sas.css gives it the What's needed look), still a native select.
    const toolbar = html.split('data-testid="leads-filters"')[1].split("</form>")[0];
    expect(toolbar).toMatch(/<\/details><label class="sas-filter"><span class="sas-sr">Stage<\/span><select class="sas-select" name="stage">/);
    // The bank transfer's order number: one plain run (text font, tabular numbers), not the code font.
    const bank = (await needsYou(db, account.id, new Date())).find((i) => i.kind === "bank_transfer")!;
    const r = rows(html).find((x) => x.html.includes(`/leads/${bank.leadId}?`))!;
    expect(r.html).toMatch(/<span class="sas-id sas-id--plain">PD-\d+<\/span> · /);
  });

  it("a confirmed call ahead is the Next step (before the sent quote), read in one batch per page", async () => {
    const cara = await mkLead(account, "Cara Call", "agent_handling", 1);
    await mkQuote(account, cara.id, "sent", 10_000);
    const callbackId = randomUUID();
    const at = new Date("2030-11-22T10:30:00Z");
    await db.insert(leadEvents).values([
      { accountId: account.id, leadId: cara.id, type: "callback.requested", actor: "agent", data: { callbackId, at: at.toISOString(), timezone: "Asia/Jerusalem", brief: "Pricing for 3 sites" }, createdAt: new Date(NOW.getTime() - 2 * H) },
      { accountId: account.id, leadId: cara.id, type: "callback.confirmed", actor: "human", data: { callbackId, at: at.toISOString(), timezone: "Asia/Jerusalem" }, createdAt: new Date(NOW.getTime() - H) },
    ]);
    const facts = await leadListFacts(db, account.id, [cara.id, sam.id]);
    expect(facts.get(cara.id)?.call?.at.toISOString()).toBe(at.toISOString());
    expect(facts.get(sam.id)?.call ?? null).toBeNull();
    expect((await leadListFacts(db, other.id, [cara.id])).size).toBe(0);
    const html = await page(LeadsPage(props(account.slug, { view: "agent_working" })));
    const c = row(html, "Cara Call")!;
    // The account's time zone (Asia/Jerusalem): 10:30 UTC is 12:30.
    expect(c.html).toMatch(/>Call · ⁨Fri 22 Nov,? 12:30⁩<\/span>/);
    expect(c.html).toContain("Pricing for 3 sites");
    expect(c.html).not.toContain(">Quote sent<");
    // Once the call time has passed, it is no longer ahead.
    expect((await leadListFacts(db, account.id, [cara.id], new Date(at.getTime() + H))).get(cara.id)?.call ?? null).toBeNull();
  });

  it("lead page Orders card: Review transfer / Payment failed: open order go to the order's panel", async () => {
    const item = (await needsYou(db, account.id, new Date())).find((i) => i.kind === "bank_transfer");
    expect(item).toBeTruthy();
    if (!item || item.kind !== "bank_transfer") return;
    const open = async () => page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId: item.leadId }), searchParams: Promise.resolve({}) }) as Promise<ReactElement>);
    const html = await open();
    expect(html).toContain(`href="/app/${account.slug}/orders?tab=orders&amp;quote=${item.quoteId}" data-order-action="review_transfer"`);
    expect(html).toMatch(/data-order-action="review_transfer">.*?Review transfer<\/a>/);
    await db.update(orders).set({ paymentStatus: "failed" }).where(eq(orders.id, item.orderId));
    try {
      const failed = await open();
      expect(failed).toMatch(/data-order-action="payment_failed">.*?Payment failed: open order<\/a>/);
      await db.update(orders).set({ paymentStatus: "paid" }).where(eq(orders.id, item.orderId));
      expect(await open()).not.toContain("data-order-action");
    } finally {
      await db.update(orders).set({ paymentStatus: "bank_transfer_expected" }).where(eq(orders.id, item.orderId));
    }
  });

  it("services: Deal value sorts in SQL; list facts and lead ids stay inside the account", async () => {
    const byValue = await listLeads(db, account.id, { statuses: ["agent_handling"], sort: { key: "value", dir: "desc" }, limit: 500 });
    const names = byValue.rows.map((r) => r.lead.fullName);
    expect(names.indexOf("Sam Sent")).toBeLessThan(names.indexOf("Quinn Quote"));
    expect((await listLeads(db, account.id, { leadIds: [] })).total).toBe(0);
    expect((await listLeads(db, other.id, { leadIds: [hana.id] })).total).toBe(0);
    expect((await leadListFacts(db, account.id, [sam.id])).get(sam.id)?.quote).toMatchObject({ oneTimeMinor: 246_620, recurringMinor: 10_620, status: "sent" });
    expect((await leadListFacts(db, other.id, [sam.id])).size).toBe(0);
    expect(tess.isTest).toBe(true);
    void otto;
  });
});

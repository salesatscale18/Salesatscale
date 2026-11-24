/**
 * ConvListV2 (owner-approved, 24 Nov, version B): the Conversations list panel. The six views in one menu with
 * their counts, a sort menu (Newest first, Oldest first), groups as bands, and rows of exactly two lines (circle,
 * name, business, date; then the last message with its speaker, or the reason in Needs you). Rendered on PGlite.
 *
 * With CONV_LIST_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { conversations, leadEvents, leads, messages, users, type SellerAccount, type User } from "@/db/schema";
import { sellerAccounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { ensureDraftVersion } = await import("@/lib/agent/service");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.CONV_LIST_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
const render = async (slug: string, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (ConversationsPage({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) }) as Promise<ReactElement>));
/** The list panel only (the thread and the page head are left out). */
const listOf = (html: string) => html.slice(html.indexOf('class="sas-panel sas-inbox__list"'), html.indexOf('class="sas-panel sas-inbox__thread"'));
/** Each row's anchor, by the person's name. */
const rows = (html: string) => [...listOf(html).matchAll(/<a class="sas-inbox__row[^"]*"[^>]*data-row="">([\s\S]*?)<\/a>/g)].map((m) => m[0]);
const person = (name: string) => `<bdi dir="auto" class="sas-inbox__person">${name}</bdi>`;
const rowOf = (html: string, name: string) => rows(html).find((r) => r.includes(person(name))) ?? "";
const names = (html: string) => rows(html).map((r) => /<bdi dir="auto" class="sas-inbox__person">([^<]+)<\/bdi>/.exec(r)![1]);
/** A row's second line with a speaker (or none) and the message as rendered. */
const line2 = (who: string | null, text: string, title = who ? `${who}: ${text}` : text) =>
  `<span class="sas-inbox__preview" dir="ltr" data-line="2" data-preview="" title="${title}">${who ? `<span class="sas-inbox__preview-who">${who}:</span> ` : ""}<bdi class="sas-inbox__preview-text" dir="auto">${text}</bdi></span>`;
const decode = (s: string) => s.replace(/&amp;/g, "&");

describe("ConvListV2: the Conversations list panel", () => {
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    const acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await db.update(sellerAccounts).set({ simulateWhatsappRules: true }).where(eq(sellerAccounts.id, acc));
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
    const draft = await ensureDraftVersion(db, acc);
    const base = Date.now() - 60 * 60 * 1000;
    let n = 0;
    const chat = async (o: {
      key: string; name: string; company: string; channel: string; status?: "open" | "human" | "closed"; takenOver?: boolean; isTest?: boolean;
      leadStatus?: "new" | "human_handling" | "won"; language?: string; minutesAgo: number; last: { actor: string; body: string; mine?: boolean };
    }) => {
      const [lead] = await db.insert(leads).values({
        accountId: acc, fullName: o.name, company: o.company, phone: `+97250000000${n++}`, language: o.language ?? "en", origin: "manual",
        status: o.leadStatus ?? "new", isTest: !!o.isTest,
      }).returning();
      const [conv] = await db.insert(conversations).values({
        accountId: acc, leadId: lead.id, channel: o.channel, isTest: !!o.isTest, agentVersionId: draft.id, status: o.status ?? "open",
        takenOverByUserId: o.takenOver ? me.id : null, language: o.language ?? "en",
      }).returning();
      const at = new Date(base + (60 - o.minutesAgo) * 60 * 1000);
      // An earlier buyer message first, so the WhatsApp window has a buyer time.
      await db.insert(messages).values({ accountId: acc, conversationId: conv.id, actor: "buyer", body: "Hello", language: o.language ?? "en", createdAt: new Date(at.getTime() - 60_000) });
      await db.insert(messages).values({ accountId: acc, conversationId: conv.id, actor: o.last.actor, actorUserId: o.last.mine ? me.id : null, body: o.last.body, language: o.language ?? "en", createdAt: at });
      ids[o.key] = conv.id;
      ids[`${o.key}Lead`] = lead.id;
      return lead;
    };
    // Needs you: the AI budget ran out, the agent handed off; the buyer wrote last.
    const john = await chat({ key: "john", name: "John", company: "Cafe Owner", channel: "whatsapp", status: "human", minutesAgo: 30, last: { actor: "buyer", body: "Is anyone there? I need the price today" } });
    await db.insert(leadEvents).values({ accountId: acc, leadId: john.id, type: "handoff.spend_cap", actor: "system", data: {} });
    // More Needs you kinds: the platform's AI budget, a plain ask for a person, upset, and a free reason with no label.
    const needs = async (key: string, name: string, company: string, reason: string, minutesAgo: number) => {
      const l = await chat({ key, name, company, channel: "chat", status: "human", minutesAgo, last: { actor: "buyer", body: "Hello?" } });
      await db.insert(leadEvents).values({ accountId: acc, leadId: l.id, type: "handoff.requested", actor: "agent", data: { reason, summary: "" } });
    };
    await needs("maya", "Maya Budget", "Maya Cafe", "The platform's monthly AI budget is used up", 31);
    await needs("omer", "Omer Ask", "Omer Deli", "The buyer asked to talk to a person about delivery", 32);
    await needs("noa", "Noa Upset", "Noa Bar", "The buyer is upset: alarms at night", 33);
    await needs("free", "Gal Free", "Gal Bakery", "Needs a custom installation plan for 40 sites", 34);
    // Human handling, in Hebrew: a person holds it and wrote last.
    await chat({ key: "ronit", name: "רונית דמו", company: "מאפיית דמו רמת גן", channel: "simulator", status: "human", takenOver: true, leadStatus: "human_handling", language: "he", minutesAgo: 25, last: { actor: "human", body: "היי רונית, כאן הצוות של פולאר דמו", mine: true } });
    // Agent handling: a voice call last, a WhatsApp chat, a simulated chat.
    await chat({ key: "tal", name: "Tal Voice Test", company: "Tal Deli", channel: "chat", minutesAgo: 10, last: { actor: "system", body: "Voice call ended · 4:12" } });
    await chat({ key: "shira", name: "Shira Demo", company: "Bistro Demo Rehovot", channel: "whatsapp", minutesAgo: 5, last: { actor: "buyer", body: "Can you call me on *Thursday* at 10?" } });
    await chat({ key: "zero", name: "Zero Call", company: "Zero Deli", channel: "chat", minutesAgo: 45, last: { actor: "system", body: "Voice call ended · 0:00" } });
    await chat({ key: "avi", name: "Avi Demo", company: "Deli Demo Jaffa", channel: "simulator", minutesAgo: 40, last: { actor: "agent", body: "Still open, Avi. Is anything holding up the payment?" } });
    // Closed, and a test-lab chat (only under Test lab chats).
    await chat({ key: "dan", name: "Dan Levi", company: "Dan Bakery", channel: "chat", status: "closed", minutesAgo: 50, last: { actor: "agent", body: "Thanks, bye" } });
    await chat({ key: "lab", name: "Lab Tester", company: "Lab Co", channel: "testlab", isTest: true, minutesAgo: 1, last: { actor: "agent", body: "Draft agent reply" } });
  });

  it("the six views are one menu: the current view and its count, each option with its count, the query params kept", async () => {
    const html = await render(account.slug, { sort: "oldest", q: "o" });
    save("all", await render(account.slug));
    const list = listOf(html);
    expect(list).not.toContain('class="sas-views"');
    const menu = list.slice(list.indexOf("data-inbox-view"), list.indexOf("data-inbox-sort"));
    expect(menu).toMatch(/<summary class="sas-inbox__select"[^>]*><span class="sas-oneline">All buyer chats · <span class="sas-num">\d+<\/span><\/span>/);
    const options = [...menu.matchAll(/<a class="sas-rowmenu__item sas-inbox__option" href="([^"]+)"[^>]*data-view="([a-z_]+)">([^<]+) <span class="sas-num">(\d+)<\/span><\/a>/g)];
    expect(options.map((o) => o[2])).toEqual(["all", "needs_you", "agent", "human", "closed", "test"]);
    expect(options.map((o) => o[3])).toEqual(["All buyer chats", "Needs you", "Agent handling", "Human handling", "Closed", "Test lab chats"]);
    // Each option keeps the search and the sort, and drops the page and the open chat.
    for (const o of options) {
      const href = decode(o[1]);
      expect(href).toContain("sort=oldest");
      expect(href).toContain("q=o");
      if (o[2] === "all") expect(href).not.toContain("filter=");
      else expect(href).toContain(`filter=${o[2]}`);
    }
    // Unsearched counts.
    const all = listOf(await render(account.slug));
    const count = (v: string) => Number(new RegExp(`data-view="${v}">[^<]+ <span class="sas-num">(\\d+)<`).exec(all)![1]);
    expect([count("all"), count("needs_you"), count("agent"), count("human"), count("closed"), count("test")]).toEqual([11, 5, 4, 1, 1, 1]);
    expect(all).toContain('aria-current="page" data-view="all"');
  });

  it("an existing link to a filtered view still opens it; the sort menu keeps the view", async () => {
    const human = listOf(await render(account.slug, { filter: "human" }));
    expect(human).toMatch(/<span class="sas-oneline">Human handling · <span class="sas-num">1<\/span><\/span>/);
    expect(names(human)).toEqual(["רונית דמו"]);
    const sortMenu = human.slice(human.indexOf("data-inbox-sort"));
    const sorts = [...sortMenu.matchAll(/<a class="sas-rowmenu__item sas-inbox__option" href="([^"]+)"[^>]*data-sort="([a-z]+)">([^<]+)<\/a>/g)];
    expect(sorts.map((s) => [s[2], s[3]])).toEqual([["newest", "Newest first"], ["oldest", "Oldest first"]]);
    expect(decode(sorts[1][1])).toContain("filter=human");
    expect(decode(sorts[1][1])).toContain("sort=oldest");
    expect(decode(sorts[0][1])).not.toContain("sort=");
    expect(sortMenu).toMatch(/<span class="sas-oneline">Newest first<\/span>/);
    // The search form keeps the sort too.
    expect(listOf(await render(account.slug, { sort: "oldest" }))).toContain('<input type="hidden" name="sort" value="oldest"/>');
  });

  it("sorts newest first by default, oldest first on request", async () => {
    const newest = names(listOf(await render(account.slug, { filter: "agent" })));
    expect(newest).toEqual(["Shira Demo", "Tal Voice Test", "Avi Demo", "Zero Call"]);
    const oldest = listOf(await render(account.slug, { filter: "agent", sort: "oldest" }));
    expect(names(oldest)).toEqual(["Zero Call", "Avi Demo", "Tal Voice Test", "Shira Demo"]);
    expect(oldest).toMatch(/<span class="sas-oneline">Oldest first<\/span>/);
    expect(oldest).toContain('aria-current="page" data-sort="oldest"');
  });

  it("All keeps the groups with their counts as bands; a single-status view has no group header", async () => {
    const all = listOf(await render(account.slug));
    const heads = [...all.matchAll(/<h3 class="sas-label sas-inbox__group">([^<]+) · <span class="sas-num">(\d+)<\/span><\/h3>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(heads).toEqual(["Needs you 5", "Human handling 1", "Agent handling 4", "Closed 1"]);
    expect(css).toMatch(/\.sas-inbox__group \{ margin: 0; padding: 10px 16px 6px; background: var\(--surface\); \}/);
    for (const f of ["needs_you", "agent", "human", "closed", "test"]) {
      expect(listOf(await render(account.slug, { filter: f }))).not.toContain("sas-inbox__group");
    }
  });

  it("a row is two lines: circle, name, business and date; then the speaker and the last message", async () => {
    const html = await render(account.slug);
    for (const r of rows(html)) {
      // Exactly four parts in order: the circle, line 1 (name · business), the date, line 2.
      const parts = [...r.matchAll(/<span class="(sas-av[^"]*|sas-inbox__name|sas-when|sas-inbox__preview(?: [^"]*)?)"/g)].map((m) => m[1].split(" ")[0]);
      expect(parts).toEqual(["sas-av", "sas-inbox__name", "sas-when", "sas-inbox__preview"]);
      expect(r.match(/data-line="1"/g)).toHaveLength(1);
      expect(r.match(/data-line="2"/g)).toHaveLength(1);
    }
    const avi = rowOf(html, "Avi Demo");
    expect(avi).toContain('<span class="sas-av sas-av--agent" aria-hidden="true">');
    expect(avi).toContain('<span class="sas-inbox__name" dir="ltr" data-line="1"><bdi dir="auto" class="sas-inbox__person">Avi Demo</bdi><span class="sas-inbox__sep"> · </span><bdi dir="auto" class="sas-inbox__company">Deli Demo Jaffa</bdi></span>');
    expect(avi).toContain(line2("Agent", "Still open, Avi. Is anything holding up the payment?"));
    // A person handles it: the rose circle with initials.
    expect(rowOf(html, "רונית דמו")).toContain('<span class="sas-av sas-av--human" aria-hidden="true">');
    expect(rowOf(html, "John")).toContain('<span class="sas-av sas-av--human" aria-hidden="true">JO</span>');
    // The buyer's message is readable (no emphasis markers) after "Buyer:".
    expect(rowOf(html, "Shira Demo")).toContain(line2("Buyer", "Can you call me on Thursday at 10?"));
    // conv-list-fixes 3: one left-to-right block cut at its end, the message an isolated inline run.
    expect(css).toContain(".sas-inbox__preview { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
    expect(css).toContain(".sas-inbox__preview-text { unicode-bidi: isolate; }");
    expect(css).toMatch(/\.sas-app a\.sas-inbox__row \{ display: grid; grid-template-columns: 36px minmax\(0, 1fr\) auto;[^}]*min-height: 60px;/);
    expect(css).toMatch(/\.sas-inbox__row > \.sas-av \{ grid-row: span 2; width: 36px; height: 36px;/);
  });

  it("Needs you rows show the SHORT reason label in rose, not the last message; the whole reason is the tooltip", async () => {
    const html = await render(account.slug);
    const needsLine = (title: string, text: string) =>
      `<span class="sas-inbox__preview sas-inbox__preview--needs" dir="ltr" data-line="2" data-handoff-why="" title="${title}">${text}</span>`;
    const john = rowOf(html, "John");
    // handoff.spend_cap (the account's spend cap).
    expect(john).toContain(needsLine("Hand-off requested · AI limit reached","Hand-off requested · AI limit reached"));
    expect(john).not.toContain("Is anyone there");
    expect(john).not.toContain("data-preview");
    // The platform's AI budget (a hand_off_to_human reason): the same short label, the sentence only in the tooltip.
    const maya = rowOf(html, "Maya Budget");
    expect(maya).toContain(">Hand-off requested · AI limit reached</span>");
    expect(maya).toContain('title="Hand-off requested · AI limit reached · The platform&#x27;s monthly AI budget is used up"');
    expect(rowOf(html, "Omer Ask")).toContain(">Hand-off requested · Buyer asked for a person</span>");
    expect(rowOf(html, "Noa Upset")).toContain(">Hand-off requested · Upset</span>");
    // No short label: what waits, alone; the reason is in the tooltip.
    const free = rowOf(html, "Gal Free");
    expect(free).toContain(">Hand-off requested</span>");
    expect(free).toContain('title="Hand-off requested · Needs a custom installation plan for 40 sites"');
    expect(css).toContain(".sas-inbox__row > .sas-inbox__preview--needs { color: var(--human); font-weight: 500; }");
  });

  it("a voice call as the last event reads Voice call · 4 min 12 s, with no System: prefix", async () => {
    const html = await render(account.slug);
    expect(rowOf(html, "Tal Voice Test")).toContain(line2(null, "Voice call · 4 min 12 s"));
    // A call with no stored length: "Voice call", never "· 0 s".
    expect(rowOf(html, "Zero Call")).toContain(line2(null, "Voice call"));
    expect(listOf(html)).not.toContain("· 0 s");
    expect(listOf(html)).not.toContain("System:");
    expect(listOf(html)).not.toContain("Voice call ended");
  });

  it("rows carry no status, hand-off, channel, simulated, market, test or window text", async () => {
    for (const sp of [{}, { filter: "test" }, { filter: "agent" }] as Record<string, string>[]) {
      const html = await render(account.slug, sp);
      for (const r of rows(html)) {
        const text = r.replace(/<[^>]+>/g, " ");
        for (const word of ["Web chat", "WhatsApp", "Simulated", "Test lab chat", "Israel", "Window", "templates only", "New", "Human handling", "Agent handling", "Closed"]) {
          expect(text).not.toContain(word);
        }
        expect(r).not.toMatch(/sas-pill|sas-chip|sas-channel-pill|sas-window|data-market|sas-inbox__badge/);
      }
    }
  });

  it("the selected row has the primary-soft background only, the whole row is the link, with a visible focus ring", async () => {
    const html = await render(account.slug, { c: ids.avi });
    save("selected", html);
    const avi = rowOf(html, "Avi Demo");
    expect(avi).toMatch(/^<a class="sas-inbox__row" href="[^"]*c=[^"]*#thread" aria-current="page" data-row="">/);
    expect(rows(html).filter((r) => r.includes('aria-current="page"'))).toHaveLength(1);
    expect(css).toContain('.sas-app a.sas-inbox__row[aria-current="page"] { background: var(--primary-soft); }');
    expect(css).not.toContain("box-shadow: inset 3px 0 0 var(--primary)");
    expect(css).toContain(".sas-app a.sas-inbox__row:hover { background: var(--surface); }");
    expect(css).toContain(".sas-app a.sas-inbox__row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }");
    // The open conversation still says the channel, the market and that it is simulated.
    const thread = html.slice(html.indexOf('class="sas-panel sas-inbox__thread"'));
    expect(thread).toContain("Simulated");
    expect(thread).toMatch(/Israel · /);
  });

  it("the open conversation's header: name first, then business, each isolated, in a left-to-right title", async () => {
    const html = await render(account.slug, { c: ids.ronit });
    save("selected-he", html);
    expect(html).toMatch(/<strong data-thread-title="" dir="ltr" style="[^"]*"><bdi class="sas-title-part" dir="auto">רונית דמו<\/bdi> · <bdi class="sas-title-part" dir="auto">מאפיית דמו רמת גן<\/bdi><\/strong>/);
    expect(css).toContain(".sas-title-part { display: inline-block; max-width: 100%; unicode-bidi: isolate; }");
  });

  it("a Hebrew name row: each part isolated, the message in its own direction, the row left-aligned", async () => {
    const html = await render(account.slug);
    save("all-he", html);
    const ronit = rowOf(html, "רונית דמו");
    // Line 1, left to right whatever the script: the bold name, the separator, the business, each isolated.
    const nameLine = '<span class="sas-inbox__name" dir="ltr" data-line="1"><bdi dir="auto" class="sas-inbox__person">רונית דמו</bdi><span class="sas-inbox__sep"> · </span><bdi dir="auto" class="sas-inbox__company">מאפיית דמו רמת גן</bdi></span>';
    expect(ronit).toContain(nameLine);
    expect(ronit.indexOf("sas-inbox__person")).toBeLessThan(ronit.indexOf("sas-inbox__company"));
    expect(css).toContain(".sas-inbox__name bdi { unicode-bidi: isolate; }");
    // Line 2: "You:" first, then the Hebrew message isolated, cut at a word so its START shows (no "…" after "You:");
    // the whole message is in the title.
    expect(ronit).toContain('title="You: היי רונית, כאן הצוות של פולאר דמו"><span class="sas-inbox__preview-who">You:</span> <bdi class="sas-inbox__preview-text" dir="auto">היי רונית, כאן הצוות של פולאר</bdi></span>');
    expect(ronit).not.toContain("…");
    expect(ronit).not.toMatch(/ dir="rtl"/);
    expect(css).toMatch(/\.sas-app a\.sas-inbox__row \{[^}]*text-align: start; \}/);
    expect(css).toMatch(/\.sas-inbox__name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  });

  it("the views menu and the sort menu share one line; each list is as wide as its button and kept in the screen", async () => {
    expect(css).toContain(".sas-inbox__bar { display: flex; gap: var(--space-2); min-width: 0; }");
    expect(css).toContain(".sas-inbox__menu--view { flex: 1 1 auto; }");
    expect(css).toContain(".sas-inbox__menu .sas-rowmenu__list { inset-inline-start: 0; inset-inline-end: auto; min-width: 0; width: 100%; box-sizing: border-box; }");
    expect(css).not.toContain(".sas-inbox__menu--view .sas-rowmenu__list");
    const list = listOf(await render(account.slug));
    expect(list).toContain('data-inbox-view="" data-menu-match="trigger"');
    expect(list).toContain('data-inbox-sort="" data-menu-match="trigger"');
    // MenuEnhancer, while open: the trigger's width, at its edge, inside a 16px gutter.
    const kit = fs.readFileSync(path.join(process.cwd(), "components/sas/list-kit-client.tsx"), "utf8");
    expect(kit).toContain('if (details.dataset.menuMatch === "trigger") {');
    expect(kit).toContain("const w = Math.min(r.width, window.innerWidth - 32);");
    expect(kit).toContain("menu.style.left = `${Math.min(Math.max(16, rtl ? r.right - w : r.left), window.innerWidth - 16 - w)}px`;");
  });
});

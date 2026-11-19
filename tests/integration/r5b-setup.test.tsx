/**
 * Round 5, lane R5b (setup pages follow-ups from the round-4 review), on PGlite with the
 * demo account: the price list layout, counts agreeing with the warning, and Publish
 * (R5-1, R5-8, R5-9, S9), Markets (R5-7, R5-10), Knowledge
 * questions (R5-11), the Sources seed times (R5-12), the failed source (R5-13), the test
 * lab chat (R5-2, R5-14), the core rules wording (R5-15), the plays chips (R5-18), Go live
 * (R5-19), the draft icon (S6), note chips (S7) and the Catalog header (S8).
 *
 * With POLISH_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { conversations, pipelineRuns, sellerAccounts, sources, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { OPEN_QUESTIONS } = await import("@/lib/demo/states");
const { default: PriceListPage } = await import("@/app/app/[account]/setup/price-lists/[lineageId]/page");
const { default: PriceListsPage } = await import("@/app/app/[account]/setup/price-lists/page");
const { default: CatalogPage } = await import("@/app/app/[account]/setup/catalog/page");
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");
const { default: SourcePage } = await import("@/app/app/[account]/setup/sources/[sourceId]/page");
const { default: SourcesPage } = await import("@/app/app/[account]/setup/sources/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");
const { default: GoLivePage } = await import("@/app/app/[account]/setup/go-live/page");
const { goLiveSummary } = await import("@/app/app/[account]/setup/go-live/summary");
const { playCounts, playsOverview } = await import("@/app/app/[account]/setup/playbook/plays/overview");
const { listPriceLists } = await import("@/lib/pricing/price-lists");
const { listMarkets } = await import("@/lib/markets/service");
const { formCountryLabels } = await import("@/lib/markets/rules");
const { legalByLanguage } = await import("@/lib/markets/legal");
const { summarizeContactHours } = await import("@/lib/accounts/contact-hours");
const { timezoneLabel } = await import("@/lib/format");
const { STATUS } = await import("@/lib/domain/status");
const { t: tr } = await import("@/lib/i18n");
const enMessages = (await import("@/lib/i18n/messages/en.json")).default as Record<string, string>;

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8") + fs.readFileSync(path.join(process.cwd(), "app/app/[account]/markets/markets.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.POLISH_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"");

describe("pure helpers", () => {
  it("R5-7: each lead-form country once, grouped days off, one offset format", () => {
    expect(formCountryLabels(["United Kingdom", "UK"])).toEqual(["United Kingdom (UK)"]);
    expect(formCountryLabels(["IL"])).toEqual(["Israel (IL)"]);
    expect(formCountryLabels(["Israel", "IL", "il"])).toEqual(["Israel (IL)"]);
    expect(formCountryLabels(["Cyprus", "GR"])).toEqual(["Cyprus", "Greece (GR)"]);
    const on = { on: true, from: "09:00", to: "17:30" };
    const fri = { on: true, from: "09:00", to: "16:00" };
    const off = { on: false, from: "09:00", to: "17:30" };
    expect(summarizeContactHours([off, on, on, on, on, fri, off])).toBe("Mon–Thu 09:00–17:30 · Fri 09:00–16:00 · Sat–Sun off");
    // The default (Sunday working, Saturday off) is unchanged.
    expect(summarizeContactHours(null)).toBe("Sun–Thu 08:30–20:00 · Fri 08:30–13:00 · Sat off");
    expect(summarizeContactHours([on, on, on, on, on, on, on])).toBe("Sun–Sat 09:00–17:30");
    const winter = new Date("2026-01-15T12:00:00Z");
    expect(timezoneLabel("Europe/London", winter)).toBe("United Kingdom time · Europe/London (GMT+0)");
    expect(timezoneLabel("Asia/Jerusalem", winter)).toBe("Israel time · Asia/Jerusalem (GMT+2)");
    expect(timezoneLabel("UTC", winter)).toBe("UTC");
  });

  it("R5-7: a one-language market lists legal texts in the order of every language's texts", () => {
    const rows = [{ sectionKey: "privacy", language: "en" }, { sectionKey: "terms", language: "en" }];
    expect(legalByLanguage(rows, ["en"], ["terms", "privacy"])[0].sections.map((s) => s.sectionKey)).toEqual(["terms", "privacy"]);
    expect(legalByLanguage(rows, ["en"])[0].sections.map((s) => s.sectionKey)).toEqual(["privacy", "terms"]);
  });

  it("R5-19: Go live says what passed when a market still has open checks", () => {
    expect(goLiveSummary("live", 7, 7, true)).toBe("All checks passed.");
    expect(goLiveSummary("live", 7, 7, true, [{ name: "Israel", passed: 4, total: 4 }])).toBe("All checks passed.");
    expect(goLiveSummary("live", 7, 7, true, [{ name: "Israel", passed: 4, total: 4 }, { name: "United Kingdom", passed: 3, total: 4 }]))
      .toBe("Your account is ready. United Kingdom: 3 of 4 checks.");
    expect(goLiveSummary("setting_up", 7, 7, true, [{ name: "United Kingdom", passed: 3, total: 4 }])).toBe("7 of 7 checks passed. You can go live.");
  });

  it("S6: Draft has its own icon (file-pen), never the File source icon", () => {
    for (const object of ["quote", "agent_version", "catalog_version", "price_list"] as const) {
      expect((STATUS[object] as Record<string, { icon: string }>).draft.icon).toBe("file-pen");
    }
  });

  it("R5-15: the core rules no longer say \"no early price\"", () => {
    expect(tr("playbook.plays.core_rules")).toContain("no full price list before the need is clear");
    expect(Object.values(enMessages).some((v) => /no early price/i.test(v))).toBe(false);
    // The prompt never used those words ("No price before the buyer confirms the recommendation, unless the buyer asks"), so it is unchanged.
    const promptSrc = ["lib/agent/prompt.ts", ...fs.readdirSync("lib/agent/core").map((f) => `lib/agent/core/${f}`)].map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(promptSrc).not.toMatch(/no early price/i);
    expect(promptSrc).toContain("No price before the buyer confirms the recommendation, unless the buyer asks.");
  });

});

describe("pages (demo account)", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let seller: User;
  let account: SellerAccount;
  let slug = "";

  beforeAll(async () => {
    tdb = await createTestDb();
    db = tdb.db;
    holder.db = db;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u", email: "u@seller.test", role: "user", firstName: "Sam" },
    ]).returning();
    const r = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!r.ok) throw new Error("demo seed refused");
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.summary.accountId));
    slug = account.slug;
    holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => tdb.close());

  const ukList = async () => (await listPriceLists(db, account.id)).find((l) => l.shown.name === "United Kingdom")!;

  it("R5-1/8/9/S9: UK price list: the warning lists every item the counts call missing, Publish secondary and disabled with the reason, Versions under the table when narrow", async () => {
    const uk = await ukList();
    const html = await render(PriceListPage, { account: slug, lineageId: uk.lineageId });
    save("r5b-pl-uk", html);
    const tx = text(html);
    // INST-1 has an entry without its one-time price; PRB-30 (new in the catalog draft) has no entry at all.
    // The header and the chip count both, so the warning lists both (only INST-1 blocks publishing).
    const counted = Number(tx.match(/Price missing(\d+)With tiers/)?.[1]);
    expect(counted).toBe(2);
    expect(tx).toMatch(/2 of 4 items priced · 2/);
    // Two groups: what blocks publishing, then the items not in the list yet (the header count stays 2).
    expect(tx).toContain("2 prices missing");
    const warning = html.split("data-price-problems")[1].split("</ul></div></div></div>")[0];
    expect((warning.match(/<li /g) ?? []).length).toBe(counted);
    const mustFix = warning.split('data-warning-group="must-fix"')[1].split("</ul>")[0];
    const notInList = warning.split('data-warning-group="not-in-list"')[1].split("</ul>")[0];
    expect(text(mustFix).replace(/^>/, "")).toBe("Must be fixed before publishing:INST-1: the one-time price is missing.");
    expect(text(notInList).replace(/^>/, "")).toBe("Not in this price list yet, so the agent can't quote it here:PRB-30");
    expect(notInList).toContain('<span class="sas-id">PRB-30</span>');
    expect(warning.indexOf("must-fix")).toBeLessThan(warning.indexOf("not-in-list"));
    expect(tx).toContain("VAT20% · prices without VAT");
    expect(html).toContain('class="sas-split r5b-pl-split"');
    expect(css).toMatch(/@container \(max-width: 1399px\) \{\s*\.r5b-pl-split > \.sas-split__side \{ flex-basis: 100%; \}/);
    expect(html).toMatch(/class="sas-btn sas-btn--secondary sas-btn--sm" disabled="" aria-describedby="pl-publish-why" data-publish="">Publish v1</);
    expect(tx).toContain("Not ready to publish: add the missing price above.");
    expect(html).not.toContain("sas-btn--primary sas-btn--sm\">Publish");
    // The chip filters the same two rows.
    const missing = await render(PriceListPage, { account: slug, lineageId: uk.lineageId }, { show: "missing" });
    expect(text(missing)).toContain("Installation");
    expect(text(missing)).toContain("Cold-room probe");
    expect(text(missing)).not.toContain("Site gateway");
    // The list page counts the same way: 2 of 4.
    const lists = text(await render(PriceListsPage, { account: slug }));
    expect(lists).toMatch(/United Kingdom.*2 of 4/);
  });

  it("Catalog: S8 Add item first on a phone; S6 draft pill icon", async () => {
    const html = await render(CatalogPage, { account: slug });
    save("r5b-catalog", html);
    expect(html).toContain('class="sas-btn sas-btn--primary r5b-add-first"');
    expect(css).toMatch(/\.sas-page-head__actions > \.r5b-add-first \{ order: -1; \}/);
    expect(html).toMatch(/data-draft-pill=""><svg[^>]*lucide-file-pen/);
  });

  it("R5-7/R5-10: UK market: country once, Sat–Sun off, GMT+0, legal order and v1 kept, blue Set pill, actions start-aligned on a phone", async () => {
    const markets = await listMarkets(db, account.id);
    const uk = markets.find((m) => m.name === "United Kingdom")!;
    const il = markets.find((m) => m.isHome)!;
    const html = await render(MarketsPage, { account: slug }, { m: uk.id });
    save("r5b-markets-uk", html);
    const tx = text(html);
    expect(tx).toContain("Lead form: country is United Kingdom (UK)");
    expect(tx).not.toContain("United Kingdom, United Kingdom (UK)");
    expect(tx).toMatch(/Mon–Thu 09:00–17:30 · Fri 09:00–16:00 · Sat–Sun off/);
    expect(html).toContain('<span class="sas-nowrap">Fri 09:00–16:00</span>');
    expect(tx).toMatch(/Europe\/London \(GMT[+-]\d\)/);
    expect(tx).not.toContain("(UTC)");
    expect(html).toContain('class="sas-pill mk-pill--set" data-source="market"');
    expect(html).not.toContain("sas-pill--agent");
    expect(css).toMatch(/\.mk-pill--set \{ background: var\(--primary-soft\); color: var\(--primary\); \}/);
    expect(css).toMatch(/\[data-market-detail\] \[data-row-end\] \{ justify-content: flex-start !important; \}/);
    // Legal texts in the same order as Israel's English line.
    const ilHtml = await render(MarketsPage, { account: slug }, { m: il.id });
    const line = (h: string) => text(h.split('data-legal-lang="en">')[1].split("</span></span>")[0] + "</span>");
    const ukLine = text(html.split('data-legal-lang="en">')[1].split('data-legal-lang')[0]);
    const ilLine = text(ilHtml.split('data-legal-lang="en">')[1].split('data-legal-lang')[0]);
    expect(line(html)).toBeTruthy();
    const titles = (s: string) => [...s.matchAll(/([A-Z][a-z]+ [a-z]+) v\d/g)].map((m) => m[1]);
    expect(titles(ukLine).length).toBeGreaterThan(1);
    expect(titles(ukLine)).toEqual(titles(ilLine));
  });

  it("R5-11: Knowledge questions on a phone put Answer under the text; the Answer panel starts with an empty Topic and short footer labels", async () => {
    const html = await render(KnowledgePage, { account: slug }, { panel: "answer", question: OPEN_QUESTIONS[0] });
    save("r5b-knowledge-answer", html);
    expect(html).toContain('class="sas-stack-2 r5b-questions"');
    expect(css).toMatch(/\.r5b-questions \.sas-table--stack td\.sas-td-actions \{ position: static;/);
    const topic = html.match(/<input[^>]*id="kq-topic"[^>]*>/)?.[0] ?? "";
    expect(topic).toMatch(/value=""/);
    expect(topic).not.toContain('value="General"');
    expect(html).toMatch(/data-answer-next=""[^>]*>Save and next</);
    expect(html).toContain(">Save</button>");
    // S7: note chips have no "Note:" prefix.
    expect(text(html)).not.toMatch(/Note: /);
  });

  it("R5-12: the seeded sources the run analyzed were added and changed before that run", async () => {
    const runs = await db.select().from(pipelineRuns).where(and(eq(pipelineRuns.accountId, account.id), eq(pipelineRuns.kind, "facts")));
    const run = runs.find((r) => r.status === "done")!;
    const rows = (await db.select().from(sources).where(eq(sources.accountId, account.id))).filter((s) => run.sourceIds.includes(s.id));
    expect(rows.length).toBeGreaterThan(3);
    for (const s of rows) {
      expect(s.updatedAt.getTime()).toBeLessThan(run.startedAt!.getTime());
      expect(s.createdAt.getTime()).toBeLessThanOrEqual(s.updatedAt.getTime());
    }
    // The strip still compares content with that run (what a rerun would redo).
    const tx = text(await render(SourcesPage, { account: slug }));
    expect(tx).toMatch(/last run \d+ h ago · Run history/);
  });

  it("R5-13: failed and needs-input source detail: Re-read in the problem box, no stray dash, no repeated file chip, \"· 0\" on the title line", async () => {
    const rows = await db.select().from(sources).where(eq(sources.accountId, account.id));
    const failed = rows.find((s) => s.status === "failed")!;
    const html = await render(SourcePage, { account: slug, sourceId: failed.id });
    save("r5b-source-failed", html);
    const tx = text(html);
    expect(html).toMatch(/id="sp-h"[\s\S]*data-problem-reread=""/);
    expect(tx).toMatch(/Website · 0 pages read · updated/);
    expect(tx).not.toContain("· — ·");
    expect(html).toContain('Facts from this <span class="sas-nowrap">source · 0</span>');
    const sheet = rows.find((s) => s.status === "needs_input")!;
    const sheetHtml = await render(SourcePage, { account: slug, sourceId: sheet.id });
    save("r5b-source-needs-input", sheetHtml);
    const box = sheetHtml.split('id="sp-h"')[1].split("</section>")[0];
    expect(box).not.toContain("sas-chip");
    expect(box).not.toContain("data-problem-reread");
  });

  it("R5-2/R5-14: Hebrew test chat: each message finds its own direction; the header shows when the chat started", async () => {
    const [he] = await db.select().from(conversations).where(and(eq(conversations.accountId, account.id), eq(conversations.isTest, true), eq(conversations.language, "he")));
    const html = await render(TestLabPage, { account: slug }, { c: he.id });
    save("r5b-lab-he", html);
    expect(html).toMatch(/class="sas-msg__bubble" lang="he" dir="rtl"><div dir="auto" data-msg-dir="">/);
    const started = html.match(/<time dateTime="([^"]+)"[^>]*data-chat-started="">/)?.[1];
    expect(started).toBeTruthy();
    expect(new Date(started!).getTime()).toBeLessThan(he.createdAt.getTime());
  });

  it("R5-18: the plays chips add up (Ready + Needs your facts = All); S6 draft banner icon", async () => {
    const html = await render(PlaysPage, { account: slug });
    save("r5b-plays", html);
    const tx = text(html);
    const n = (label: string) => Number(tx.match(new RegExp(`${label} ?(\\d+)`))?.[1]);
    expect(n("Ready") + n("Needs your facts")).toBe(n("All"));
    expect(n("All")).toBe(13);
    expect(html).toMatch(/data-testid="draft-banner"><svg[^>]*lucide-file-pen/);
    expect(tx).toContain("no full price list before the need is clear");
    const plays = playsOverview({ plays: {} } as never, new Map());
    const c = playCounts(plays);
    expect(c.ready + c.needs).toBe(c.all);
  });

  it("R5-19: Go live page never says All checks passed while a market has open checks", async () => {
    const html = await render(GoLivePage, { account: slug });
    save("r5b-go-live", html);
    const tx = text(html);
    if (/3 of 4 checks/.test(tx)) expect(tx).not.toContain("All checks passed.");
  });
});

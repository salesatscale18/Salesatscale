/**
 * Round 4, lane R4-2 (Sources and Knowledge, list kit, icons), on PGlite with the demo account:
 * the Analyze line agrees with Run history when no analysis has run (F3), "Not analyzed yet"
 * for a source no analysis looked at (F3), the save message (F3/B6), trash for Delete (B1),
 * the circled check on Approved (B2), source-type icons on Knowledge chips (B3), the note
 * chip and privacy wording on Source detail (C2), the Add fact panel (C5, E4), the delete
 * confirm naming the fact (D7) and the toolbars inside the table cards (D5).
 *
 * With POLISH_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { knowledgeFacts, pipelineRuns, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
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
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { default: SourcesPage } = await import("@/app/app/[account]/setup/sources/page");
const { default: SourcePage } = await import("@/app/app/[account]/setup/sources/[sourceId]/page");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");
const { changeText } = await import("@/app/app/[account]/setup/sources/analyze");
const { planAnalysis, sourceDisplayStatus, analysisSummary } = await import("@/lib/pipeline/service");
const { addNote } = await import("@/lib/sources/service");
const { factLead, sourceChipIcon } = await import("@/lib/knowledge/facts-list");
const { ConfirmDelete, ListTable, RowMenu } = await import("@/components/sas/list-kit");
const { t: tr } = await import("@/lib/i18n");
const enMessages = (await import("@/lib/i18n/messages/en.json")).default as Record<string, string>;

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.POLISH_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"");

describe("pure helpers", () => {
  it("a read source no analysis looked at shows Not analyzed yet; changed sources with facts stay Ready for review", () => {
    expect(sourceDisplayStatus("ready", undefined, { changed: true })).toBe("not_analyzed");
    expect(sourceDisplayStatus("ready", { suggested: 0, approved: 0, total: 0 }, { changed: true })).toBe("not_analyzed");
    expect(sourceDisplayStatus("ready", { suggested: 0, approved: 0, total: 2 }, { changed: true })).toBe("ready"); // rejected facts only
    expect(sourceDisplayStatus("ready", { suggested: 0, approved: 2 }, { changed: true })).toBe("ready");
    expect(sourceDisplayStatus("ready", undefined)).toBe("ready"); // analyzed, nothing found
    expect(sourceDisplayStatus("processing", undefined, { changed: true })).toBe("processing");
    expect(sourceDisplayStatus("failed", undefined, { changed: true })).toBe("failed");
    expect(tr("status.source.not_analyzed")).toBe("Not analyzed yet");
  });

  it("the Analyze line never speaks of a last run before one finished", () => {
    const base = { changed: 0, sources: [{}, {}] as never, estimate: { costMicros: 150_000 } as never, facts: { hash: "f", reuse: false }, playbook: { hash: "p", reuse: false } };
    expect(changeText({ ...base, firstRun: true })).toBe("Your sources have not been analyzed yet");
    expect(changeText({ ...base, changed: 2, firstRun: true })).toBe("Your sources have not been analyzed yet");
    expect(changeText({ ...base, firstRun: false })).toBe("We improved the analysis since your last run");
    expect(analysisSummary({ ...base, firstRun: true }).rulesChanged).toBe(false);
  });

  it("names a fact by its first words, and picks the source-type icon for a chip", () => {
    expect(factLead("Warranty is 24 months.")).toBe("Warranty is 24 months.");
    expect(factLead("The sensor works for two years on one battery and reports every minute")).toBe("The sensor works for two years on one…");
    expect(factLead("A".repeat(90))).toHaveLength(61);
    expect(["website", "file", "text", "call", null].map(sourceChipIcon)).toEqual(["globe", "file-text", "sticky-note", "phone-call", "file-text"]);
  });

  it("seller strings say analyze, never analyse", () => {
    expect(Object.entries(enMessages).filter(([, v]) => /analys(e|ed|es|ing)\b/i.test(v))).toEqual([]);
  });
});

describe("list kit: Delete uses the trash icon", () => {
  it("row menu danger items and the confirm button show trash, never the circle-x", () => {
    const menu = renderToStaticMarkup(<RowMenu label="More" items={[{ label: "Edit", href: "/e", icon: "pencil" }, { label: "Delete", href: "/d", icon: "x-circle", danger: true }]} />);
    expect(menu).toMatch(/sas-rowmenu__item--danger"[^>]*><svg[^>]*lucide-trash/);
    expect(menu).not.toContain("lucide-circle-x");
    const confirm = renderToStaticMarkup(<ConfirmDelete title="Delete it?" action="/x" cancelHref="/">Gone.</ConfirmDelete>);
    expect(confirm).toMatch(/sas-btn--danger-solid"><svg[^>]*lucide-trash/);
  });

  it("ListTable puts the toolbar inside the card, above the table", () => {
    const html = renderToStaticMarkup(<ListTable caption="Rows" toolbar={<span data-bar="" />}><tbody /></ListTable>);
    expect(html).toMatch(/^<div class="sas-panel sas-listtable"><div class="sas-listtable__bar"><span data-bar=""><\/span><\/div><div class="sas-listtable__scroll">/);
  });
});

describe("pages (demo account)", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let seller: User;
  let account: SellerAccount;

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
    holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => tdb.close());

  it("Sources: without a finished run the strip and Run history agree; a new note is Not analyzed yet", async () => {
    const runs = await db.select().from(pipelineRuns).where(eq(pipelineRuns.accountId, account.id));
    const note = await addNote(db, { userId: seller.id, actingAs: false }, account.id, { title: "Opening hours", body: "We answer from 8 to 18." });
    const plan = await planAnalysis(db, account.id);
    const html = await render(SourcesPage, { account: account.slug });
    save("r4-2-sources", html);
    const s = text(html);
    if (!runs.some((x) => x.kind === "facts" && x.status === "done")) {
      expect(plan!.firstRun).toBe(true);
      expect(s).toContain("Your sources have not been analyzed yet");
      expect(s).not.toContain("since your last run");
    }
    expect(s).toContain("Not analyzed yet");
    expect(html).toMatch(new RegExp(`href="/app/${account.slug}/setup/sources/${note.id}"`));
    // D5: one primary button in the header row (Analyze); Review knowledge is an outline button.
    expect(html).toMatch(/class="sas-btn sas-btn--secondary[^"]*"[^>]*data-review-knowledge=""/);
    expect(html).toMatch(/<div class="sas-listtable__bar">.*role="search"/);
    // B1: the row menu's Delete has the trash icon.
    expect(html).toMatch(/sas-rowmenu__item--danger"[^>]*><svg[^>]*lucide-trash/);
    // B2: Approved is the circled check.
    if (s.includes("Approved")) expect(html).not.toMatch(/lucide-check"[^>]*>(?:(?!<\/span>).)*<\/svg>Approved/);
  });

  it("Sources: after a finished facts run the strip no longer says not analyzed", async () => {
    await db.insert(pipelineRuns).values({ id: crypto.randomUUID(), accountId: account.id, kind: "facts", status: "done", inputHash: "old" });
    const plan = await planAnalysis(db, account.id);
    expect(plan!.firstRun).toBe(false);
    expect(changeText(plan!)).not.toBe("Your sources have not been analyzed yet");
  });

  it("Source detail of a note: no lowercase note chip, no repeated title, one Knowledge link; Saved message", async () => {
    const note = await addNote(db, { userId: seller.id, actingAs: false }, account.id, { title: "Warranty", body: "Warranty is 24 months." });
    await db.insert(knowledgeFacts).values({ id: crypto.randomUUID(), accountId: account.id, topic: "General", statement: "Warranty is 24 months.", status: "approved", sourceId: note.id, sourceLocator: "note" });
    const html = await render(SourcePage, { account: account.slug, sourceId: note.id }, { done: "saved" });
    save("r4-2-source-note", html);
    const s = text(html);
    expect(s).toContain("Saved. Run Analyze sources to update its facts.");
    expect(html).not.toMatch(/sas-chip--plain[^>]*>note</);
    expect(html).not.toMatch(/<strong dir="auto"[^>]*>Warranty<\/strong>/);
    const factsCard = html.slice(html.indexOf("aria-labelledby=\"sf-h\""));
    expect(factsCard.slice(0, factsCard.indexOf("</section>")).match(/href="\/app\/[^"]+\/setup\/knowledge"/g)).toHaveLength(1);
    expect(s).toContain("Review knowledge");
  });

  it("Knowledge: source-type chip icons, toolbar in the card, Add fact topic, delete confirm names the fact", async () => {
    const [f] = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, account.id)).limit(1);
    const html = await render(KnowledgePage, { account: account.slug }, { confirm: f.id });
    save("r4-2-knowledge", html);
    expect(html).toMatch(/<div class="sas-listtable__bar">.*role="search"/);
    expect(text(html)).toContain(`Delete “${factLead(f.statement)}”?`);
    expect(html).toMatch(/sas-btn--danger-solid"><svg[^>]*lucide-trash/);
    const chips = html.match(/data-source-chip="" data-kind="(\w+)"><svg[^>]*class="lucide lucide-([\w-]+)/g) ?? [];
    for (const c of chips) {
      const [, kind, icon] = c.match(/data-kind="(\w+)"><svg[^>]*class="lucide lucide-([\w-]+)/)!;
      expect(icon).toBe({ website: "globe", file: "file-text", text: "sticky-note", call: "phone-call" }[kind]);
    }
    const add = await render(KnowledgePage, { account: account.slug }, { panel: "new" });
    save("r4-2-knowledge-add", add);
    expect(add).toMatch(/id="kf-topic"[^>]*value=""|id="kf-topic"(?![^>]*value=)[^>]*placeholder="Choose or type a topic"/);
    expect(add).toContain("Choose or type a topic");
    expect(add).toMatch(/sas-combo__arrow/);
    expect(text(add)).toContain("Shown to your team, not to buyers.");
    const topic = (await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, account.id)).limit(1))[0].topic;
    const inTopic = await render(KnowledgePage, { account: account.slug }, { panel: "new", topic });
    expect(inTopic).toMatch(new RegExp(`id="kf-topic"[^>]*value="${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  });
});

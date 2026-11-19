/**
 * Live-review polish, lane Polish-7b (plain terms and nav icons), on PGlite with the demo account:
 * time zones and currencies in words, the model line only for platform admins, the
 * Analyze estimate line, catalog rule sentences, Markets routing / home market / legal
 * versions, order form legal versions and knowledge source chips.
 *
 * With POLISH_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq, sql } from "drizzle-orm";
import { markets, sellerAccounts, sourceSections, sources, users, type SellerAccount, type User } from "@/db/schema";
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
const { default: CompanyPage } = await import("@/app/app/[account]/setup/company/page");
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");
const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");
const { default: OrderFormSetupPage } = await import("@/app/app/[account]/setup/order-form/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { default: SourcesPage } = await import("@/app/app/[account]/setup/sources/page");
const { default: CatalogPage } = await import("@/app/app/[account]/setup/catalog/page");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");
const { default: PriceListsPage } = await import("@/app/app/[account]/setup/price-lists/page");
const { default: GoLivePage } = await import("@/app/app/[account]/setup/go-live/page");
const { changeText, estimateText } = await import("@/app/app/[account]/setup/sources/analyze");
const { planAnalysis } = await import("@/lib/pipeline/service");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.POLISH_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, slug: string, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");

describe("Polish-7b: plain terms", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let seller: User;
  let account: SellerAccount;
  const asSeller = () => { holder.access = { account, user: seller, actingAs: false, role: "seller_admin" }; };
  const asAdmin = () => { holder.access = { account, user: admin, actingAs: true, role: "platform_admin" }; };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u", email: "u@seller.test", role: "user", firstName: "Sam" },
    ]).returning();
    const r = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!r.ok) throw new Error("demo seed refused");
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.summary.accountId));
    await db.update(markets).set({ formCountryValues: ["IL"] }).where(and(eq(markets.accountId, account.id), eq(markets.isHome, true)));
    asSeller();
  }, 120_000);
  afterAll(async () => t.close());

  it("Company: time zone and currency in words", async () => {
    const html = await render(CompanyPage, account.slug);
    save("company", html);
    expect(text(html)).toMatch(/Israel time · Asia\/Jerusalem \(GMT\+[23]\)/);
    expect(text(html)).toContain("ILS · Israeli shekel (₪)");
    expect(html).not.toMatch(/class="sas-num"[^>]*>ILS</);
  });

  it("Markets: zone, currency, routing with country names, Home market tag, legal versions in words", async () => {
    const html = await render(MarketsPage, account.slug);
    save("markets", html);
    const s = text(html);
    expect(s).toMatch(/Israel time · Asia\/Jerusalem \(GMT\+[23]\)/);
    expect(s).toContain("ILS · Israeli shekel (₪)");
    expect(s).toContain("Lead form: country is Israel (IL)");
    expect(html).toMatch(/<span class="sas-pill"[^>]*data-home-market="">Home market</);
    expect(html).not.toContain('class="sas-chip"');
    // R5-7: "v1" stays with its title (no-break space).
    expect(s).toMatch(/English · .+\u00a0v1/);
    expect(s).not.toMatch(/\bEN v1\b/);
    // R4 D6: row actions all as ghost buttons; legal texts not changed for the market say "Change for this market";
    // the price list button says what it saves.
    expect(html).not.toMatch(/<a class="sas-small" href="[^"]*(edit=where|order-form\?market)/);
    expect(html).toMatch(/<a class="sas-btn sas-btn--ghost sas-btn--sm" href="[^"]*order-form\?market=[^"]*" data-row-action="" data-legal-action="">Change for this market<\/a>/);
    expect(s).toContain("Save price list");
    // E8: legal texts listed in the selling-language order (English, then Hebrew).
    expect(html.indexOf('data-legal-lang="en"')).toBeLessThan(html.indexOf('data-legal-lang="he"'));
    // While the holidays editor is open the row shows no "None" above it.
    const hol = await render(MarketsPage, account.slug, { override: "holidays" });
    const holRow = (h: string) => h.split('id="set-holidays"')[1].split("</div>")[0];
    expect(holRow(html)).toContain("None");
    expect(holRow(hol)).toContain("Holidays");
    expect(holRow(hol)).not.toContain("None");
    // The zone select names every zone the same way.
    const tz = await render(MarketsPage, account.slug, { override: "timezone" });
    save("markets-timezone", tz);
    expect(text(tz)).toMatch(/Eastern time · America\/New_York \(GMT-[45]\)/);
  });

  it("Settings › Payments: currency in words, normal font; the AI usage note", async () => {
    const html = await render(SettingsPage, account.slug, { section: "payments" });
    save("settings-payments", html);
    expect(text(html)).toContain("ILS · Israeli shekel (₪)");
    expect(text(html)).toContain("An estimate based on how much the AI reads and writes.");
  });

  it("Price lists: the currency select reads in words", async () => {
    const html = await render(PriceListsPage, account.slug, { new: "1" });
    save("price-lists", html);
    expect(html).toContain(">ILS · Israeli shekel (₪)</option>");
    expect(html).toContain(">USD · US dollar ($)</option>");
  });

  it("Order form setup: legal versions as readable links", async () => {
    const html = await render(OrderFormSetupPage, account.slug);
    save("order-form", html);
    // A version link opens that language's text in the legal panel (list-page redesign).
    expect(html).toMatch(/<a data-legal-version="en\.1"[^>]*href="[^"]*panel=legal%3A[a-z_]+&amp;lang=en">English · v1<\/a>/);
    expect(html).toMatch(/>Hebrew · v1</);
    expect(html).not.toMatch(/>EN v1</);
    const [home] = await db.select().from(markets).where(eq(markets.accountId, account.id));
    const m = await render(OrderFormSetupPage, account.slug, { market: home.id });
    save("order-form-market", m);
    expect(m).toMatch(/data-legal-version="en\.1"[^>]*>English · v1</);
    // R4 D13: the Preview heading, "Brand colour" with the hex code secondary.
    expect(html).toMatch(/<h2 id="ofs-prev-h" class="sas-heading">Preview<\/h2>/);
    expect(text(html)).toContain("Brand colour");
    expect(html).toMatch(/<span class="sas-small sas-num" data-brand-hex="">#[0-9a-f]{6}<\/span>/);
    // The legal panel of an existing text shows its language as plain text.
    const key = /panel=legal%3A([a-z_]+)&amp;lang=en/.exec(html)![1];
    const panel = await render(OrderFormSetupPage, account.slug, { panel: `legal:${key}`, lang: "he" });
    expect(panel).toMatch(/<span id="ls-lang" data-lang-fixed="">Hebrew<\/span>/);
    expect(panel).not.toMatch(/id="ls-lang"[^>]*readOnly|<input[^>]*id="ls-lang"/i);
  });

  it("Versions and test lab: the model line only for platform admins", async () => {
    const sellerHtml = await render(TestLabPage, account.slug);
    save("test-lab-seller", sellerHtml);
    expect(sellerHtml).not.toContain("data-version-model");
    expect(sellerHtml).not.toContain("effort");
    asAdmin();
    const adminHtml = await render(TestLabPage, account.slug);
    asSeller();
    expect(adminHtml).toContain("data-version-model");
    expect(text(adminHtml)).toMatch(/· effort /);
    // The "Edit playbook" button uses the playbook's nav icon.
    expect(sellerHtml).toMatch(/lucide-scroll-text[\s\S]{0,800}Edit playbook/);
  });

  it("Sources › Analyze: the estimate line in both cases, no tokens, secondary button when nothing changed", async () => {
    const html = await render(SourcesPage, account.slug);
    save("sources-nothing-changed", html);
    // The line and the button follow the same reuse decision as the confirm step (UX follow-up).
    const plan = (await planAnalysis(db, account.id))!;
    // The strip (redesign R3-3): what changed, then the estimated cost in the account currency.
    expect(text(html)).toContain(changeText(plan));
    expect(html).toContain(`data-analyze-button="${plan.facts.reuse && plan.playbook.reuse ? "secondary" : "primary"}"`);
    expect(text(html)).not.toMatch(/about [\d,]+ tokens/);
    // A source the analysis reads (the demo also has a failed one and one that needs input).
    const [one] = await db.select().from(sources).where(and(eq(sources.accountId, account.id), eq(sources.status, "ready"))).limit(1);
    // Its text changed (the demo seed records the analysis that read the old text, so a changed hash alone is not enough).
    await db.update(sources).set({ textHash: null }).where(eq(sources.id, one.id));
    await db.update(sourceSections).set({ text: sql`${sourceSections.text} || ' (edited)'` }).where(eq(sourceSections.sourceId, one.id));
    const changed = await render(SourcesPage, account.slug);
    save("sources-changed", changed);
    // Before any finished run the line says so (R4 F3); after one (the demo seeds one) it names what changed.
    const changedPlan = (await planAnalysis(db, account.id))!;
    expect(text(changed)).toContain(changeText(changedPlan));
    if (!changedPlan.firstRun) expect(text(changed)).toContain(`Changed since the last analysis: ${plan.changed + 1} of ${plan.sources.length} sources`);
    else expect(text(changed)).not.toContain("since your last run");
    // B4: the same unit as Settings › AI usage (the demo account is in shekels).
    expect(text(changed)).toMatch(/Estimated cost ₪\d+\.\d{2,3}/);
    expect(changed).toContain('data-analyze-button="primary"');
    // The confirm step stays (shown once AI is set up: a dummy key, no model is called while rendering).
    vi.stubEnv("ANTHROPIC_API_KEY", "test-dummy-not-used");
    const confirm = await render(SourcesPage, account.slug, { analyze: "confirm" }).finally(() => vi.unstubAllEnvs());
    expect(text(confirm)).toContain("Start analysis");
    // Pure text, both cases.
    const base = { changed: 0, sources: [{}, {}, {}], estimate: { costMicros: 150_000 }, facts: { reuse: true }, playbook: { reuse: true } };
    expect(estimateText(base as never)).toBe("Nothing changed since the last analysis. Running it again reuses the results at no cost.");
    expect(estimateText({ ...base, changed: 2, facts: { reuse: false }, playbook: { reuse: false } } as never)).toBe("Changed since the last analysis: 2 of 3 sources · estimated cost $0.15");
    expect(estimateText({ ...base, playbook: { reuse: false } } as never)).toBe("Changed since the last analysis: catalog or playbook · estimated cost $0.15");
    // B4: only the analysis itself changed.
    expect(estimateText({ ...base, facts: { reuse: false }, playbook: { reuse: false } } as never)).toBe("We improved the analysis since your last run · estimated cost $0.15");
    expect(changeText({ ...base, facts: { reuse: false }, playbook: { reuse: false } } as never)).toBe("We improved the analysis since your last run");
    expect(estimateText({ ...base, changed: 2, facts: { reuse: false }, playbook: { reuse: false } } as never, "ILS")).toBe("Changed since the last analysis: 2 of 3 sources · estimated cost ₪0.56");
  });

  it("Catalog: rule sentences name the item first, codes never wrap; the form labels and tick boxes", async () => {
    const html = await render(CatalogPage, account.slug);
    save("catalog", html);
    const rules = [...html.matchAll(/data-rule-text="">([\s\S]*?)<\/span><\/span>|data-rule-text="">([\s\S]*?)<\/span>/g)].map((m) => text(m[0]));
    expect(rules.join("\n")).toMatch(/When a quote has [^(\n]+ \(GW-10\), add [^(\n]+ \(INST-1\) × number of sites\./);
    expect(html).toMatch(/<span class="sas-nowrap">\(GW-10\)<\/span>/);
  });

  it("Knowledge: source chips in words", async () => {
    const html = await render(KnowledgePage, account.slug);
    save("knowledge", html);
    expect(html).toContain("sas-chip sas-chip--plain");
    expect(html).toMatch(/data-kind="text"><svg[^>]*lucide-sticky-note/);
    expect(text(html)).not.toMatch(/Note: /);
    expect(text(html)).toMatch(/Call · \d{2}:\d{2}/);
    expect(text(html)).not.toMatch(/· note\b/);
  });

  it("Side nav: one icon per meaning", async () => {
    const { SideNav } = await import("@/components/sas/nav");
    const html = renderToStaticMarkup(<SideNav mode="seller" basePath="/app/x" active="playbook" accountName="Polar" user={{ name: "Sam", initials: "S" }} />);
    save("nav", html);
    for (const icon of ["scroll-text", "file-signature", "tags"]) expect(html).toContain(`lucide-${icon}`);
    expect(html).not.toContain("lucide-sparkles");
    expect(html).not.toContain("lucide-pen ");
    expect(html).not.toContain("lucide-credit-card");
  });

  it("Go live: Home market as a neutral tag", async () => {
    const html = await render(GoLivePage, account.slug);
    save("go-live", html);
    if (html.includes("data-home-market")) expect(html).toMatch(/class="sas-pill"[^>]*data-home-market="">Home market</);
  });
});


/**
 * Polish-6 (Playbook navigation and polish) against the database, rendered:
 * the Playbook home and part menu, the questions list and stepper, the sales goal labels,
 * approved exceptions, the never-do "Covered by Limits" note, the
 * platform-fixed boxes, the draft banner on every Playbook page, the play
 * card footers and named empty slots, the breadcrumb and Company's agent
 * introduction. No model is called.
 *
 * With PB_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { users, type SellerAccount, type User } from "@/db/schema";
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

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { ensureDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { default: PlaybookPage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");
const { default: PlayPage } = await import("@/app/app/[account]/setup/playbook/plays/[play]/page");
const { default: DraftPage } = await import("@/app/app/[account]/setup/playbook/draft/page");
const { default: CompanyPage } = await import("@/app/app/[account]/setup/company/page");

describe("Playbook navigation and polish (rendered)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount, other: SellerAccount;
  const css = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  const save = (name: string, html: string) => {
    const dir = process.env.PB_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
  };
  type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
  const render = async (Page: Page, a: SellerAccount, params: Record<string, string> = {}) => {
    holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" };
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ account: a.slug, ...params }), searchParams: Promise.resolve({}) }));
  };

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-p6", email: "p6@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const mk = async (tradeName: string) => {
      const p = parseCreateAccount({ tradeName, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `o@${tradeName.toLowerCase()}.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    };
    acc = await mk("Acme");
    other = await mk("Other");
    const d = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, {
      ...d.playbook, agentName: "Maya", maxDiscountBp: 500,
      fields: [
        { key: "sites", label: "Number of sites", stage: "before_quote", example: "Is it one kitchen, or more? And how many fridges and freezers are there in each of them, roughly?" },
        { key: "today", label: "How they check today", stage: "optional", example: "How do you check them today?" },
      ],
      neverDo: ["Never promise a discount above 5% without approval.", "Never invent product facts, prices or delivery dates."],
      exceptions: [{ id: "x1", text: "Installation is free from 3 sites", approvedAt: "2026-11-18T09:00:00.000Z", approvedBy: me.id }],
      plays: { too_expensive: { facts: [{ text: "We install in a day.", source: "Sales deck" }] } },
      opener: { topics: [{ en: "monitoring your fridge temperatures" }, { en: "automatic temperature logs for health inspections, kept for every site and every fridge" }], defaultTopic: 0, question: { en: "How do you check them today?" } },
    });
  });
  afterAll(async () => { await t.close(); });

  const partHtml = async (a: SellerAccount, name: string, sp: Record<string, string> = {}) => {
    holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" };
    return renderToStaticMarkup(await (PartPage as Page)({ params: Promise.resolve({ account: a.slug, part: name }), searchParams: Promise.resolve(sp) }));
  };

  it("Playbook home and parts: part menu, questions, stepper, goal, exceptions, never do, platform text, draft bar", async () => {
    const home = await render(PlaybookPage as Page, acc);
    save("playbook", home);
    // 1. Home: one row per part, in order, each a plain link to its part (works without JS).
    const order = ["agent", "opening", "asks", "plays", "objections", "close", "limits", "never", "after"];
    const at = order.map((p) => home.indexOf(`href="/app/acme/setup/playbook/${p}" data-part="${p}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(home).not.toContain("Objections and approved answers");
    expect(home).not.toContain("pb-main--spy");
    expect(home).not.toContain('data-testid="playbook-toc"');
    // In a part: the same parts in a menu (and a picker for phones), "All of the playbook" back home, the current one marked.
    const asks = await partHtml(acc, "asks");
    save("playbook-asks", asks);
    expect(asks).toContain('data-testid="part-menu"');
    expect(asks).toContain('data-testid="part-picker"');
    expect(asks).toMatch(/<a class="pb-menu__home" href="\/app\/acme\/setup\/playbook">.*All of the playbook<\/a>/);
    expect(asks).toMatch(/aria-current="page" data-part="asks"><span class="pb-menu__name">What it asks</);
    expect(asks).toContain('href="/app/acme/setup/playbook/plays"');
    // 2. What it asks: column "Question", "Where the answer is used", "Add question" after the list, the example in full on a second line.
    expect(asks).toContain(">Question</th>");
    expect(asks).toContain(">Where the answer is used</th>");
    expect(asks).not.toContain(">Field</th>");
    expect(asks).not.toContain(">Example question</th>");
    expect(asks.indexOf("Add question")).toBeGreaterThan(asks.indexOf('id="pb-field.1.label"'));
    expect(asks).toMatch(/<textarea[^>]*id="pb-field\.0\.example"[^>]*>Is it one kitchen, or more\? And how many fridges and freezers are there in each of them, roughly\?<\/textarea>/);
    // The role names stay; what each means is behind one link.
    expect(asks).toMatch(/<details class="pb-disclosure" data-testid="roles-disclosure"><summary>What each role means<\/summary>/);
    expect(asks.indexOf("What each role means")).toBeGreaterThan(asks.indexOf("Add question"));
    expect(asks).toMatch(/<details class="pb-disclosure"[^>]*><summary>How the count works<\/summary>/);
    // Stepper 2–6: at 3 both buttons work; icons, not text.
    expect(asks).toMatch(/data-testid="budget-stepper"><button type="button" aria-label="Fewer"><svg/);
    expect(asks).not.toMatch(/disabled="" aria-label="(Fewer|More)"/);
    // 3. How a deal closes: the Sales goal row with its helper; open, the goal grows; the ways a sale can end.
    const close = await partHtml(acc, "close");
    expect(close).toMatch(/<span class="pb-row__label" id="[^"]+">Sales goal<\/span>/);
    expect(close).toContain("In your words. The agent reads this first.");
    expect(close).toContain(">A sale can end with<");
    expect(await partHtml(acc, "close", { edit: "goal" })).toMatch(/<textarea class="sas-textarea pb-grow pb-grow--3 pb-fit-long" id="pb-goal"/);
    expect(await partHtml(acc, "close", { edit: "outcomes" })).toContain("A sale can end with</legend>");
    // Tone: one growing line, sized to its content.
    expect(await partHtml(acc, "agent", { edit: "tone" })).toMatch(/<textarea class="sas-textarea pb-grow pb-fit-line" id="pb-tone"/);
    // 4. Approved exception (Limits): neutral row, readable date.
    const limits = await partHtml(acc, "limits");
    expect(limits).toContain("Approved 18 Nov 2026");
    expect(limits).toContain('data-exception=""');
    expect(css).toMatch(/\.pb-exceptions li \{[^}]*background: var\(--surface-raised\)/);
    // 7. Never do: the discount rule that restates Limits is marked, the other is not.
    const never = await partHtml(acc, "never");
    save("playbook-never", never);
    expect(never.match(/Covered by Limits/g)?.length).toBe(1);
    expect(never).toContain("data-never-covered");
    // 6. Always-on rules (Never do) and the opener's fixed words (Opening): set by the platform.
    expect(never.match(/data-platform-fixed=""/g)?.length).toBe(1);
    expect((await partHtml(acc, "opening")).match(/data-platform-fixed=""/g)?.length).toBeGreaterThanOrEqual(1);
    expect(never).toContain("Set by the platform");
    // 5. The draft bar: file icon, not the flask (the flask stays on "Test in lab"); on home and every part.
    for (const html of [home, asks, close, limits, never]) expect(html).toMatch(/data-testid="draft-bar"[^>]*><span class="pb-draftbar__mark"><svg[^>]*lucide-file-pen/);
    // Phone header class.
    expect(home).toContain("sas-page-head__actions pb-head-actions");
  });

  it("budget at the minimum disables −, at the maximum disables +", async () => {
    const p = (await ensureDraftVersion(db, acc.id)).playbook;
    await saveDraftPlaybook(db, acc.id, { ...p, questionBudget: 2 });
    expect(await partHtml(acc, "asks")).toMatch(/disabled="" aria-label="Fewer"/);
    await saveDraftPlaybook(db, acc.id, { ...p, questionBudget: 6 });
    const html = await partHtml(acc, "asks");
    expect(html).toMatch(/disabled="" aria-label="More"/);
    expect(html).not.toMatch(/disabled="" aria-label="Fewer"/);
    await saveDraftPlaybook(db, acc.id, { ...p, questionBudget: 3 });
  });

  it("Sales plays: footers name the facts used or missing, the hand-off card points to Limits, the banner and filters", async () => {
    const html = await render(PlaysPage as Page, acc);
    save("plays", html);
    expect(html).toContain('data-testid="draft-bar"');
    // Too expensive: the seller's fact plus the filled discount limit (5%, kept in Limits) count (R3-6, A9).
    expect(html).toMatch(/2 facts<span[^>]*data-missing="">[^<]*add what the problem costs a typical customer, smaller starting set, what a discount can be traded for, what the price includes/);
    expect(html).toContain("Uses your hand-off rule in Limits");
    expect(html).toContain("Add approved comparison facts");
    expect(html).toContain("sas-views pb-filters");
    expect(html).toMatch(/All <span class="pb-count">19<\/span>/);
    expect(html).toMatch(/aria-current="page" data-part="plays"><span class="pb-menu__name">Sales plays</);
    // The other account's page is its own: no facts there.
    expect(await render(PlaysPage as Page, other)).not.toContain("1 fact<");
  });

  it("one play: breadcrumb links each underlined on their own, the draft bar, named empty slots above Add fact", async () => {
    const html = await render(PlayPage as Page, acc, { play: "too_expensive" });
    save("play", html);
    expect(html).toContain('data-testid="draft-bar"');
    expect(html).toMatch(/class="sas-small pb-crumbs"><a href="\/app\/acme\/setup\/playbook">Playbook<\/a><span aria-hidden="true">›<\/span><a href="\/app\/acme\/setup\/playbook\/plays">Sales plays<\/a>/);
    expect(html).toContain('data-slot="what the problem costs a typical customer"');
    expect(html).toContain('data-slot="smaller starting set"');
    expect(html).toContain("What the problem costs a typical customer");
    expect(html.indexOf('data-slot="smaller starting set"')).toBeLessThan(html.indexOf("Add fact"));
    // A play that needs no facts shows no slots.
    expect(await render(PlayPage as Page, acc, { play: "not_now" })).not.toContain("data-slot=");
  });

  it("draft from sources: the same draft bar", async () => {
    const html = await render(DraftPage as Page, acc);
    save("draft", html);
    expect(html).toContain('data-testid="draft-bar"');
  });

  it("Company: the real opening message (R4 A5), and the fixed disclosure says \"automated assistant\"", async () => {
    const html = await render(CompanyPage as Page, acc);
    save("company", html);
    expect(html).toContain("data-platform-fixed");
    // The text the agent sends, from the same builder (openerText), with a sample lead name.
    // The company name is its own bidi run in the preview (R5 item 4).
    expect(html).toMatch(/data-agent-intro="en"[^>]*>Hi Rina, this is Maya, the automated assistant of <bdi data-opener-company="">[^<]+<\/bdi>\. /);
    expect(html).not.toContain("automated agent");
    expect(html).toContain("The agent always says it is an automated assistant. This cannot be turned off.");
  });
});

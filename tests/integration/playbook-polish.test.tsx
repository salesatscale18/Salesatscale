/**
 * Polish-6 (Playbook navigation and polish) against the database, rendered:
 * the section list, the questions list and stepper, the sales goal labels,
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

  it("Playbook page: section list, questions, stepper, goal, exceptions, never do, platform text, banner", async () => {
    const html = await render(PlaybookPage as Page, acc);
    save("playbook", html);
    // 1. Section list: sticky (playbook.css), links work without JS, one name for the objections section.
    expect(html).toContain('data-testid="playbook-toc"');
    expect(html).toContain('href="#pb-never-h-s"');
    expect(html).toContain('href="/app/acme/setup/playbook/plays"');
    expect(html.match(/Objections and answers/g)?.length).toBe(2);
    expect(html).not.toContain("Objections and approved answers");
    expect(html).toContain("pb-main--spy");
    // 2. Questions: column "Question", "Add question" after the list, the example in full on a second line.
    expect(html).toContain(">Question</th>");
    expect(html).not.toContain(">Field</th>");
    expect(html).not.toContain(">Example question</th>");
    expect(html.indexOf("Add question")).toBeGreaterThan(html.indexOf('id="pb-field.1.label"'));
    expect(html).toMatch(/<textarea[^>]*id="pb-field\.0\.example"[^>]*>Is it one kitchen, or more\? And how many fridges and freezers are there in each of them, roughly\?<\/textarea>/);
    expect(html.indexOf("What each role means")).toBeGreaterThan(html.indexOf("Add question"));
    expect(html).toMatch(/<details class="pb-disclosure"[^>]*><summary>How the count works<\/summary>/);
    // Stepper 2–6: at 3 both buttons work; icons, not text.
    expect(html).toMatch(/data-testid="budget-stepper"><button type="button" aria-label="Fewer"><svg/);
    expect(html).not.toMatch(/disabled="" aria-label="(Fewer|More)"/);
    // 3. Sales goal label and helper, outcome group label, growing tone.
    expect(html).toMatch(/<label class="sas-input-label" for="pb-goal">Sales goal<\/label><span class="sas-hint" id="pb-goal-hint">In your words\. The agent reads this first\.<\/span>/);
    expect(html).toContain("How a deal can close</legend>");
    expect(html).toMatch(/<textarea class="sas-textarea pb-grow" id="pb-tone"/);
    // 4. Approved exception: neutral row, readable date.
    expect(html).toContain("Approved 18 Nov 2026");
    expect(html).toMatch(/data-exception="" style="[^"]*background:var\(--surface-raised\)/);
    // 7. The discount rule that restates Limits is marked, the other is not.
    expect(html.match(/Covered by Limits/g)?.length).toBe(1);
    expect(html).toContain('id="pb-never.0-covered"');
    // 6. Always-on rules and the opener's fixed words: set by the platform.
    expect(html.match(/data-platform-fixed=""/g)?.length).toBe(2);
    expect(html).toContain("Set by the platform");
    // 5/7. The draft banner: file icon, not the flask (the flask stays on "Test in lab").
    expect(html).toMatch(/data-testid="draft-banner"><svg[^>]*lucide-file-text/);
    // Phone header class (one full-width primary button).
    expect(html).toContain("sas-page-head__actions pb-head-actions");
  });

  it("budget at the minimum disables −, at the maximum disables +", async () => {
    const p = (await ensureDraftVersion(db, acc.id)).playbook;
    await saveDraftPlaybook(db, acc.id, { ...p, questionBudget: 2 });
    expect(await render(PlaybookPage as Page, acc)).toMatch(/disabled="" aria-label="Fewer"/);
    await saveDraftPlaybook(db, acc.id, { ...p, questionBudget: 6 });
    const html = await render(PlaybookPage as Page, acc);
    expect(html).toMatch(/disabled="" aria-label="More"/);
    expect(html).not.toMatch(/disabled="" aria-label="Fewer"/);
    await saveDraftPlaybook(db, acc.id, { ...p, questionBudget: 3 });
  });

  it("Sales plays: footers name the facts used or missing, the hand-off card points to Limits, the banner and filters", async () => {
    const html = await render(PlaysPage as Page, acc);
    save("plays", html);
    expect(html).toContain('data-testid="draft-banner"');
    // Too expensive: the seller's fact plus the filled discount limit (5%, kept in Limits) count (R3-6, A9).
    expect(html).toMatch(/2 facts<span[^>]*data-missing="">[^<]*add cost of the problem, smaller starting set/);
    expect(html).toContain("Uses your hand-off rule in Limits");
    expect(html).toContain("Add approved comparison facts");
    expect(html).toContain("sas-views pb-filters");
    expect(html).toMatch(/All <span class="pb-count">13<\/span>/);
    expect(html).toMatch(/aria-current="page"[^>]*>Sales plays/);
    // The other account's page is its own: no facts there.
    expect(await render(PlaysPage as Page, other)).not.toContain("1 fact<");
  });

  it("one play: breadcrumb links each underlined on their own, the banner, named empty slots above Add fact", async () => {
    const html = await render(PlayPage as Page, acc, { play: "too_expensive" });
    save("play", html);
    expect(html).toContain('data-testid="draft-banner"');
    expect(html).toMatch(/class="sas-small pb-crumbs"><a href="\/app\/acme\/setup\/playbook">Playbook<\/a><span aria-hidden="true">›<\/span><a href="\/app\/acme\/setup\/playbook\/plays">Sales plays<\/a>/);
    expect(html).toContain('data-slot="cost of the problem"');
    expect(html).toContain('data-slot="smaller starting set"');
    expect(html).toContain("Cost of the problem");
    expect(html.indexOf('data-slot="smaller starting set"')).toBeLessThan(html.indexOf("Add fact"));
    // A play that needs no facts shows no slots.
    expect(await render(PlayPage as Page, acc, { play: "not_now" })).not.toContain("data-slot=");
  });

  it("draft from sources: the same draft banner", async () => {
    const html = await render(DraftPage as Page, acc);
    save("draft", html);
    expect(html).toContain('data-testid="draft-banner"');
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

/**
 * Compare versions (board VersionCompare) on PGlite with the demo account, whose seed
 * (lib/demo/states.ts seedCompareDraft) holds a draft that differs from live and
 * scenario results on both. Covers the versions picked (defaults, any two, account
 * isolation), every diff kind and every scenario change kind of the seeded pair, the
 * notice, the same-version page and the entry in the test lab's Versions panel. No
 * model is called: the SDK is mocked to throw.
 *
 * With COMPARE_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, sellerAccounts, users, type AgentVersion, type SellerAccount, type User } from "@/db/schema";
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
  cookies: async () => ({ get: () => undefined, set: () => {}, getAll: () => [] }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { loadVersionComparison, pickVersions } = await import("@/lib/agent/version-compare");
const { default: ComparePage } = await import("@/app/app/[account]/setup/test-lab/compare/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");

const css = ["components/sas/sas.css", "app/app/[account]/setup/test-lab/compare/compare.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
const save = (name: string, html: string) => {
  const dir = process.env.COMPARE_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (page: Page, slug: string, sp: Record<string, string> = {}) => renderToStaticMarkup(await page({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) }));

describe("Compare versions", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User, seller: User;
  let account: SellerAccount;
  let live: AgentVersion, draft: AgentVersion;
  let otherVersionId: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa_cmp", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u_cmp", email: "u@seller.test", role: "user", firstName: "Sam" },
    ]).returning();
    const r = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!r.ok) throw new Error("demo seed refused");
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.summary.accountId));
    const r2 = await createDemoAccount(db, admin, { name: "Other Co", ownerEmail: "o@other.test" });
    if (!r2.ok) throw new Error("demo seed refused");
    otherVersionId = (await db.select().from(agentVersions).where(eq(agentVersions.accountId, r2.summary.accountId)))[0].id;
    holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
    [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "live")));
    [draft] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "draft")));
  }, 180_000);
  afterAll(async () => t.close());

  it("the demo seed holds a live version and a draft", () => {
    expect(live).toBeDefined();
    expect(draft).toBeDefined();
    expect(draft.version).toBeGreaterThan(live.version);
  });

  it("defaults to live on the left and the draft on the right; ids of another account are ignored", async () => {
    const versions = await db.select().from(agentVersions).where(eq(agentVersions.accountId, account.id));
    expect(pickVersions(versions)).toMatchObject({ before: { id: live.id }, after: { id: draft.id } });
    const c = (await loadVersionComparison(db, account.id, { a: otherVersionId, b: otherVersionId, languages: account.languages, platformDetails: false }))!;
    expect(c.before.id).toBe(live.id);
    expect(c.after.id).toBe(draft.id);
    expect(c.versions.every((v) => v.accountId === account.id)).toBe(true);
  });

  it("the seeded pair shows every diff kind", async () => {
    const c = (await loadVersionComparison(db, account.id, { languages: account.languages, platformDetails: false }))!;
    // Six rows: the switch to an own card is a tag on the edited step, not a row of its own.
    expect(c.changes.map((r) => [r.area, r.item, r.kind])).toEqual([
      ["plays", "Too expensive · step 2", "changed"],
      ["questions", "Deal details", "added"],
      ["limits", "Offers the agent may make · General discount", "changed"],
      ["limits", "Offer a call when", "changed"],
      // Never do is its own area since the Playbook parts (S1).
      ["never", "Never do · Rule 2", "moved"],
      ["voice", "Speaking pace", "changed"],
    ]);
    // The play step: words removed and added in the middle of one sentence.
    const step = c.changes[0];
    expect(step.tag).toBe("now your own card");
    const del = step.before!.filter((s) => s.op === "del").map((s) => s.text.trim());
    const ins = step.after!.filter((s) => s.op === "ins").map((s) => s.text.trim());
    expect(del).toEqual(["the problem", "unit"]);
    expect(ins).toEqual(["one spoiled delivery", "fridge"]);
    expect(step.before![0].op).toBe("same");
    expect(step.before!.at(-1)!.op).toBe("same");
    // The new question: nothing on the old side ("Not asked").
    expect(c.changes[1]).toMatchObject({ before: null, missing: "not_asked" });
    // The General discount row (Offers, 23 Nov): only the percent is struck and added.
    expect(c.changes[2].before!.filter((s) => s.op !== "same").map((s) => s.text.trim())).toEqual(["5%"]);
    expect(c.changes[2].after!.filter((s) => s.op !== "same").map((s) => s.text.trim())).toEqual(["8%"]);
    expect(c.changes[2].after!.map((s) => s.text).join("")).toBe("On · 8% off at most");
    // The moved rule: its own text on both sides, with the positions.
    const moved = c.changes[4];
    expect(moved.positions).toEqual({ before: 1, after: 2 });
    expect(moved.before![0].text).toBe(draft.playbook.neverDo[1]);
    expect(moved.after![0].text).toBe(draft.playbook.neverDo[1]);
  });

  it("the seeded pair shows every scenario change kind, ordered worse first and never run last", async () => {
    const c = (await loadVersionComparison(db, account.id, { languages: account.languages, platformDetails: false }))!;
    const by = Object.fromEntries(c.scenarios.map((s) => [s.scenario.id, s]));
    expect(by.hebrew_buyer).toMatchObject({ before: "failed", after: "passed", change: "better" });
    expect(by.discount_push).toMatchObject({ before: "passed", after: "failed", change: "worse" });
    expect(by.asks_for_person).toMatchObject({ before: "passed", after: "passed", change: "same" });
    expect(by.ready_buyer).toMatchObject({ before: "not_run", after: "not_yet", change: "first" });
    expect(by.no_approved_answer).toMatchObject({ before: "passed", after: "not_run", change: "run_it", afterChat: null });
    expect(by.card_in_chat).toMatchObject({ before: "not_run", after: "not_run", change: "never_run" });
    expect(c.scenarios.filter((s) => s.change === "never_run").length).toBeGreaterThanOrEqual(3);
    const order = ["worse", "run_it", "better", "first", "same", "never_run"];
    expect(c.scenarios.map((s) => s.change)).toEqual([...c.scenarios.map((s) => s.change)].sort((x, y) => order.indexOf(x) - order.indexOf(y)));
    expect(c.scenarios[0].scenario.id).toBe("discount_push");
  });

  it("renders the page: counts, notice, diff marks, Not asked, chips, start links; never a model call", async () => {
    const html = await render(ComparePage as unknown as Page, account.slug);
    save("compare-desktop", html);
    expect(html).toContain("Compare versions");
    expect(html).toContain(`href="/app/${account.slug}/setup/test-lab"`);
    expect(html).toMatch(/data-count="changes">6</);
    expect(html).toMatch(/data-area-chip="plays"[^>]*>Sales plays<span class="sas-fchip__count sas-num">1</);
    expect(html).toContain('data-change-tag="">now your own card<');
    expect(html).toContain('<span class="vc-moved__pos">Position 1</span>');
    expect(html).toContain("Too expensive · step 2");
    expect(html).not.toContain("&quot;Too expensive&quot;");
    // Visible version captions.
    expect(html).toContain('<span class="vc-pick__cap">Older version</span>');
    expect(html).toContain('<span class="vc-pick__cap">Newer version</span>');
    expect(html).toMatch(/data-count="better">1</);
    expect(html).toMatch(/data-count="worse">1</);
    // Not run = a result on live and none on the draft (no_approved_answer); never run in both is not counted.
    expect(html).toMatch(/data-count="not_run">1</);
    expect(html).toContain("1 scenario got worse and 1 was not run in the draft.");
    expect(html).toContain("You can still publish; &quot;Make live again&quot; brings v");
    expect(html).toMatch(/data-run-the="" href="[^"]*change=run_it#vc-scen-h">Run the 1</);
    expect(html).toContain('<del class="vc-del">5%</del>');
    expect(html).toContain('<ins class="vc-ins">8%</ins>');
    expect(html).toContain('<del class="vc-del">unit</del>');
    expect(html).toContain('<ins class="vc-ins">fridge</ins>');
    expect(html).toContain("Not asked");
    expect(html).toContain("· Moved");
    expect(html).toMatch(/data-change-chip="never_run"[^>]*>Never run<span class="sas-fchip__count sas-num">\d+</);
    expect(html).toMatch(/data-change-chip="first"[^>]*>First result</);
    expect(html).toMatch(/data-scenario="card_in_chat" data-change="never_run">.*?data-change-pill="never_run"[^>]*>—/);
    expect(html).toMatch(/data-scenario="card_in_chat"[^]*?data-start-test/);
    expect(html).toContain("Knowledge, catalog and price lists are shared by all versions, so they are not compared here.");
    expect(html).toContain("Scenarios run only when you start them, because each reply costs money.");
    expect(html).toContain("Publish draft v");
    expect(html).toContain("data-open-chats");
    // Sellers never see the text model or effort, nor a full email.
    expect(html).not.toContain('data-change="model"');
    expect(html).not.toMatch(/@[a-z]+\.test/);

    const filtered = await render(ComparePage as unknown as Page, account.slug, { change: "first", area: "limits" });
    save("compare-filtered", filtered);
    expect(filtered).toContain('data-scenario="ready_buyer"');
    expect(filtered).not.toContain('data-scenario="discount_push"');
    expect(filtered).not.toContain('data-change="voice"');
    expect(filtered).toMatch(/aria-current="true"[^>]*data-change-chip="first"|data-change-chip="first"[^>]*aria-current="true"/);
  });

  it("platform staff see model and effort; two versions with the same content read the same", async () => {
    holder.access = { account, user: admin, actingAs: true, role: "seller_admin" };
    try {
      await db.update(agentVersions).set({ model: "claude-other" }).where(eq(agentVersions.id, draft.id));
      expect(await render(ComparePage as unknown as Page, account.slug)).toContain('data-change="model"');
      // The draft's content set to live's: two different versions, nothing changed.
      await db.update(agentVersions).set({ model: live.model, effort: live.effort, playbook: live.playbook, voiceSettings: live.voiceSettings }).where(eq(agentVersions.id, draft.id));
      const html = await render(ComparePage as unknown as Page, account.slug);
      expect(html).toContain("These two versions are the same.");
      expect(html).not.toContain("Pick two different versions to compare.");
    } finally {
      await db.update(agentVersions).set({ model: draft.model, effort: draft.effort, playbook: draft.playbook, voiceSettings: draft.voiceSettings }).where(eq(agentVersions.id, draft.id));
      holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
    }
  });

  it("the same version on both sides: only the pick-two line, no notice and no tables", async () => {
    for (const id of [live.id, draft.id]) {
      const same = await render(ComparePage as unknown as Page, account.slug, { a: id, b: id });
      if (id === draft.id) save("compare-same", same);
      expect(same).toContain("Pick two different versions to compare.");
      expect(same).not.toContain("These two versions are the same.");
      expect(same).not.toContain("data-compare-notice");
      expect(same).not.toContain("data-run-the");
      expect(same).not.toContain("data-what-changed");
      expect(same).not.toContain("data-compare-scenarios");
      expect(same).not.toContain("data-compare-counts");
    }
    // Right side not the draft: no Publish action.
    expect(await render(ComparePage as unknown as Page, account.slug, { a: live.id, b: live.id })).not.toContain("Publish draft v");
  });

  it("the test lab's Versions panel: changes from live, Compare with live, a blue Live pill, one Publish", async () => {
    const html = await render(TestLabPage as unknown as Page, account.slug);
    save("testlab-versions", html);
    expect(html).toContain("6 changes from live");
    expect(html).toContain(`href="/app/${account.slug}/setup/test-lab/compare?a=${live.id}&amp;b=${draft.id}"`);
    expect(html).toMatch(/class="sas-pill sas-pill--info" data-status="agent_version.live"/);
    // One Publish only: the header's; the draft row keeps Compare with live and the change count.
    expect(html.match(/Publish draft v/g)).toHaveLength(1);
  });
});

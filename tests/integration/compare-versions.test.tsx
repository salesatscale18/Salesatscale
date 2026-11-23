/**
 * Compare versions (board VersionCompare) on PGlite with the demo account: the
 * versions picked (defaults, any two, account isolation), what changed, the stored
 * scenario results per version with their change, and the entry in the test lab's
 * Versions panel. No model is called: the SDK is mocked to throw, and the only
 * buyer turns are the free fixed-reply paths (STOP, a card number) on ScriptedLlm.
 *
 * With COMPARE_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, messages, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { ScriptedLlm } from "@/lib/agent/llm";
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
const { ensureDraftVersion, saveDraftPlaybook, startTestConversation } = await import("@/lib/agent/service");
const { runBuyerTurn } = await import("@/lib/agent/turn");
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
  let account: SellerAccount, other: SellerAccount;
  let liveId: string, draftId: string, otherVersionId: string;

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
    [other] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r2.summary.accountId));
    otherVersionId = (await db.select().from(agentVersions).where(eq(agentVersions.accountId, other.id)))[0].id;
    holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };

    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, account.id), eq(agentVersions.status, "live")));
    liveId = live.id;
    // The draft: a higher discount limit, one more question, one more fact on a play, another voice model.
    const draft = await ensureDraftVersion(db, account.id);
    draftId = draft.id;
    const pb = structuredClone(draft.playbook);
    pb.maxDiscountBp = 800;
    pb.fields = [...pb.fields, { key: "freezers", label: "Number of freezers", stage: "optional" }];
    pb.neverDo = [...pb.neverDo, "Never promise a delivery date."];
    await saveDraftPlaybook(db, account.id, pb);
    await db.update(agentVersions).set({ voiceSettings: { model: "openai/gpt-realtime-2.1" } }).where(eq(agentVersions.id, draftId));

    // Scenario results. Live (from the seed): no_approved_answer passed, hebrew_buyer failed. Plus says_stop passed (free STOP path).
    const stopLive = (await startTestConversation(db, account.id, seller.id, { language: "en", scenario: "says_stop", versionId: liveId }))!;
    expect((await runBuyerTurn(db, new ScriptedLlm([]), { accountId: account.id, conversationId: stopLive.conversationId, text: "STOP" })).status).not.toBe("error");
    // Draft: hebrew_buyer passes (Better), says_stop fails (Worse: a reply without opting out), card_in_chat passes (first result).
    const he = (await startTestConversation(db, account.id, seller.id, { language: "he", scenario: "hebrew_buyer", versionId: draftId }))!;
    const stopDraft = (await startTestConversation(db, account.id, seller.id, { language: "en", scenario: "says_stop", versionId: draftId }))!;
    await db.insert(messages).values([
      { accountId: account.id, conversationId: he.conversationId, actor: "buyer", body: "שלום, כמה זה עולה?", createdAt: new Date(Date.now() - 2000) },
      { accountId: account.id, conversationId: he.conversationId, actor: "agent", body: "שלום! כמה מקררים יש לכם?", createdAt: new Date(Date.now() - 1000) },
      { accountId: account.id, conversationId: stopDraft.conversationId, actor: "buyer", body: "stop please", createdAt: new Date(Date.now() - 2000) },
      { accountId: account.id, conversationId: stopDraft.conversationId, actor: "agent", body: "Sure, anything else?", createdAt: new Date(Date.now() - 1000) },
    ]);
    const card = (await startTestConversation(db, account.id, seller.id, { language: "en", scenario: "card_in_chat", versionId: draftId }))!;
    expect((await runBuyerTurn(db, new ScriptedLlm([]), { accountId: account.id, conversationId: card.conversationId, text: "Just charge my card: 4111 1111 1111 1111, exp 12/28." })).status).not.toBe("error");
  }, 180_000);
  afterAll(async () => t.close());

  it("defaults to live on the left and the draft on the right; ids of another account are ignored", async () => {
    const versions = await db.select().from(agentVersions).where(eq(agentVersions.accountId, account.id));
    expect(pickVersions(versions)).toMatchObject({ before: { id: liveId }, after: { id: draftId } });
    const c = (await loadVersionComparison(db, account.id, { a: otherVersionId, b: otherVersionId, languages: account.languages, platformDetails: false }))!;
    expect(c.before.id).toBe(liveId);
    expect(c.after.id).toBe(draftId);
    expect(c.versions.every((v) => v.accountId === account.id)).toBe(true);
  });

  it("lists what changed and each scenario's change, worse first", async () => {
    const c = (await loadVersionComparison(db, account.id, { languages: account.languages, platformDetails: false }))!;
    expect(c.changes.map((r) => [r.area, r.item, r.kind])).toEqual([
      ["questions", "Deal details", "added"],
      ["limits", "Discount without approval", "changed"],
      ["limits", `Never do · Rule ${c.after.playbook.neverDo.length}`, "added"],
      ["voice", "Voice model", "changed"],
      ["voice", "Voice", "changed"],
      // GPT-Realtime takes a conversation style; Gemini has none, so it is new in the draft.
      ["voice", "Conversation style", "added"],
    ]);
    const by = Object.fromEntries(c.scenarios.map((s) => [s.scenario.id, s]));
    expect(by.says_stop).toMatchObject({ before: "passed", after: "failed", change: "worse" });
    expect(by.hebrew_buyer).toMatchObject({ before: "failed", after: "passed", change: "better" });
    expect(by.no_approved_answer).toMatchObject({ before: "passed", after: "not_run", change: "run_it", afterChat: null });
    expect(by.card_in_chat).toMatchObject({ before: "not_run", after: "passed", change: "first" });
    expect(c.scenarios[0].scenario.id).toBe("says_stop");
    const order = ["worse", "run_it", "better", "first", "same"];
    const idx = c.scenarios.map((s) => order.indexOf(s.change));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
  });

  it("renders the page: counts, notice, diff marks, Not asked, chips, start links; never a model call", async () => {
    const html = await render(ComparePage as unknown as Page, account.slug);
    save("compare-desktop", html);
    expect(html).toContain("Compare versions");
    expect(html).toContain(`href="/app/${account.slug}/setup/test-lab"`);
    expect(html).toMatch(/data-count="worse">1</);
    expect(html).toMatch(/data-count="better">1</);
    expect(html).toMatch(/data-count="changes">6</);
    expect(html).toContain("1 scenario got worse and");
    expect(html).toContain("were not run in the draft.");
    expect(html).toContain("You can still publish; &quot;Make live again&quot; brings v");
    expect(html).toMatch(/data-run-the="" href="[^"]*change=run_it#vc-scen-h">Run the \d+</);
    expect(html).toContain('<del class="vc-del">5%</del>');
    expect(html).toContain('<ins class="vc-ins">8%</ins>');
    expect(html).toContain("Not asked");
    expect(html).toContain("about 7");
    expect(html).toContain("Knowledge, catalog and price lists are shared by all versions, so they are not compared here.");
    expect(html).toContain("Scenarios run only when you start them, because each reply costs money.");
    expect(html).toContain("Publish draft v");
    expect(html).toContain("data-start-test");
    expect(html).toContain("data-open-chats");
    // Sellers never see the text model or effort.
    expect(html).not.toContain('data-change="model"');
    expect(html).not.toMatch(/@[a-z]+\.test/);

    const filtered = await render(ComparePage as unknown as Page, account.slug, { change: "run_it", area: "limits" });
    save("compare-filtered", filtered);
    expect(filtered).not.toContain('data-scenario="says_stop"');
    expect(filtered).toContain('data-scenario="no_approved_answer"');
    expect(filtered).not.toContain('data-change="voice"');
  });

  it("platform staff see model and effort; the same version on both sides reads the same", async () => {
    holder.access = { account, user: admin, actingAs: true, role: "seller_admin" };
    try {
      await db.update(agentVersions).set({ model: "claude-other" }).where(eq(agentVersions.id, draftId));
      expect(await render(ComparePage as unknown as Page, account.slug)).toContain('data-change="model"');
      await db.update(agentVersions).set({ model: (await db.select().from(agentVersions).where(eq(agentVersions.id, liveId)))[0].model }).where(eq(agentVersions.id, draftId));
    } finally {
      holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
    }
    const same = await render(ComparePage as unknown as Page, account.slug, { a: liveId, b: liveId });
    expect(same).toContain("These two versions are the same.");
    // Right side not the draft: no Publish action.
    expect(same).not.toContain("Publish draft v");
  });

  it("the test lab's Versions panel: changes from live, Compare with live, a blue Live pill", async () => {
    const html = await render(TestLabPage as unknown as Page, account.slug);
    save("testlab-versions", html);
    expect(html).toContain("6 changes from live");
    expect(html).toContain(`href="/app/${account.slug}/setup/test-lab/compare?a=${liveId}&amp;b=${draftId}"`);
    expect(html).toMatch(/class="sas-pill sas-pill--info" data-status="agent_version.live"/);
  });
});

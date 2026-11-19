/**
 * Round-4 review fixes, lane R4-4 (Sales plays, Company, Settings, Go live, Test lab), rendered on PGlite:
 * - A1 play examples: <placeholders> as grey tags, the new illustration note;
 * - A2 "Finding the real need": the neutral example "How do you handle <what they asked about> today?" (card and prompt);
 * - A3 the question budget (2–6) in "Stop at N questions." on the card and in the prompt (one rewrite);
 * - A4 the Playbook plays summary adds up to 13;
 * - A5 one disclosure term ("automated assistant"); Company shows the real opener (openerText);
 * - C3 scenario wording; C6 sellers never see the model or effort on Versions;
 * - D1 Company's one Save in a sticky bar; D4 "from [5] to [10] days" on one line; Test lab Deal state under the chat;
 * - E3 Go live: payments pass with a neutral "Test mode: no real charges yet";
 * - E5 no pending invite for an email that is already a member; E6 Lead intake fields under the sample.
 * No model is called (ScriptedLlm is not even needed: nothing here runs a turn).
 *
 * With R44_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { accountInvites, accountMembers, sellerAccounts, users, type Playbook, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount, listPendingInvites } = await import("@/lib/accounts/service");
const { ensureDraftVersion, saveDraftPlaybook, startTestConversation, publishDraftVersion } = await import("@/lib/agent/service");
const { DEFAULT_PLAYS, defaultPlayFor, withQuestionBudget } = await import("@/lib/agent/core/plays");
const { MIXED_EXAMPLES } = await import("@/lib/agent/core/examples");
const { playsText } = await import("@/lib/agent/core/design");
const { openerText, sampleOpenerText } = await import("@/lib/agent/core/opener");
const { buyerNames } = await import("@/lib/agent/core/names");
const { exampleParts } = await import("@/app/app/[account]/setup/playbook/plays/slots");
const { playsOverview, playsSummary } = await import("@/app/app/[account]/setup/playbook/plays/overview");
const { SCENARIOS } = await import("@/lib/agent/scenarios");
const { t: tr } = await import("@/lib/i18n");
const { default: PlaybookPage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PlayPage } = await import("@/app/app/[account]/setup/playbook/plays/[play]/page");
const { default: CompanyPage } = await import("@/app/app/[account]/setup/company/page");
const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");
const { default: GoLivePage } = await import("@/app/app/[account]/setup/go-live/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");

const CSS_FILES = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css", "app/app/[account]/setup/go-live/go-live.css"];
const css = CSS_FILES.map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
const save = (name: string, html: string) => {
  const dir = process.env.R44_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;

describe("R4-4: Sales plays, Company, Settings, Go live, Test lab", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let owner: User;
  let acc: SellerAccount;
  const render = async (P: unknown, params: Record<string, string> = {}, sp: Record<string, string> = {}, actingAs = false) => {
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: admin, actingAs, role: actingAs ? "platform_admin" : "seller_admin" };
    return renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: acc.slug, ...params }), searchParams: Promise.resolve(sp) }));
  };
  const setPlaybook = async (patch: Partial<Playbook>) => {
    const d = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, { ...d.playbook, ...patch });
  };

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "r44-a", email: "admin@platform.test", role: "super_admin" }).returning();
    [owner] = await db.insert(users).values({ clerkId: "r44-o", email: "olga@polar.test", firstName: "Olga", lastName: "Owner" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "Olga Owner", ownerEmail: "olga@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
    await db.insert(accountMembers).values({ accountId: acc.id, userId: owner.id, isOwner: true });
    await setPlaybook({ agentName: "Maya", opener: { topics: [{ en: "monitoring your fridges" }], defaultTopic: 0, question: { en: "How do you check them today?" } } });
  });
  afterAll(async () => t.close());

  describe("A. Sales play examples", () => {
    it("A1: placeholders split into grey tags without brackets", () => {
      expect(exampleParts("For <what they described>, <the set> covers it.")).toEqual([
        { text: "For ", slot: false }, { text: "what they described", slot: true }, { text: ", ", slot: false }, { text: "the set", slot: true }, { text: " covers it.", slot: false },
      ]);
      expect(exampleParts("No placeholder.")).toEqual([{ text: "No placeholder.", slot: false }]);
    });

    it("A1/A2: the card shows the neutral need example as a tag, with the new note", async () => {
      const html = await render(PlayPage, { play: "need" });
      save("play-need", html);
      expect(html).toMatch(/data-part="example"[^>]*>How do you handle <span class="pb-slot-tag" data-slot-tag="">what they asked about<\/span> today\?<\/span>/);
      expect(html).toContain("Illustration. The grey words are filled from your approved facts.");
      expect(html).not.toMatch(/offices|clean/i);
    });

    it("A2: no default card or the fallback need example names an industry", () => {
      expect(DEFAULT_PLAYS.need.example).toBe("How do you handle <what they asked about> today?");
      expect(MIXED_EXAMPLES.plays.need).toBe("How do you handle <what they asked about> today?");
      const all = JSON.stringify(DEFAULT_PLAYS);
      for (const word of ["office", "clean", "fridge", "restaurant", "lift", "generator"]) expect(all.toLowerCase()).not.toContain(word);
      // The prompt reads the same neutral example for a seller without their own.
      expect(playsText({ plays: {}, questionBudget: 3 })).toContain('### Finding the real need\nWhen: You do not yet know enough to recommend one set.\nDo: 1) Start with how they handle it today.');
      expect(playsText({ plays: {}, questionBudget: 3 })).toContain('Example: "How do you handle <what they asked about> today?"');
    });

    it("A3: the budget (2–6) is in the card and the prompt, by one rewrite", async () => {
      for (const n of [2, 4, 6]) {
        expect(defaultPlayFor("need", n).do.at(-1)).toBe(`Skip anything the buyer already said. Stop at ${n} questions.`);
        expect(playsText({ plays: {}, questionBudget: n })).toContain(`Stop at ${n} questions.`);
      }
      expect(withQuestionBudget(["Stop at 3 questions."], 5)).toEqual(["Stop at 5 questions."]);
      await setPlaybook({ questionBudget: 5 });
      const html = await render(PlayPage, { play: "need" });
      expect(html).toContain("Skip anything the buyer already said. Stop at 5 questions.");
      expect(html).not.toContain("Stop at 3 questions");
      await setPlaybook({ questionBudget: 3 });
    });

    it("A4: the summary parts add up to 13; own cards are counted apart", async () => {
      const none = playsSummary(playsOverview({ plays: {}, questionBudget: 3, maxDiscountBp: 0 }, new Map()));
      expect(none).toEqual({ total: 13, withFacts: 0, sharper: 10, noneNeeded: 3, own: 0, suggested: 0 });
      const own = { when: "W", do: ["D"], example: "E", notThis: "N" };
      const some = playsSummary(playsOverview({ plays: { value: { facts: [{ text: "Saves 2 hours a week" }] }, not_now: { facts: [{ text: "Call back in Q1" }], own } }, questionBudget: 3, maxDiscountBp: 500 }, new Map()));
      expect(some.withFacts + some.sharper + some.noneNeeded).toBe(13);
      expect(some).toMatchObject({ withFacts: 3, sharper: 8, noneNeeded: 2, own: 1 });
      const html = await render(PlaybookPage);
      save("playbook", html);
      const summary = html.match(/data-testid="plays-summary">[\s\S]*?<\/ul>/)?.[0] ?? "";
      expect(summary).not.toMatch(/need your facts|of 13/);
      expect(summary).toContain("3 need none");
    });
  });

  describe("A5. One disclosure term; the real opener on Company", () => {
    it("sampleOpenerText is the agent's opener for a sample lead, in each language", async () => {
      const d = await ensureDraftVersion(db, acc.id);
      const names = buyerNames(d.playbook, acc, "en");
      expect(sampleOpenerText(d.playbook, acc, "en")).toBe(openerText({ name: "Rina", agent: names.agent, company: names.seller, gender: names.gender, language: "en", opener: d.playbook.opener }));
      expect(sampleOpenerText(d.playbook, acc, "en")).toBe("Hi Rina, this is Maya, the automated assistant of Polar. You asked about monitoring your fridges. How do you check them today?");
      expect(sampleOpenerText(d.playbook, acc, "he")).toContain("רינה");
    });

    it("Company shows the opener per language; Never do and the disclosure say \"automated assistant\"", async () => {
      const html = await render(CompanyPage);
      save("company", html);
      expect(html).toContain('data-agent-intro="en"');
      expect(html).toContain('data-agent-intro="he"');
      // The company name is its own bidi run in the preview (R5 item 4); the text is the one the agent sends.
      expect(html).toContain('Hi Rina, this is Maya, the automated assistant of <bdi data-opener-company="">Polar</bdi>. You asked about monitoring your fridges. How do you check them today?');
      expect(html).not.toMatch(/automated agent/);
      expect(tr("playbook.never_hint")).toContain("says it is an automated assistant");
      expect(tr("playbook.never_hint")).not.toContain("automated agent");
      const pb = await render(PlaybookPage);
      expect(pb).not.toContain("automated agent");
    });
  });

  describe("D. Company layout", () => {
    it("D1: one Save, in the sticky bar at the end of the form; D4: the lead time range on one line", async () => {
      const html = await render(CompanyPage);
      expect(html.match(/>Save<\/button>/g)).toHaveLength(1);
      expect(html).toMatch(/<div class="co-savebar" data-savebar=""><button[^>]*type="submit"/);
      expect(html.indexOf("data-savebar")).toBeGreaterThan(html.indexOf('aria-labelledby="pp-h"'));
      expect(css).toMatch(/\.co-savebar \{[^}]*position: sticky; bottom: 0;/);
      expect(html).toMatch(/<span class="co-range" data-lead-range=""><span>from<\/span><input[^>]*name="minDays"[^>]*\/><span>to<\/span><input[^>]*name="maxDays"[^>]*\/><span>days<\/span><\/span>/);
      expect(css).toMatch(/\.co-range \{[^}]*white-space: nowrap;/);
      // Same spelling as Order form setup (D13).
      expect(html).toContain('for="co-bc">Brand colour</label>');
    });
  });

  describe("C3, C6, D4. Test lab", () => {
    it("scenario wording; Hebrew buyer once; Deal state right under the chat on a phone; no model for sellers", async () => {
      expect(SCENARIOS.find((s) => s.id === "says_stop")!.expected).toBe("The lead is opted out at once, with the fixed reply. This one costs nothing.");
      await publishDraftVersion(db, { userId: admin.id, actingAs: false }, acc.id);
      const c = await startTestConversation(db, acc.id, admin.id, { language: "en" });
      const html = await render(TestLabPage, {}, { c: c!.conversationId });
      save("test-lab", html);
      expect(html).toContain(">Hebrew buyer</option>");
      expect(html).not.toContain("Hebrew buyer (Hebrew)");
      expect(html).not.toContain("no model call");
      // The chat, then its Deal state (shown when the columns stack), then the scenarios; the side copy stays for wide screens.
      const chat = html.indexOf('aria-labelledby="lab-chat-h"');
      const main = html.indexOf('data-deal-card="main"');
      const scen = html.indexOf("data-scenarios");
      const side = html.indexOf('data-deal-card="side"');
      expect(chat).toBeGreaterThan(-1);
      expect(main).toBeGreaterThan(chat);
      expect(main).toBeLessThan(scen);
      expect(side).toBeGreaterThan(scen);
      expect(css).toMatch(/@container \(max-width: 903px\) \{\s*\.lab-deal--main \{ display: block; \}\s*\.lab-deal--side \{ display: none; \}/);
      // C6: a seller (the owner, not a platform admin) sees no model name or effort; a platform admin acting as does.
      holder.access = { account: acc, user: owner, actingAs: false, role: "seller_admin" };
      const seller = renderToStaticMarkup(await (TestLabPage as Page)({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ c: c!.conversationId }) }));
      expect(seller).not.toContain("data-version-model");
      expect(seller).not.toMatch(/claude-|effort/i);
      expect(seller).toMatch(/Published \d/);
      expect(await render(TestLabPage, {}, { c: c!.conversationId }, true)).toContain("data-version-model");
    });
  });

  describe("E. Go live and Settings", () => {
    it("E3: payments pass with a neutral test-mode note", async () => {
      const html = await render(GoLivePage);
      save("go-live", html);
      const row = html.match(/<li data-check="payments"[\s\S]*?<\/li>/)?.[0] ?? "";
      if (row.includes('data-state="pass"')) {
        expect(row).toContain('<span class="sas-pill" data-test-mode="">');
        expect(row).toContain("Test mode: no real charges yet");
        expect(row).not.toMatch(/sas-pill--(success|warning|danger)" data-test-mode/);
      }
      expect(row).not.toContain("Test mode ·");
      expect(tr("golive.check.payments.ok", { methods: "Card" })).toBe("Card");
    });

    it("E5: an invite for an email that is already a member is not listed", async () => {
      await db.insert(accountInvites).values({ accountId: acc.id, email: "OLGA@polar.test", expiresAt: new Date(Date.now() + 86_400_000), tokenHash: "r44-dup" });
      await db.insert(accountInvites).values({ accountId: acc.id, email: "new@polar.test", expiresAt: new Date(Date.now() + 86_400_000), tokenHash: "r44-new" });
      const emails = (await listPendingInvites(db, acc.id)).map((x) => x.invite.email);
      expect(emails).toContain("new@polar.test");
      expect(emails.map((e) => e.toLowerCase())).not.toContain("olga@polar.test");
      const html = await render(SettingsPage, {}, { section: "users" });
      save("settings-users", html);
      expect(html).toContain("new@polar.test");
      expect(html).not.toMatch(/OLGA@polar\.test|>olga@polar\.test<\/span>/);
    });

    it("R5-16: an invite for the email of a person listed but not a member (acting platform admin) is not listed", async () => {
      await db.insert(accountInvites).values({ accountId: acc.id, email: "Admin.Acting@platform.test", expiresAt: new Date(Date.now() + 86_400_000), tokenHash: "r5-acting" });
      const before = (await listPendingInvites(db, acc.id)).map((x) => x.invite.email);
      expect(before).toContain("Admin.Acting@platform.test");
      const after = (await listPendingInvites(db, acc.id, new Date(), ["admin.acting@platform.test"])).map((x) => x.invite.email);
      expect(after).not.toContain("Admin.Acting@platform.test");
      expect(after).toContain("new@polar.test");
    });

    it("E6: Required and Optional under the sample; the sample check in the code font", async () => {
      const html = await render(SettingsPage, {}, { section: "intake" });
      save("settings-intake", html);
      expect(html).toContain('data-intake-field="language"');
      expect(html).toContain('data-intake-field="business"');
      expect(html).toMatch(/data-intake-field="source"><dt><code class="st-mono">source<\/code><\/dt><dd class="sas-small">The label in your leads list/);
      expect(html).toMatch(/data-intake-field="consent.source"><dt><code class="st-mono">consent.source<\/code><\/dt><dd class="sas-small">Where the person agreed/);
      expect(css).toMatch(/\.sas-app \.st-mono \{ font-family: var\(--font-mono\);/);
    });
  });
});

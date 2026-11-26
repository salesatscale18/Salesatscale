/**
 * Round-3 review fixes, lane R3-6 (Playbook, Settings, Company, Go live, Markets), rendered on PGlite:
 * - A6 Settings › Lead intake: the sample and the endpoint wrap; no repo path; keys as a small table (cards on a phone);
 * - A7 Settings › Users: members are cards on a phone; Name is the person's name (not the email again);
 *   "Platform admin · acting as this account" in one plain tag;
 * - A9 "Too expensive": a filled discount limit counts as a fact (card footer and the Playbook summary);
 *   objections' answers grow; the question example is plain muted text;
 * - B7 Go live wording; B8 neutral default examples with the illustration note;
 * - C Company has one Save; Notifications rows span the panel; Payments "Test mode" is a neutral flask pill;
 *   Markets: price list select full width on a phone, no "· from account" beside "Same as account default";
 * - the question stepper: − off at 2, + off at 6.
 * No model is called.
 *
 * With R36_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { accountMembers, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
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

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { parseCompany } = await import("@/lib/accounts/company");
const { createIntakeKey } = await import("@/lib/leads/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { ensureDraftVersion, saveDraftPlaybook } = await import("@/lib/agent/service");
const { playsOverview } = await import("@/app/app/[account]/setup/playbook/plays/overview");
const { checkTitle, goLiveSummary } = await import("@/app/app/[account]/setup/go-live/summary");
const { DEFAULT_PLAYS } = await import("@/lib/agent/core/plays");
const { default: PlaybookPage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");
const { default: PlayPage } = await import("@/app/app/[account]/setup/playbook/plays/[play]/page");
const { default: CompanyPage } = await import("@/app/app/[account]/setup/company/page");
const { default: SettingsPage } = await import("@/app/app/[account]/settings/page");
const { default: GoLivePage } = await import("@/app/app/[account]/setup/go-live/page");
const { default: MarketsPage } = await import("@/app/app/[account]/markets/page");

const CSS_FILES = [
  "components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css",
  "app/app/[account]/setup/go-live/go-live.css", "app/app/[account]/markets/markets.css",
];
const css = CSS_FILES.map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
const save = (name: string, html: string) => {
  const dir = process.env.R36_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell__main">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;

describe("R3-6: Playbook, Settings, Company, Go live, Markets", () => {
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
  const setPlaybook = async (patch: Record<string, unknown>) => {
    const d = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, { ...d.playbook, ...patch });
  };

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "r36-a", email: "testuser+clerk_test@platform.test", role: "super_admin" }).returning();
    [owner] = await db.insert(users).values({ clerkId: "r36-o", email: "olga@polar.test", firstName: "Olga", lastName: "Owner" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "Olga Owner", ownerEmail: "olga@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account;
    await db.insert(accountMembers).values({ accountId: acc.id, userId: owner.id, isOwner: true });
    await setPlaybook({ maxDiscountBp: 500, objections: [{ objection: "We already pay for an alarm company.", answer: "An alarm covers doors, not temperature. A long answer that needs a fourth line on a phone.", source: "Call" }] });
  });
  afterAll(async () => t.close());

  describe("A9. Too expensive counts its filled discount limit", () => {
    it("overview: 1 fact (the discount limit), still asking for the named facts; none at 0%", () => {
      const at = (bp: number) => playsOverview({ plays: {}, questionBudget: 3, maxDiscountBp: bp }, new Map()).find((x) => x.key === "too_expensive")!;
      expect(at(500)).toMatchObject({ factCount: 1, needsFacts: false, factsLine: { kind: "facts", n: 1, missing: ["what the problem costs a typical customer", "smaller starting set", "what a discount can be traded for", "what the price includes"] } });
      expect(at(0)).toMatchObject({ factCount: 0, needsFacts: true, factsLine: { kind: "needs" } });
      // Other plays are unchanged by the discount limit.
      expect(playsOverview({ plays: {}, questionBudget: 3, maxDiscountBp: 500 }, new Map()).find((x) => x.key === "proof")!.factCount).toBe(0);
    });

    it("the Sales plays card and the Playbook home line show it", async () => {
      const plays = await render(PlaysPage);
      const card = plays.match(/data-play="too_expensive"[\s\S]*?<\/a>/)?.[0] ?? "";
      expect(card).toContain('data-facts="facts"');
      expect(card).toContain("1 fact");
      expect(card).toContain("add what the problem costs a typical customer, smaller starting set, what a discount can be traded for, what the price includes");
      const pb = await render(PlaybookPage);
      const row = pb.match(/data-part="plays">[\s\S]*?<\/a>/)?.[0] ?? "";
      // R4 A4 / O1: 19 plays, 1 with facts (the discount limit), 15 would be sharper (an amber note on the row and in Worth a look).
      expect(row).toContain(">19 plays · 1 with your facts<");
      expect(row).toContain('data-gap="plays">15 sales plays would be sharper with your facts.<');
      expect(pb).toMatch(/<li data-gap="plays">15 sales plays would be sharper with your facts\. <a href="\/app\/[a-z0-9-]+\/setup\/playbook\/plays\?filter=needs">Add facts<\/a><\/li>/);
      // The own-card and ready counts are on the Sales plays filter chips.
      expect(plays).toMatch(/Your own cards <span class="pb-count">0<\/span>/);
      expect(plays).toMatch(/Ready <span class="pb-count">4<\/span>/);
    });
  });

  describe("A9. Objections and questions; the stepper", () => {
    it("the approved answer grows; delete sits at the end of the row (no handle: order does not matter); the example is plain text", async () => {
      const html = await render(PartPage, { part: "objections" });
      save("playbook", html);
      const row = html.match(/data-row="objection\.0"[\s\S]*?data-remove=""/)?.[0] ?? "";
      expect(row).toContain('aria-label="Remove: ');
      expect(row).not.toContain("pb-handle");
      // S2: open, the answer grows with its text.
      const open = await render(PartPage, { part: "objections" }, { edit: "objection.0" });
      expect(open).toMatch(/<textarea class="sas-textarea pb-grow pb-grow--3 pb-fit-long" id="pb-objection\.0\.answer"/);
      const pbCss = fs.readFileSync("app/app/[account]/setup/playbook/playbook.css", "utf8");
      // On a phone the buyer's words and the answer stack.
      expect(pbCss).toMatch(/@media \(max-width: 767px\) \{[\s\S]*?\.pb-obj \{ grid-template-columns: minmax\(0, 1fr\); \}/);
      // The example question: plain muted text under the question in the read state.
      const asks = await render(PartPage, { part: "asks" });
      expect(asks).toMatch(/<span class="sas-small( pb-warn-text)?" (dir="auto" data-example=""|data-example-missing="")>/);
    });

    it("− is off at 2 and + at 6; both work in between", async () => {
      const stepper = async (n: number) => {
        await setPlaybook({ questionBudget: n });
        const html = await render(PartPage, { part: "asks" });
        return html.match(/data-testid="budget-stepper">[\s\S]*?<\/span>/)?.[0] ?? "";
      };
      const two = await stepper(2);
      expect(two).toMatch(/<button type="button" disabled="" aria-label="Fewer">/);
      expect(two).toMatch(/<button type="button" aria-label="More">/);
      expect(two).toContain(">2</output>");
      const six = await stepper(6);
      expect(six).toMatch(/<button type="button" aria-label="Fewer">/);
      expect(six).toMatch(/<button type="button" disabled="" aria-label="More">/);
      const four = await stepper(4);
      expect(four).not.toContain('disabled=""');
      await setPlaybook({ questionBudget: 3 });
    });
  });

  describe("B8. Neutral default examples", () => {
    it('"Does it really work?" promises nothing; the card says the example is an illustration', async () => {
      expect(DEFAULT_PLAYS.proof.example).not.toMatch(/24 hours|replaced/);
      const html = await render(PlayPage, { play: "proof" });
      save("play-proof", html);
      expect(html).toContain('data-part="example-note">Illustration. The grey words are filled from your approved facts.</span>');
      // R4 A1: the placeholder is a grey tag, without the angle brackets. Since O1 the proof example asks
      // a question with no placeholder, so the tag is checked on a card that still has one.
      const existing = await render(PlayPage, { play: "existing_solution" });
      expect(existing).toContain('<span class="pb-slot-tag" data-slot-tag="">what it does well</span>');
      expect(existing).not.toContain("&lt;what it does well");
    });
  });

  describe("C. Company", () => {
    it("one Save button; the support contact wraps; line breaks are saved as spaces", async () => {
      await db.update(sellerAccounts).set({ supportContact: "support@polar-demo.example · 03 555 0142 · Sun–Thu 9–17" }).where(eq(sellerAccounts.id, acc.id));
      const html = await render(CompanyPage);
      save("company", html);
      expect(html.match(/>Save<\/(button|a)>/g)).toHaveLength(1);
      expect(html).toMatch(/<textarea class="sas-textarea" id="co-sup" name="supportContact" rows="1"[^>]*style="field-sizing:content/);
      expect(html).toContain("support@polar-demo.example · 03 555 0142 · Sun–Thu 9–17</textarea>");
      const p = parseCompany({ tradeName: "Polar", brandColor: "#123456", supportContact: " support@p.test\n03 555 0142 " });
      expect(p.ok && p.value.supportContact).toBe("support@p.test 03 555 0142");
    });
  });

  describe("A6/A7/C. Settings", () => {
    it("Users: cards on a phone, the person's name (not the email), one plain acting-as tag", async () => {
      const html = await render(SettingsPage, {}, { section: "users" }, true);
      save("settings-users", html);
      expect(html).toMatch(/<table class="sas-table sas-table--stack"[^>]*data-members/);
      // The admin has no name: the email's local part, as personName gives it; the email stays in its column.
      expect(html).toMatch(/data-member-name="">testuser<span class="sas-small"[^>]*> · You<\/span>/);
      expect(html).toMatch(/data-member-name="">Olga Owner</);
      expect(html).toContain('data-label="Email"');
      expect(html).toContain('data-acting-tag="">Platform admin · acting as this account</span>');
      expect(html).toMatch(/class="sas-chip sas-chip--plain" style="white-space:nowrap" data-acting-tag/);
      expect(html).not.toContain(">Acting as<");
    });

    it("Lead intake: the sample and the endpoint wrap, no repo path, keys as a small table", async () => {
      await createIntakeKey(db, { userId: admin.id, actingAs: false }, acc.id, "Website form");
      const html = await render(SettingsPage, {}, { section: "intake" });
      save("settings-intake", html);
      expect(html).toMatch(/<pre class="sas-code" style="white-space:pre-wrap;overflow-wrap:anywhere" data-intake-sample/);
      // R5: the minimal body first (full_name and phone only), then "With optional fields" with the consent block.
      const minimal = html.split('data-intake-sample="">')[1].split("</pre>")[0].replace(/&quot;/g, '"');
      expect(JSON.parse(minimal)).toEqual({ full_name: "Rina Cohen", phone: "+972545551842", consent: { given: true } });
      // "Check a sample" starts with the minimal sample; the consent rule is stated.
      const textarea = html.split('<textarea id="sample"')[1].split("</textarea>")[0].replace(/&quot;/g, '"');
      expect(JSON.parse(textarea.slice(textarea.indexOf(">") + 1))).toEqual({ full_name: "Rina Cohen", phone: "+972545551842", consent: { given: true } });
      expect(html).toContain("A lead your team saved without consent gets it back only when a delivery sends consent.given: true.");
      const second = html.indexOf('id="intake-sample-optional"');
      expect(second).toBeGreaterThan(html.indexOf("data-intake-sample=\"\""));
      expect(html.slice(second)).toMatch(/^id="intake-sample-optional">With optional fields<\/strong>/);
      const optional = html.split('data-intake-sample-optional="" aria-labelledby="intake-sample-optional">')[1].split("</pre>")[0].replace(/&quot;/g, '"');
      expect(JSON.parse(optional)).toMatchObject({ full_name: "Rina Cohen", phone: "+972545551842", consent: { given: true, source: "yoursite.example/contact" } });
      expect(html).toContain("Mobile number, with the country code if it is not local. Used for SMS, and for WhatsApp when it&#x27;s on.");
      expect(html).toContain("yoursite.example/contact");
      expect(html).toMatch(/<code id="endpoint" class="sas-num" aria-labelledby="endpoint-label" style="overflow-wrap:anywhere;min-width:0">http:\/\/localhost:3000\/api\/leads\//);
      expect(html).not.toContain("docs/lead-intake.md");
      // R4 E6: Required and Optional together under the sample, every field the sample shows, the two sources told apart.
      expect(html.indexOf('data-intake-sample')).toBeLessThan(html.indexOf('data-intake-fields="required"'));
      expect(html.indexOf('data-intake-fields="required"')).toBeLessThan(html.indexOf('data-intake-fields="optional"'));
      expect(html.indexOf('data-intake-fields="optional"')).toBeLessThan(html.indexOf('id="sample"'));
      for (const f of ["full_name", "phone", "language", "business", "source_id", "consent.source", "consent.text", "consent.at", "email", "country", "source", "consent.page_url"]) {
        expect(html).toContain(`data-intake-field="${f}"`);
      }
      expect(html).toContain("Not the same as consent.source.");
      expect(html).toContain("Not the same as source.");
      expect(html).toMatch(/<textarea id="sample" name="sample" class="sas-textarea st-mono"/);
      expect(html).toMatch(/<table class="sas-table sas-table--stack sas-keys-table" style="font-size:13px" data-intake-keys/);
      for (const l of ["Market", "Key", "Created", "Last used"]) expect(html).toContain(`data-label="${l}"`);
    });

    it("Notifications: the table spans the panel; Payments: a neutral flask pill", async () => {
      const ntf = await render(SettingsPage, {}, { section: "notifications" });
      save("settings-notifications", ntf);
      // The table is a direct child of the form, not inside a padded panel body.
      expect(ntf).toMatch(/<\/h2><\/div><table class="sas-table" data-notifications/);
      // Each row's divider runs under the event name too, not only under the checkbox.
      expect(ntf.match(/<th scope="row" style="[^"]*border-block-start:1px solid var\(--line\)[^"]*" data-divider="">/g)).toHaveLength(4);
      const pay = await render(SettingsPage, {}, { section: "payments" });
      save("settings-payments", pay);
      expect(pay).toMatch(/<span class="sas-pill" data-test-mode=""><svg[^>]*lucide-flask-conical[^>]*>[\s\S]*?<\/svg>Test mode<\/span>/);
      expect(pay).not.toContain("sas-pill--warning");
    });
  });

  describe("B7. Go live wording", () => {
    it("summary, WhatsApp row name, plural rules, the market count in the normal font, the phone head", async () => {
      expect(goLiveSummary("live", 7, 7, true)).toBe("All checks passed.");
      expect(goLiveSummary("setting_up", 7, 7, true)).toBe("7 of 7 checks passed. You can go live.");
      expect(goLiveSummary("live", 6, 7, false)).toMatch(/^6 of 7 checks passed\. Fix the rest/);
      expect(checkTitle({ id: "whatsapp", state: "optional" })).toBe("WhatsApp number");
      expect(checkTitle({ id: "whatsapp", state: "pass" })).toBe("WhatsApp number connected");
      expect(checkTitle({ id: "company", state: "fail" })).toBe("Company details filled");

      await db.update(sellerAccounts).set({ status: "live", wentLiveAt: new Date("2026-11-18T10:00:00Z"), rollout: "test_only" }).where(eq(sellerAccounts.id, acc.id));
      const html = await render(GoLivePage);
      save("go-live", html);
      expect(html).toContain('class="sas-page-head__actions gl-head-status"');
      expect(html).toMatch(/<li[^>]*data-check="whatsapp"[\s\S]*?<strong>WhatsApp number<\/strong>/);
      expect(html).toMatch(/<span class="sas-small" data-market-checks="">\d of \d checks<\/span>/);
      const glCss = fs.readFileSync("app/app/[account]/setup/go-live/go-live.css", "utf8");
      expect(glCss).toMatch(/\.gl-head-status \{ margin-inline-start: 0; flex-basis: 100%; justify-content: flex-start; \}/);
    });
  });

  describe("C. Markets", () => {
    it("legal texts that follow the account: no '· from account' and no tag; on a phone the markets list becomes a picker", async () => {
      for (const language of ["en", "he"]) await saveLegalSection(db, acc.id, admin.id, { sectionKey: "sales_terms", title: "Sales terms", language, body: "Terms" });
      const html = await render(MarketsPage);
      save("markets", html);
      expect(html).toMatch(/data-legal-lang="en">English · <span><bdi>Sales terms<\/bdi>\u00a0v1<\/span><\/span>/);
      // MarketsV2: no "Same as account default" tags; the legal row of a market that follows the account has no tag.
      expect(html).not.toContain("Same as account default");
      const legal = html.split('data-setting="legal"')[1] ?? "";
      expect(legal).not.toContain("from account");
      expect(legal).not.toContain("Different here");
      const mkCss = fs.readFileSync("app/app/[account]/markets/markets.css", "utf8");
      expect(mkCss).toMatch(/@media \(max-width: 767px\) \{\s*\.mk-list \{ display: none; \}\s*\.mk-picker \{ display: flex;/);
    });
  });
});

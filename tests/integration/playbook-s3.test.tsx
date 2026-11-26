/**
 * Playbook rethink, slice S3 (Previews and gaps), against the database.
 * Scripted only: no model is called.
 *
 * - No objections gap (removed): since O1 every objection the agent records
 *   names its play, and every play is an approved way to handle it, so the
 *   gap could only list pre-O1 entries. Regression from production
 *   (polar-demo-2026-11-17-10-40-25): "expensive" was listed although Too
 *   expensive was Ready with a 5% discount limit.
 * - Each preview renders the real template output for the draft (en and he).
 * - Objections: the add row can open prefilled (`?words=`).
 * - Limits shows the always-on hand-over line in the read state (the full list
 *   behind its (i): playbook-info.test.tsx); Sales plays
 *   rows are name + summary + state; one-line part descriptions.
 *
 * With PBS3_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { dealStates, leadPages, leadPageSubmissions, leads, users, type Playbook, type SellerAccount, type StoredObjection, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
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
const { defaultPlaybook } = await import("@/lib/agent/playbook");
const { sampleOpenerText } = await import("@/lib/agent/core/opener");
const { reminderText } = await import("@/lib/orders/unpaid-reminders");
const { default: HomePage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: PlaysPage } = await import("@/app/app/[account]/setup/playbook/plays/page");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const DAY = 86_400_000;

const RICH = (base: Playbook): Playbook => ({
  ...base, agentName: "Maya", agentGender: "female", agentNameLocal: { he: "מאיה" },
  objections: [{ objection: "We already pay for an alarm company.", answer: "An alarm covers doors, not temperature." }],
  opener: { topics: [{ en: "monitoring your fridge temperatures", he: "ניטור טמפרטורות במקררים" }, { en: "monitoring a cold room" }], defaultTopic: 0, question: { en: "How do you check them today?", he: "איך אתם בודקים היום?" } },
  plays: { competitor: { facts: [{ text: "We log every 5 minutes." }] } } as Playbook["plays"],
  unpaidReminders: { first: { days: 3, on: true }, second: { days: 6, on: true }, team: { days: 8, on: true } },
} as Playbook);

describe("Playbook S3: previews; no objections gap", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let other: SellerAccount;
  const now = new Date();
  const css = ["components/sas/sas.css", "app/app/[account]/setup/playbook/playbook.css"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  const save = (name: string, html: string) => {
    const dir = process.env.PBS3_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="sas-app"><div class="sas-shell"><nav class="sas-shell__nav"></nav><div class="sas-shell__main">${html}</div></div></div></body></html>`);
  };
  const render = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) => {
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
    return renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: acc.slug, ...params }), searchParams: Promise.resolve(sp) }));
  };
  const part = (name: string, sp: Record<string, string> = {}) => render(PartPage, { part: name }, sp);
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  /** The text of the element with this data-testid (a preview bubble). */
  const bubble = (html: string, id: string) => {
    const m = html.match(new RegExp(`data-testid="${id}"[^>]*>(.*?)</p>`));
    return m ? text(m[1]) : null;
  };

  const lead = async (accountId: string, name: string, extra: Partial<typeof leads.$inferInsert> = {}) =>
    (await db.insert(leads).values({ accountId, fullName: name, phone: `+97250${Math.floor(Math.random() * 1e7)}`, language: "en", origin: "manual", ...extra }).returning())[0];
  const deal = (accountId: string, leadId: string, objections: StoredObjection[], daysAgo = 5) =>
    db.insert(dealStates).values({ accountId, leadId, objections, updatedAt: new Date(now.getTime() - daysAgo * DAY) });
  const PROD_WORDS = "Sounds expensive; compares to a simple 200 ILS one-time sensor";
  const obj = (play: string, words: string): StoredObjection => ({ play, words, steps: [1], status: "open", attempts: 1 } as StoredObjection);

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-pbs3", email: "pbs3@p.test", firstName: "Dana" }).returning();
    const mk = async (name: string, email: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: email });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    };
    acc = await mk("Polar Demo", "o@polar-s3.test");
    other = await mk("Other Co", "o@other-s3.test");
    await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, RICH(defaultPlaybook("Polar Demo", 0)));

    // The production case: the same buyer words once as a pre-O1 entry (no play) and once with the play.
    await saveDraftPlaybook(db, acc.id, { ...RICH(defaultPlaybook("Polar Demo", 0)), maxDiscountBp: 500 });
    const a = await lead(acc.id, "Avi");
    await deal(acc.id, a.id, [{ text: "expensive", handled: false }, { text: PROD_WORDS, handled: true }]);
    const b = await lead(acc.id, "Bina");
    await deal(acc.id, b.id, [obj("too_expensive", "expensive"), obj("too_expensive", PROD_WORDS), obj("not_now", "Maybe next quarter")]);
  }, 120_000);
  afterAll(async () => t.close());

  describe("Objections and home: no objections gap", () => {
    it("regression (production): objections the agent attributed to a play are not listed as unanswered; no gap block, note or Worth a look entry", async () => {
      const objections = await part("objections");
      save("objections", objections);
      const home = await render(HomePage, {});
      save("home", home);
      for (const html of [objections, home]) {
        const s = text(html);
        expect(html).not.toContain('data-testid="objection-gaps"');
        expect(html).not.toContain('data-gap="objections"');
        expect(s).not.toContain("buyer raised");
        expect(s).not.toContain("expensive”");
        expect(s).not.toContain("Maybe next quarter");
      }
      // Plays: one has facts, so no plays note (UX after S2).
      expect(home).not.toContain('data-gap="plays"');
    });
    it("Objections: the add row still opens prefilled with ?words=", async () => {
      const add = await part("objections", { edit: "objection.add", words: "too pricey" });
      expect(add).toMatch(/id="pb-objection\.new\.objection"[^>]*value="too pricey"/);
    });
  });

  describe("previews: the real template output", () => {
    it("Agent: the first message from the draft in English and Hebrew, name and role words tinted; two columns", async () => {
      const html = await part("agent");
      save("agent", html);
      const p = (await ensureDraftVersion(db, acc.id)).playbook;
      expect(html).toContain('data-with-preview=""');
      expect(bubble(html, "agent-preview-en")).toBe(sampleOpenerText(p, acc, "en"));
      expect(html).toContain('data-preview-langs=""');
      expect(html).toMatch(/data-testid="agent-preview-en"[^>]*><span>Hi Rina, this is <\/span><mark class="pb-tint" data-tint="">Maya<\/mark>/);
      // Who takes calls is used by no template: not in the preview.
      expect(html.slice(html.indexOf('data-testid="part-preview"'))).not.toContain("a member of our team");
      expect(html).toContain("Preview</button>");
    });
    it("Agent in Hebrew (an account that sells only in Hebrew: no switch)", async () => {
      const heAcc = { ...acc, languages: ["he"] };
      holder.access = { account: heAcc, user: me, actingAs: false, role: "seller_admin" };
      const html = renderToStaticMarkup(await (PartPage as unknown as Page)({ params: Promise.resolve({ account: acc.slug, part: "agent" }), searchParams: Promise.resolve({}) }));
      save("agent-he", html);
      const p = (await ensureDraftVersion(db, acc.id)).playbook;
      expect(bubble(html, "agent-preview-he")).toBe(sampleOpenerText(p, heAcc, "he"));
      expect(html).toContain('<mark class="pb-tint" data-tint="">מאיה</mark>');
      expect(html).toContain('<mark class="pb-tint" data-tint="">העוזרת האוטומטית</mark>');
      expect(html).not.toContain('data-preview-langs=""');
    });
    it("Opening: the default topic's message (the bottom preview moved to the right column)", async () => {
      const html = await part("opening");
      save("opening", html);
      const p = (await ensureDraftVersion(db, acc.id)).playbook;
      expect(bubble(html, "opening-preview-en")).toBe(sampleOpenerText(p, acc, "en"));
      expect(html).toContain("Topic: monitoring your fridge temperatures (default)");
      expect(html).toMatch(/<mark class="pb-tint" data-tint="">monitoring your fridge temperatures<\/mark>/);
      expect(html.match(/data-pick-topic="/g)?.length).toBe(2);
      expect(html).toContain('data-pick-topic="0"');
      expect(html.indexOf('data-testid="part-preview"')).toBeGreaterThan(html.indexOf('data-topic-hint=""'));
    });
    it("After the order: What the buyer gets, the real reminder texts with the draft's days, and the team's item", async () => {
      const html = await part("after");
      save("after", html);
      const s = text(html);
      expect(s).toContain("What the buyer gets");
      expect(s).toContain("3 days after signing");
      expect(s).toContain("6 days after signing");
      const first = reminderText({ step: "first", language: "en", leadName: "Rina", order: "PD-10002", amountMinor: 385860, currency: "ILS", bankTransfer: false });
      expect(html).toContain(`data-preview-reminder="first">${first}</p>`);
      expect(s).toContain("Your order from Polar Demo is waiting for payment: [chat link]");
      expect(s).toContain("Signed 8 days ago, not paid");
      expect(s).toContain("PD-10002 · ₪3,858.60 · 2 reminders sent");
      // The left column keeps the card; the wording moved to the preview.
      expect(html).toContain('data-testid="unpaid-card"');
      expect(html).not.toContain('data-testid="unpaid-wording"');
    });
    it("parts without a preview keep one column (What it asks, Objections, Limits, Never do, How a deal closes, Sales plays)", async () => {
      for (const name of ["asks", "objections", "limits", "never", "close"]) expect(await part(name)).not.toContain('data-with-preview=""');
      expect(await render(PlaysPage, {})).not.toContain('data-with-preview=""');
    });
  });

  describe("UX polish", () => {
    it("Limits: the always-on hand-over line in the read state", async () => {
      const html = await part("limits");
      save("limits", html);
      expect(text(html)).toContain("Also always when the buyer is upset or insists on a person.");
      expect(html).toContain('data-handoff-always-read=""');
    });
    it("one-line part descriptions; short stepper hints; the rest behind the disclosures", async () => {
      const asks = text(await part("asks"));
      expect(asks).toContain("The questions the agent may ask. The answers become the deal's facts.");
      expect(asks).toContain("The most it asks before it recommends; 3 suits most sales. Only its own questions count.");
      expect(asks).toContain("Each question's role decides how hard the agent pushes for the answer.");
      const objections = text(await part("objections"));
      expect(objections).toContain("Then it offers to come back later, then a call. 2 suits most sales.");
      const plays = await render(PlaysPage, {});
      save("plays", plays);
      expect(text(plays)).toContain("Short cards the agent follows in specific situations. Your facts make them specific.");
      expect(plays).toContain('data-testid="plays-how"');
    });
    it("Sales plays rows: name, one-line summary and state; Needs your facts in the muted tag style", async () => {
      const html = await render(PlaysPage, {});
      expect(html).not.toContain("data-facts=");
      expect(html).toMatch(/<span class="sas-pill" data-state="needs">Needs your facts<\/span>/);
      expect(html).not.toContain("pb-state-needs");
    });
  });
});

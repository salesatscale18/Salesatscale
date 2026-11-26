/**
 * Playbook rethink, slice S3 (Previews and gaps), against the database.
 * Scripted only: no model is called.
 *
 * - The objections gap: real leads only (no test-lab, simulated or
 *   preview-only leads), deals active in the last 90 days, account-scoped,
 *   the matching rule against the playbook, one query.
 * - Each preview renders the real template output for the draft (en and he).
 * - Objections shows the gap line with "Add an answer" (prefilled add row);
 *   home shows the note and the "Worth a look" entry.
 * - Limits shows the always-on hand-over line in the read state; Sales plays
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
const { raisedObjections, objectionGaps } = await import("@/lib/agent/objection-gaps");
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

describe("Playbook S3: previews and the objections gap", () => {
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

    // Real buyers.
    const a = await lead(acc.id, "Avi");
    await deal(acc.id, a.id, [obj("too_expensive", "too pricey"), obj("competitor", "X is cheaper"), { text: "We have no budget", handled: false }]);
    const b = await lead(acc.id, "Bina");
    await deal(acc.id, b.id, [obj("too_expensive", "Too expensive for us"), obj("existing_solution", "we already pay for an alarm company")]);
    const c = await lead(acc.id, "Carmel");
    await deal(acc.id, c.id, [obj("too_expensive", "too pricey")], 89);
    // Not counted: test lab, simulated, older than 90 days, preview-only, another account.
    await deal(acc.id, (await lead(acc.id, "Test", { isTest: true })).id, [obj("too_expensive", "test lab")]);
    await deal(acc.id, (await lead(acc.id, "Sim", { buyerRef: "SIM-0001" })).id, [obj("too_expensive", "simulated")]);
    await deal(acc.id, (await lead(acc.id, "Old")).id, [obj("too_expensive", "old")], 91);
    const [page] = await db.insert(leadPages).values({ id: crypto.randomUUID(), accountId: acc.id, publicKey: "pk-s3", name: "Demo page", connection: "link", language: "en" }).returning();
    const previewOnly = await lead(acc.id, "Preview only");
    const both = await lead(acc.id, "Preview then real");
    await db.insert(leadPageSubmissions).values([
      { id: crypto.randomUUID(), accountId: acc.id, pageId: page.id, leadId: previewOnly.id, via: "link", leadCreated: true, consent: true, preview: true, language: "en", sourceKey: "" },
      { id: crypto.randomUUID(), accountId: acc.id, pageId: page.id, leadId: both.id, via: "link", leadCreated: true, consent: true, preview: true, language: "en", sourceKey: "" },
      { id: crypto.randomUUID(), accountId: acc.id, pageId: page.id, leadId: both.id, via: "link", leadCreated: false, consent: true, preview: false, language: "en", sourceKey: "" },
    ]);
    await deal(acc.id, previewOnly.id, [obj("not_now", "preview words")]);
    await deal(acc.id, both.id, [obj("not_now", "Maybe next quarter")]);
    await deal(other.id, (await lead(other.id, "Elsewhere")).id, [obj("too_expensive", "other account"), obj("proof", "show me")]);
  }, 120_000);
  afterAll(async () => t.close());

  describe("the count", () => {
    it("real leads only, last 90 days, this account only, grouped by play and words (one query)", async () => {
      const raised = await raisedObjections(db, acc.id, now);
      const key = (r: { play: string | null; words: string; deals: number }) => `${r.play}|${r.words}|${r.deals}`;
      expect(raised.map(key).sort()).toEqual([
        "competitor|X is cheaper|1",
        "existing_solution|we already pay for an alarm company|1",
        "not_now|Maybe next quarter|1",
        "null|We have no budget|1",
        "too_expensive|Too expensive for us|1",
        "too_expensive|too pricey|2",
      ]);
      const words = raised.map((r) => r.words);
      for (const w of ["test lab", "simulated", "old", "preview words", "other account", "show me"]) expect(words).not.toContain(w);
      expect((await raisedObjections(db, other.id, now)).map(key).sort()).toEqual(["proof|show me|1", "too_expensive|other account|1"]);
      // The window moves with "now": 3 days later the 89-day deal has left it.
      expect((await raisedObjections(db, acc.id, new Date(now.getTime() + 3 * DAY))).find((r) => r.words === "too pricey")?.deals).toBe(1);
    });
    it("matched against the playbook: plays with facts and approved objections with the same words are answered", async () => {
      const p = (await ensureDraftVersion(db, acc.id)).playbook;
      expect(objectionGaps(await raisedObjections(db, acc.id, now), p)).toEqual([
        { play: "too_expensive", deals: 3, words: "too pricey" },
        { play: "not_now", deals: 1, words: "Maybe next quarter" },
        { play: null, deals: 1, words: "We have no budget" },
      ]);
    });
  });

  describe("Objections and home", () => {
    it("Objections: the gap line at the bottom, each with Add an answer (the add row prefilled with the buyer's words)", async () => {
      const html = await part("objections");
      save("objections", html);
      const s = text(html);
      expect(html).toContain('data-testid="objection-gaps"');
      expect(s).toContain("Raised by buyers, no approved answer yet");
      expect(s).toContain("3 buyers raised “too pricey” · Too expensive");
      expect(s).toContain("1 buyer raised “We have no budget”");
      expect(s).toContain("1 buyer raised “Maybe next quarter” · Not now");
      expect(html).toContain(`href="/app/${acc.slug}/setup/playbook/objections?edit=objection.add&amp;words=too+pricey"`);
      const add = await part("objections", { edit: "objection.add", words: "too pricey" });
      save("objections-add", add);
      expect(add).toMatch(/id="pb-objection\.new\.objection"[^>]*value="too pricey"/);
    });
    it("no gap line when every raised objection has an answer", async () => {
      const { savePlaybookRowAction } = await import("@/app/app/[account]/setup/playbook/actions");
      holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" };
      const before = (await ensureDraftVersion(db, acc.id)).playbook;
      for (const o of ["too pricey", "We have no budget", "Maybe next quarter"]) {
        expect(await savePlaybookRowAction(acc.slug, { kind: "add", list: "objections", item: { objection: o, answer: "An answer.", source: "" } })).toEqual({ ok: true });
      }
      // "Too expensive" still raised as "Too expensive for us": the approved "too pricey" does not say the same.
      expect(text(await part("objections"))).toContain("1 buyer raised “Too expensive for us”");
      await saveDraftPlaybook(db, acc.id, { ...before, maxDiscountBp: 500, objections: [...before.objections, { objection: "We have no budget", answer: "a" }, { objection: "next quarter", answer: "b" }] });
      expect(await part("objections")).not.toContain('data-testid="objection-gaps"');
      await saveDraftPlaybook(db, acc.id, before);
    });
    it("home: the Objections row's note and the Worth a look entry (several: the list)", async () => {
      const html = await render(HomePage, {});
      save("home", html);
      expect(html).toMatch(/data-part="objections"[^]*?<span class="pb-home__gap" data-gap="objections">3 objections buyers raised have no answer yet\.<\/span>/);
      expect(html).toMatch(/<li data-gap="objections">3 objections buyers raised have no answer yet\. <a href="\/app\/[^"]+\/setup\/playbook\/objections">Add one<\/a><\/li>/);
      // Plays: one has facts, so no plays note (UX after S2).
      expect(html).not.toContain('data-gap="plays"');
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
      expect(text(html)).toContain("Also always when the buyer is upset, complains or insists on a person, raises a legal or existing-customer issue, or the agent can't reply.");
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

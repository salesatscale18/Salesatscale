/**
 * O7: the objection scenarios end to end on PGlite with the demo account. Each
 * buyer turn runs through runBuyerTurn with ScriptedLlm (the tools run for
 * real), then the scenario check reads what was recorded. Also: the test lab's
 * scenarios table lists the new scenarios with what each one checks.
 *
 * With O7_RENDER_DIR set, the rendered test lab is also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { conversations, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { ScriptedLlm, type Block, type LlmRequest } from "@/lib/agent/llm";
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
  useRouter: () => ({ refresh: () => {} }),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { startTestConversation } = await import("@/lib/agent/service");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { conversationScenarioCheck } = await import("@/lib/agent/scenario-results");
const { scenarioById, SCENARIOS } = await import("@/lib/agent/scenarios");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { default: OverviewPage } = await import("@/app/app/[account]/page");
const { default: LeadsPage } = await import("@/app/app/[account]/leads/page");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.O7_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });
type Step = (req: LlmRequest) => { content: Block[] };
/** One model response. Tool-use ids are new on every run: a tool call is recorded once per id. */
const step = (...content: Block[]): Step => () => ({ content: content.map((b) => (b.type === "tool_use" ? { ...b, id: `${b.id}-${crypto.randomUUID()}` } : b)) });
const lastResult = (req: LlmRequest) => JSON.parse(((req.messages.at(-1)!.content as { content: string }[])[0]).content);
const deal = (objection: unknown, updates: { key: string; value: string; provenance: string }[] = []) =>
  ({ updates, next_step: null, objection, recommendation_confirmed: null, price_asked: null, asked: null });
const obj = (play: string, s: number | null, status = "open", attempt = false) => ({ play, buyer_words: "x", step: s, attempt, status });
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

describe("O7: objection scenarios end to end (ScriptedLlm)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User, seller: User;
  let account: SellerAccount;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa_o7", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u_o7", email: "u@seller.test", role: "user", firstName: "Sam" },
    ]).returning();
    const r = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!r.ok) throw new Error("demo seed refused");
    await db.update(sellerAccounts).set({ contactHours: ALL_DAY }).where(eq(sellerAccounts.id, r.summary.accountId));
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.summary.accountId));
    holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
  }, 120_000);
  afterAll(async () => t.close());

  /** Plays the scenario's buyer messages, one scripted agent turn each, and returns the check. */
  async function play(id: string, turns: Step[][]) {
    const s = scenarioById(id)!;
    const c = (await startTestConversation(db, account.id, seller.id, { language: "en", scenario: id }))!;
    const texts = [s.opening, ...(s.buyerTurns ?? [])];
    for (let i = 0; i < turns.length; i++) {
      const out = await runBuyerTurn(db, /* a copy: ScriptedLlm consumes its script */ new ScriptedLlm([...turns[i]]), { accountId: account.id, conversationId: c.conversationId, text: texts[i] });
      expect(out.status, `turn ${i + 1}: ${JSON.stringify(out)}`).toBe("replied");
    }
    const [row] = await db.select().from(conversations).where(eq(conversations.id, c.conversationId));
    return (await conversationScenarioCheck(db, account.id, row))!;
  }
  const fields = [
    { key: "business_type", value: "Cafe", provenance: "buyer" },
    { key: "sites", value: "1", provenance: "buyer" },
  ];
  const quoteTurn = (sensors: number): Step[] => [
    step(use("u", "update_deal_state", { ...deal(null, fields), recommendation_confirmed: true })),
    step(use("q", "create_quote", { lines: [{ sku: "SNS-200", qty: sensors }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null, headline: null, assumed: null })),
    step(say("Here is your quote.")),
  ];
  const objectionTurn = (o: unknown, text: string): Step[] => [step(use("o", "update_deal_state", deal(o))), step(say(text))];

  it("two objections in a row: passes with both recorded and a new price step; fails when a step is repeated", async () => {
    const start = [
      quoteTurn(2),
      objectionTurn(obj("too_expensive", 1), "I understand. Is it more than you planned to spend, or more than another offer?"),
      objectionTurn(obj("someone_else_decides", 1), "Of course. What will your partner care about most?"),
    ];
    expect(await play("two_objections", [...start, objectionTurn(obj("too_expensive", 2, "open", true), "It costs less than one spoiled delivery a month.")]))
      .toMatchObject({ result: "passed" });
    expect(await play("two_objections", [...start, objectionTurn(obj("too_expensive", 1), "Is it more than you planned, or more than another offer?")]))
      .toMatchObject({ result: "failed", reason: expect.stringContaining("used twice") });
  });

  it("buying signal mid-objection: passes when the order form goes out at once; fails on another objection step", async () => {
    const start = [quoteTurn(5), objectionTurn(obj("too_expensive", 1), "I understand. Is it more than you planned to spend?")];
    const close: Step[] = [
      step(use("o", "update_deal_state", { ...deal(obj("too_expensive", null, "settled")), recommendation_confirmed: true })),
      // The quote number from the conversation so far (the quote turn).
      (req) => step(use("s", "send_order_form", { quote: JSON.stringify(req.messages).match(/Q-\d+/g)?.at(-1) ?? "" }))(req),
      step(say("Great. The order form is below.")),
    ];
    const passed = await play("buying_signal", [...start, close]);
    expect(passed).toMatchObject({ result: "passed", reason: expect.stringContaining("closed at once") });
    expect(await play("buying_signal", [...start, objectionTurn(obj("too_expensive", 2, "open", true), "Before that: the price includes setup and support.")]))
      .toMatchObject({ result: "failed", reason: expect.stringContaining("another objection step") });
  });

  it("unknown question, must-have: passes on a silent ask and a call after the must-have; fails on a call at once", async () => {
    const ask = (mustHave: boolean | null) => use("a", "ask_team", { question: "Does it work with an existing alarm panel?", buyer_words: "the alarm panel we already have", must_have: mustHave });
    const first: Step[] = [step(use("l", "lookup_knowledge", { query: "alarm panel compatibility" })), step(ask(null)), step(say("I don't have that detail yet. Is it a must-have, or good to know?"))];
    const callback = use("c", "request_callback", { time: inTwoDays(), brief: "Alarm panel compatibility; two locations" });
    const passed = await play("unknown_must_have", [
      first,
      [step(ask(true)), step(say("Understood, I'll make sure you get an exact answer. How many locations do you have?"))],
      [step(callback), step(say("That point matters, so I've requested a short call with our specialist, who will have the exact answer."))],
    ]);
    expect(passed).toMatchObject({ result: "passed" });
    const early = await play("unknown_must_have", [[step(use("l", "lookup_knowledge", { query: "alarm panel" })), step(ask(null)), step(callback), step(say("Let me set a call for you."))]]);
    expect(early).toMatchObject({ result: "failed", reason: expect.stringContaining("before the buyer said") });
  });

  it("question with no approved answer: \"let me ask the team and come back to you\" fails", async () => {
    const r = await play("no_approved_answer", [[
      step(use("l", "lookup_knowledge", { query: "satellite uplink" })),
      step(use("a", "ask_team", { question: "On-site training?", buyer_words: "on-site training", must_have: null })),
      step(say("Let me ask the team and come back to you.")),
    ]]);
    expect(r).toMatchObject({ result: "failed", reason: expect.stringContaining("told the buyer") });
  });

  it("the test lab's scenarios table lists the new scenarios with what each one checks", async () => {
    const html = renderToStaticMarkup(await (TestLabPage as unknown as Page)({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({}) }));
    save("test-lab", html);
    const row = (id: string) => html.slice(html.indexOf(`data-scenario="${id}"`), html.indexOf("</tr>", html.indexOf(`data-scenario="${id}"`)));
    for (const id of ["price_budget", "price_competitor", "think_partner", "asks_for_person_reflex", "unknown_good_to_know", "unknown_must_have", "buying_signal", "two_objections"]) {
      const s = SCENARIOS.find((x) => x.id === id)!;
      expect(html, id).toContain(`data-scenario="${id}"`);
      expect(row(id)).toContain(esc(s.title));
      expect(row(id)).toContain(esc(s.expected));
      expect(row(id)).toMatch(/data-run="">Run</);
    }
  });

  it("Needs you (Leads, L-3): order and quote IDs are one unbroken run (.sas-id), so a phone never splits \"PD-\" from its number", async () => {
    const overview = renderToStaticMarkup(await (OverviewPage as unknown as Page)({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({}) }));
    save("overview", overview);
    const html = renderToStaticMarkup(await (LeadsPage as unknown as Page)({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ view: "needs_you" }) }));
    save("leads-needs", html);
    // The demo's bank-transfer order: "PD-<n> · <amount>", the order ID inside .sas-id.
    expect(html).toMatch(/<span class="sas-lstep__detail"[^>]*><span class="sas-id sas-id--plain">[A-Z]{2}-\d+<\/span> · [^<]+<\/span>/);
    // No order or quote ID is left as plain text where it could break at the hyphen (tooltips aside).
    const needs = html.split("<tbody>")[1].split("</tbody>")[0];
    const plain = needs.replace(/<span class="sas-id[^"]*"[^>]*>[^<]*<\/span>/g, "").replace(/ title="[^"]*"/g, "").replace(/<[^>]+>/g, " ");
    expect(plain).not.toMatch(/\b(?:[A-Z]{2}|Q)-\d+\b/);
  });
});

/**
 * W4 (board ConvSteps) on PGlite: "Show agent steps" in the Conversations
 * pane, the lead page thread and a saved test lab chat. Off by default in the
 * workspace, on in the test lab, each remembered in its own cookie; markers
 * (hand-off, take-over, hand-back), quote cards and order form notes show in
 * both states; platform admins keep the raw tool name tooltip. No model call:
 * create_quote runs as a tool; the agent replies are stored rows.
 *
 * With STEPS_RENDER_DIR set, the rendered pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { messages, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, cookies: {} as Record<string, string> }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "app.example.com" }),
  cookies: async () => ({ get: (n: string) => (n in holder.cookies ? { name: n, value: holder.cookies[n] } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { ConversationPanel } = await import("@/app/app/[account]/leads/[leadId]/conversation");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const { GET } = await import("@/app/app/[account]/agent-steps/route");
const { NextRequest } = await import("next/server");
const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, getConversation, publishDraftVersion, saveDraftPlaybook, startTestConversation } = await import("@/lib/agent/service");
const { conversationView, handBack, takeOver } = await import("@/lib/agent/conversation");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { STEPS_COOKIE, stepsCookieValue } = await import("@/lib/conversations/agent-steps");

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (P: unknown, params: Record<string, string>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }));

const OUT = process.env.STEPS_RENDER_DIR;
function save(name: string, html: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const css = ["components/sas/sas.css", "components/sas/quote-card.css"].map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
}
const pause = () => new Promise((r) => setTimeout(r, 5));
const CHIP = 'class="sas-msg__trace"';
const STEP_LIST = 'aria-label="Trace"';

describe("Show agent steps", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let dana: User;
  let acc: SellerAccount;
  let leadId = "";
  let convId = "";
  let labConvId = "";
  const as = (user: User, admin = false) => {
    holder.access = { account: acc, user, actingAs: false, role: admin ? "platform_admin" : "seller_admin" };
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "sol@polar.test", firstName: "Sol", role: "user" }).returning();
    [dana] = await db.insert(users).values({ clerkId: "d", email: "dana.levi@polar.test", role: "user" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ allowSimulatedBuyers: true, status: "live" }).where(eq(sellerAccounts.id, acc.id));
    await seedCatalog(db, acc.id, [{ sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" }], []);
    await seedPricing(db, acc.id, [{ sku: "SNS-200", oneTime: 59_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800, name: "Israel 2026 price list" });
    const draft = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, { ...draft.playbook, agentName: "Maya", fields: draft.playbook.fields.filter((f) => f.stage === "before_quote") });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    as(me);

    // A simulated buyer: a quote card, a reply with steps that hands off, Dana takes over and hands back.
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "Rina Cohen", company: "Rina's Kitchen", language: "en", country: "IL" });
    if (!made.ok) throw new Error("buyer");
    leadId = made.lead.id;
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc.id, leadId);
    if (!started.ok) throw new Error(started.reason);
    convId = started.conversationId;
    const playbook = (await ensureDraftVersion(db, acc.id)).playbook;
    await db.insert(messages).values({ accountId: acc.id, conversationId: convId, actor: "buyer", body: "Hi, 2 sensors please.", language: "en" });
    await pause();
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null },
      { db, accountId: acc.id, conversationId: convId, leadId, playbook, currency: "ILS", callId: "u1", language: "en" });
    const r = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 2 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null, headline: null },
      { db, accountId: acc.id, conversationId: convId, leadId, playbook, currency: "ILS", callId: "q1", language: "en" });
    if (!r.result.quote_message_id) throw new Error(JSON.stringify(r.result));
    await db.insert(toolCalls).values({ accountId: acc.id, conversationId: convId, sequence: 1, name: "create_quote", input: {}, result: r.result, outcome: r.outcome });
    await pause();
    const [reply] = await db.insert(messages).values({ accountId: acc.id, conversationId: convId, actor: "agent", body: "Let me ask a colleague about that.", language: "en", deliveryStatus: "delivered" }).returning();
    await db.insert(toolCalls).values([
      { accountId: acc.id, conversationId: convId, messageId: reply.id, sequence: 2, name: "update_deal_state", input: { updates: [] }, result: { ok: true }, outcome: "ok" },
      { accountId: acc.id, conversationId: convId, messageId: reply.id, sequence: 3, name: "hand_off_to_human", input: { reason: "BMS" }, result: { ok: true }, outcome: "ok" },
    ]);
    await pause();
    expect((await takeOver(db, { userId: dana.id, actingAs: false }, acc.id, convId)).ok).toBe(true);
    await pause();
    expect((await handBack(db, { userId: dana.id, actingAs: false }, acc.id, convId)).ok).toBe(true);

    // A saved test lab chat with one agent reply and its steps.
    const lab = await startTestConversation(db, acc.id, me.id, { language: "en" });
    if (!lab) throw new Error("lab");
    labConvId = lab.conversationId;
    await db.insert(messages).values({ accountId: acc.id, conversationId: labConvId, actor: "buyer", body: "Hello", language: "en" });
    await pause();
    const [labReply] = await db.insert(messages).values({ accountId: acc.id, conversationId: labConvId, actor: "agent", body: "Hi! How many sites?", language: "en" }).returning();
    await db.insert(toolCalls).values({ accountId: acc.id, conversationId: labConvId, messageId: labReply.id, sequence: 1, name: "lookup_knowledge", input: { query: "sites" }, result: { facts: [] }, outcome: "ok" });
  }, 120_000);
  afterAll(async () => t.close());

  const inbox = (sp: Record<string, string> = {}) => page(ConversationsPage, { account: acc.slug }, { c: convId, ...sp });
  const leadPage = (sp: Record<string, string> = {}) => page(LeadCardPage, { account: acc.slug, leadId }, sp);
  const labPage = (sp: Record<string, string> = {}) => page(TestLabPage, { account: acc.slug }, { c: labConvId, ...sp });

  it("builds the markers from the tool call and the lead events", async () => {
    const view = await conversationView(db, acc.id, (await getConversation(db, acc.id, convId))!);
    expect(view.markers?.map((m) => m.kind)).toEqual(["handoff", "taken_over", "handed_back"]);
  });

  it("Conversations: off by default; chips hidden; markers, quote card shown", async () => {
    holder.cookies = {};
    const html = await inbox();
    save("inbox-off", html);
    expect(html).toContain('data-agent-steps="off"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain(CHIP);
    expect(html).toContain('data-thread-marker="handoff"');
    expect(html).toContain("The agent asked for a person");
    expect(html).toContain('data-thread-marker="taken_over"');
    expect(html).toContain("Chat taken over by");
    expect(html).toContain("dana.levi");
    expect(html).not.toContain("dana.levi@polar.test");
    expect(html).toContain('data-thread-marker="handed_back"');
    expect(html).toContain('data-kind="quote"');
    // The switch is a GET form to the route, back to this thread.
    expect(html).toContain(`action="/app/${acc.slug}/agent-steps"`);
    expect(html).toContain('name="show" value="1"');
  });

  it("Conversations: the workspace cookie turns the chips on; markers and the quote card stay", async () => {
    holder.cookies = { [STEPS_COOKIE.workspace]: stepsCookieValue(me.id, true) };
    const html = await inbox();
    save("inbox-on", html);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(CHIP);
    expect(html).toContain("Deal details updated");
    expect(html).toContain('data-thread-marker="handoff"');
    expect(html).toContain('data-thread-marker="taken_over"');
    expect(html).toContain('data-kind="quote"');
    // Sellers see no raw tool names.
    expect(html).not.toContain("deal_state.update");
  });

  it("the test lab cookie does not change the workspace, and the URL wins", async () => {
    holder.cookies = { [STEPS_COOKIE.lab]: stepsCookieValue(me.id, true) };
    expect(await inbox()).not.toContain(CHIP);
    holder.cookies = { [STEPS_COOKIE.workspace]: stepsCookieValue(me.id, true) };
    expect(await inbox({ steps: "0" })).not.toContain(CHIP);
    // Another person's choice on the same browser does not apply.
    holder.cookies = { [STEPS_COOKIE.workspace]: stepsCookieValue(dana.id, true) };
    expect(await inbox()).not.toContain(CHIP);
  });

  it("lead page: off by default, on with the workspace cookie; markers both ways", async () => {
    holder.cookies = {};
    const off = await leadPage();
    save("lead-off", off);
    expect(off).toContain('data-agent-steps="off"');
    expect(off).not.toContain(CHIP);
    expect(off).toContain('data-thread-marker="handed_back"');
    expect(off).toContain(`name="back" value="/app/${acc.slug}/leads/${leadId}#conversation"`);
    holder.cookies = { [STEPS_COOKIE.workspace]: stepsCookieValue(me.id, true) };
    const on = await leadPage();
    expect(on).toContain(CHIP);
    expect(on).toContain('data-thread-marker="handed_back"');
  });

  it("platform admins keep the raw tool name tooltip when steps are shown", async () => {
    as(me, true);
    holder.cookies = { [STEPS_COOKIE.workspace]: stepsCookieValue(me.id, true) };
    expect(await inbox()).toContain('title="deal_state.update');
    holder.cookies = {};
    expect(await inbox()).not.toContain("deal_state.update");
    as(me);
  });

  it("test lab: on by default; the lab cookie hides the steps; the workspace cookie does not", async () => {
    holder.cookies = {};
    const on = await labPage();
    save("lab-on", on);
    expect(on).toContain('data-agent-steps="on"');
    expect(on).toContain(STEP_LIST);
    holder.cookies = { [STEPS_COOKIE.workspace]: stepsCookieValue(me.id, false) };
    expect(await labPage()).toContain(STEP_LIST);
    holder.cookies = { [STEPS_COOKIE.lab]: stepsCookieValue(me.id, false) };
    const off = await labPage();
    save("lab-off", off);
    expect(off).toContain('data-agent-steps="off"');
    expect(off).not.toContain(STEP_LIST);
    expect(off).toContain("Hi! How many sites?");
  });

  it("order form notes and quote cards show with the steps off and on", async () => {
    const conv = (await getConversation(db, acc.id, convId))!;
    const view = await conversationView(db, acc.id, conv);
    const notes = [{ id: "n1", at: new Date(), who: "you", url: "https://x.test/f/abc", closed: false }];
    for (const show of [false, true]) {
      const html = renderToStaticMarkup(
        <ConversationPanel slug={acc.slug} view={view} me={me} buyerName="Rina" leadOptedOut={false} notes={notes} steps={{ show, back: `/app/${acc.slug}/conversations` }} />,
      );
      expect(html).toContain('data-thread-note="order_form"');
      expect(html).toContain('data-kind="quote"');
      expect(html).toContain('data-thread-marker="handoff"');
      expect(html.includes(CHIP)).toBe(show);
    }
  });

  it("the route stores the choice for this user and scope, and returns only inside the account", async () => {
    as(me);
    const call = async (q: string) => GET(new NextRequest(`https://app.example.com/app/${acc.slug}/agent-steps?${q}`), { params: Promise.resolve({ account: acc.slug }) });
    const r1 = await call(`scope=lab&show=0&back=${encodeURIComponent(`/app/${acc.slug}/setup/test-lab?c=${labConvId}&steps=1`)}`);
    expect(r1.status).toBe(303);
    expect(r1.headers.get("location")).toBe(`https://app.example.com/app/${acc.slug}/setup/test-lab?c=${labConvId}`);
    expect(r1.cookies.get(STEPS_COOKIE.lab)?.value).toBe(`${me.id}.0`);
    expect(r1.cookies.get(STEPS_COOKIE.workspace)).toBeUndefined();
    const r2 = await call("scope=workspace&show=1&back=https%3A%2F%2Fevil.test%2F");
    expect(r2.headers.get("location")).toBe(`https://app.example.com/app/${acc.slug}`);
    expect(r2.cookies.get(STEPS_COOKIE.workspace)?.value).toBe(`${me.id}.1`);
    const r3 = await call("scope=other&show=1");
    expect(r3.cookies.getAll()).toEqual([]);
  });
});

/**
 * KnowledgeV2 (UX board, 24 Nov): "Questions to answer" is its own entry at
 * the top of Knowledge's left list, with its own view (?view=questions) split
 * into "Buyers asked" and "Missing from your sources". Topic pages and All
 * topics show only facts. On PGlite with the demo account; no model call.
 *
 * With R35_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { conversations, leads, pipelineRuns, sellerAccounts, toolCalls, users, type PipelineUsage, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { createDemoAccount } = await import("@/lib/demo/seed");
const { answerQuestion, startTestConversation, listVersions, unansweredQuestions } = await import("@/lib/agent/service");
const { sourceGaps } = await import("@/lib/pipeline/service");
const { OPEN_QUESTIONS } = await import("@/lib/demo/states");
const { needsYouHref } = await import("@/lib/overview/service");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");
const knowledge = await import("@/app/app/[account]/setup/knowledge/actions");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.R35_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.append(k, val);
  return f;
};
const go = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return url;
    throw e;
  }
  throw new Error("no redirect");
};
/** The question texts of one card of the questions view, in order. */
const group = (html: string, g: "asked" | "sources") => {
  const at = html.indexOf(`data-question-group="${g}"`);
  if (at < 0) return [];
  const card = html.slice(at, html.indexOf("</section>", at));
  return [...card.matchAll(/<li data-question=""[^>]*><span[^>]*><strong[^>]*>([^<]+)<\/strong>/g)].map((m) => m[1].replace(/&#x27;/g, "'"));
};

const GAPS = [
  "What is the delivery lead time for sensors and gateways?",
  "Is there a minimum contract period for the monitoring plan?",
  "What payment methods are accepted?",
  "Do you offer a discount for schools?",
  "Can a gateway run on battery during a power cut?",
];
/** Asked by a buyer in a test chat, after the demo's own questions: the newest buyer question. */
const NEWEST = "Do you offer satellite connection for the hubs?";

describe("KnowledgeV2: Questions to answer", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let seller: User;
  let account: SellerAccount;
  let slug: string;
  const render = async (sp: Record<string, string> = {}) =>
    renderToStaticMarkup(await (KnowledgePage as unknown as Page)({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) }));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    const [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" }).returning();
    [seller] = await db.insert(users).values({ clerkId: "c_u", email: "u@seller.test", role: "user", firstName: "Sam" }).returning();
    const r = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!r.ok) throw new Error("demo seed refused");
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.summary.accountId));
    slug = account.slug;
    holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
    // An analysis that found five gaps; one of them a buyer also asked (listed once, under Buyers asked).
    await db.insert(pipelineRuns).values({
      id: crypto.randomUUID(), accountId: account.id, kind: "facts", status: "done",
      // The run's data (lib/pipeline RunData) is stored in the usage column.
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1, result: { factsAdded: 0, contradictions: [], gaps: [...GAPS, OPEN_QUESTIONS[0]].map((question) => ({ topic: "Delivery", question })) } } as PipelineUsage,
    });
    const live = (await listVersions(db, account.id)).find((v) => v.status === "live")!;
    const c = await startTestConversation(db, account.id, seller.id, { language: "en", versionId: live.id });
    await db.insert(toolCalls).values({
      accountId: account.id, conversationId: c!.conversationId, sequence: 1, name: "lookup_knowledge", input: { query: NEWEST }, result: { facts: [] }, outcome: "ok",
      createdAt: new Date(Date.now() + 60_000),
    });
  }, 120_000);
  afterAll(async () => t.close());

  it("the entry sits at the top of the left list, above the Topics label, with an amber count; the header says how many", async () => {
    const html = await render();
    save("kv2-all-topics", html);
    const total = (await unansweredQuestions(db, account.id, 10)).length + GAPS.length;
    expect(total).toBe(OPEN_QUESTIONS.length + 1 + GAPS.length);
    const entry = html.indexOf("data-questions-entry");
    expect(entry).toBeGreaterThan(-1);
    expect(entry).toBeLessThan(html.indexOf(">Topics<"));
    expect(html.indexOf(">Topics<")).toBeLessThan(html.indexOf(">All topics<"));
    expect(html).toMatch(new RegExp(`<a class="sas-subnav__item" data-questions-entry=""[^>]*href="/app/${slug}/setup/knowledge\\?view=questions"`));
    expect(html).not.toMatch(/data-questions-entry="" aria-current/);
    expect(html).toMatch(new RegExp(`class="sas-pill sas-pill--warning" data-questions-count="">${total}<`));
    expect(text(html)).toContain(`· ${total} questions to answer.`);
  });

  it("All topics and a topic page show only facts, with one line pointing to the questions", async () => {
    for (const html of [await render(), await render({ topic: "Installation" })]) {
      expect(html).not.toContain("data-question-group");
      expect(html).not.toContain("data-questions-view");
      for (const q of [...GAPS, NEWEST, ...OPEN_QUESTIONS]) expect(html).not.toContain(q);
      expect(html).toMatch(new RegExp(`data-questions-pointer=""[^]*?href="/app/${slug}/setup/knowledge\\?view=questions"`));
      expect(html).toContain('data-fact="');
    }
    // On a topic page the topic is current, not the questions entry.
    const topic = await render({ topic: "Installation" });
    expect(topic).not.toMatch(/data-questions-entry="" aria-current/);
  });

  it("the view splits buyer questions (newest first) from gaps in the sources, and shows the first 3 gaps before Show more", async () => {
    const html = await render({ view: "questions" });
    save("kv2-questions", html);
    const total = OPEN_QUESTIONS.length + 1 + GAPS.length;
    expect(html).toMatch(/data-questions-entry="" aria-current="page"/);
    expect(text(html)).toContain(`Questions to answer · ${total}`);
    expect(text(html)).toContain("The agent couldn't answer these. Your answer becomes an approved fact.");
    // Buyers asked: the newest first; the gap a buyer also asked is listed here once.
    const asked = group(html, "asked");
    expect(asked[0]).toBe(NEWEST);
    expect([...asked].sort()).toEqual([NEWEST, ...OPEN_QUESTIONS].sort());
    expect(text(html)).toContain(`Buyers asked · ${asked.length}`);
    // Missing from your sources: only gaps no buyer asked, in the analysis order; 3 shown, then "Show 2 more".
    expect(group(html, "sources")).toEqual(GAPS.slice(0, 3));
    expect(text(html)).toContain(`Missing from your sources · ${GAPS.length}`);
    expect(text(html)).toContain("Found while reading what you uploaded. No buyer has asked yet.");
    expect(html).toContain(`<a data-show-more="" href="/app/${slug}/setup/knowledge?view=questions&amp;more=gaps#kq-sources">Show 2 more<`);
    const all = await render({ view: "questions", more: "gaps" });
    expect(group(all, "sources")).toEqual(GAPS);
    expect(all).not.toContain("data-show-more");
    // The facts table, its filters and the conflict cards are not part of this view.
    expect(html).not.toContain('data-fact="');
    expect(html.match(/data-question=""/g)).toHaveLength(asked.length + 3);
    // Every row has its Answer button, opening the same panel over this view.
    expect(html).toContain(`href="/app/${slug}/setup/knowledge?view=questions&amp;panel=answer&amp;question=${encodeURIComponent(GAPS[0]).replace(/%20/g, "+")}"`);
  });

  it("a buyer question shows the chat it came from and the buyer's own words when they differ; a gap has no date", async () => {
    const html = await render({ view: "questions" });
    const at = html.indexOf(OPEN_QUESTIONS[1]);
    const row = html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
    expect(row).toContain("data-asked-by");
    expect(text(row)).toMatch(/Test lab chat|Chat with/);
    expect(row).toContain("“on-site training in our city”");
    expect(row).toContain("data-question-when");
    const gapAt = html.indexOf(GAPS[0]);
    const gapRow = html.slice(html.lastIndexOf("<li", gapAt), html.indexOf("</li>", gapAt));
    expect(gapRow).not.toContain("data-question-when");
    expect(gapRow).not.toContain("data-asked-by");
  });

  it("deep links open the view: Needs you, an older answer link, and the answer form sends the seller back to it", async () => {
    const href = needsYouHref(`/app/${slug}`, { kind: "team_question", question: NEWEST } as Parameters<typeof needsYouHref>[1]);
    expect(href).toBe(`/app/${slug}/setup/knowledge?view=questions&panel=answer&question=${encodeURIComponent(NEWEST).replace(/%20/g, "+")}`);
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    const deep = await render(sp);
    save("kv2-answer", deep);
    expect(deep).toContain("data-questions-view");
    expect(deep).toContain(`data-answer-question="">${NEWEST}<`);
    // Closing the panel stays on the view; the form carries the view back.
    expect(deep).toContain(`href="/app/${slug}/setup/knowledge?view=questions"`);
    expect(deep).toMatch(/name="list" value="view=questions"/);
    // An older link without the view still opens the panel over the questions.
    const old = await render({ panel: "answer", question: GAPS[1] });
    expect(old).toContain("data-questions-view");
    expect(old).toMatch(/name="list" value="view=questions"/);
    const url = await go(knowledge.answerQuestionsAction(form({ slug, list: "view=questions", panel: "answer", "q.0.question": GAPS[1], "q.0.answer": "No minimum period.", "q.0.topic": "Contract" })));
    expect(url).toBe(`/app/${slug}/setup/knowledge?view=questions&done=answered&n=1`);
    const after = await render({ view: "questions" });
    expect(after).not.toContain(GAPS[1]);
    expect(text(after)).toContain(`Missing from your sources · ${GAPS.length - 1}`);
  });

  it("at 0 questions the entry stays without a count and the view says there are none", async () => {
    const open = [...(await unansweredQuestions(db, account.id, 50)).map((q) => q.question), ...(await sourceGaps(db, account.id)).map((g) => g.question)];
    for (const question of new Set(open)) await answerQuestion(db, { userId: seller.id, actingAs: false }, account.id, { question, answer: "Answered.", topic: "General" }, { transport: null });
    const html = await render({ view: "questions" });
    save("kv2-questions-empty", html);
    expect(html).toContain("data-questions-entry");
    expect(html).not.toContain("data-questions-count");
    expect(html).toContain("data-questions-empty");
    expect(text(html)).toContain("No open questions.");
    expect(html).not.toContain("data-question-group");
    const all = await render();
    // The header summary leaves the questions part out at 0.
    expect(text(all)).toMatch(/\d+ facts · \d+ approved · \d+ to review\./);
    expect(text(all)).not.toContain("questions to answer");
    expect(text(all)).not.toContain("question to answer");
    expect(all).not.toContain("data-questions-pointer");
  });

  it("a question the agent only looked up names the chat it came from: the lead (never a full email), a test chat, once per chat", async () => {
    const live = (await listVersions(db, account.id)).find((v) => v.status === "live")!;
    const q = "Does the gateway need its own power socket?";
    const [lead] = await db.insert(leads).values({ accountId: account.id, fullName: "dana.levi+promo@example.com", phone: "+972525550777", language: "en", origin: "manual" }).returning();
    const [conv] = await db.insert(conversations).values({ accountId: account.id, leadId: lead.id, channel: "whatsapp", agentVersionId: live.id, language: "en" }).returning();
    const test = await startTestConversation(db, account.id, seller.id, { language: "en", versionId: live.id });
    const at = Date.now() + 120_000;
    await db.insert(toolCalls).values([
      { accountId: account.id, conversationId: conv.id, sequence: 1, name: "lookup_knowledge", input: { query: q }, result: { facts: [] }, outcome: "ok" as const, createdAt: new Date(at) },
      { accountId: account.id, conversationId: conv.id, sequence: 2, name: "lookup_knowledge", input: { query: q }, result: { facts: [] }, outcome: "ok" as const, createdAt: new Date(at - 1000) },
      { accountId: account.id, conversationId: test!.conversationId, sequence: 1, name: "lookup_knowledge", input: { query: q }, result: { facts: [] }, outcome: "ok" as const, createdAt: new Date(at - 2000) },
    ]);
    const [row] = (await unansweredQuestions(db, account.id, 50)).filter((x) => x.question === q);
    expect(row.asks).toEqual([]);
    expect(row.times).toBe(3);
    expect(row.chats.map((c) => [c.conversationId, c.leadId, c.isTest])).toEqual([[conv.id, lead.id, false], [test!.conversationId, expect.any(String), true]]);

    const html = await render({ view: "questions" });
    save("kv2-lookup-chats", html);
    const i = html.indexOf(q);
    const li = html.slice(html.lastIndexOf("<li", i), html.indexOf("</li>", i));
    expect(li).toContain("data-asked-in");
    expect(li).toContain(`Chat with <a href="/app/${slug}/leads/${lead.id}" dir="auto">dana.levi</a>`);
    expect(li).not.toContain("example.com");
    expect(li).toContain("Test lab chat");
    expect(li.match(/data-chat=""/g)).toHaveLength(2);
    // The answer panel names the same chats.
    const panel = await render({ view: "questions", panel: "answer", question: q });
    const p = panel.slice(panel.indexOf('data-answer-question=""'));
    expect(p).toContain("data-asked-in");
    expect(p).not.toContain("example.com");
  });
});

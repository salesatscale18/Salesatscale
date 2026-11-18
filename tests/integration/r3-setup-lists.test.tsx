/**
 * Round 3 · setup list pages (lane R3-5): Knowledge (facts table, filters,
 * sort, the fact panel for add / edit / answer, delete confirm), Order form
 * setup (legal texts table and panel, versions, remove confirm, one Save,
 * brand colour read-only) and the test lab's scenarios table. On PGlite with
 * the demo account; no model call anywhere.
 *
 * With R35_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { knowledgeFacts, legalSections, orderFormSettings, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn(() => { throw new Error("no model calls in this test"); }) }));
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

const { createDemoAccount } = await import("@/lib/demo/seed");
const { addFact, startTestConversation, listVersions, saveDraftPlaybook } = await import("@/lib/agent/service");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");
const { default: OrderFormSetupPage } = await import("@/app/app/[account]/setup/order-form/page");
const { default: TestLabPage } = await import("@/app/app/[account]/setup/test-lab/page");
const knowledge = await import("@/app/app/[account]/setup/knowledge/actions");
const orderForm = await import("@/app/app/[account]/setup/order-form/actions");
const lab = await import("@/app/app/[account]/setup/test-lab/actions");
const { currentLegal, getOrderFormSettings } = await import("@/lib/orders/settings");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.R35_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const render = async (P: unknown, slug: string, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await (P as Page)({ params: Promise.resolve({ account: slug }), searchParams: Promise.resolve(sp) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const form = (v: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) for (const one of Array.isArray(val) ? val : [val]) f.append(k, one);
  return f;
};
/** Runs a server action and returns the URL it redirected to. */
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
/** The facts table rows in order: the statement of each row. */
const factRows = (html: string) => [...html.matchAll(/<tr data-fact="(\w+)"><td[^>]*><span[^>]*>([^<]+)<\/span>/g)].map((m) => ({ status: m[1], statement: m[2] }));

describe("R3-5: Knowledge, Order form setup and Test lab as list pages", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let seller: User;
  let account: SellerAccount;
  let slug: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin, seller] = await db.insert(users).values([
      { clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" },
      { clerkId: "c_u", email: "u@seller.test", role: "user", firstName: "Sam" },
    ]).returning();
    const r = await createDemoAccount(db, admin, { ownerEmail: "u@seller.test" });
    if (!r.ok) throw new Error("demo seed refused");
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.summary.accountId));
    slug = account.slug;
    holder.access = { account, user: seller, actingAs: false, role: "seller_admin" };
    const actor = { userId: seller.id, actingAs: false };
    await addFact(db, actor, account.id, { topic: "Installation", statement: "Buyers can install the sensors themselves.", status: "suggested", sourceLabel: "Call notes" });
    await addFact(db, actor, account.id, { topic: "Installation", statement: "Zebra mounts are sold separately.", status: "rejected" });
  }, 120_000);
  afterAll(async () => t.close());

  describe("Knowledge", () => {
    it("renders the facts table with chips, source filter, sortable headings and Approve on facts to review", async () => {
      const html = await render(KnowledgePage, slug);
      save("knowledge", html);
      const facts = await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.accountId, account.id));
      expect(html).toContain("data-add-fact");
      expect(html).toMatch(/aria-current="true"[^>]*>All<span class="sas-fchip__count sas-num">\d+</);
      expect(text(html)).toMatch(new RegExp(`To review ${facts.filter((f) => f.status === "suggested").length}\\b`));
      expect(text(html)).toMatch(new RegExp(`Approved ${facts.filter((f) => f.status === "approved").length}\\b`));
      expect(html).toContain('name="source"');
      expect(html).toContain(">Added by hand</option>");
      for (const col of ["Fact", "Source", "Status", "Updated"]) expect(html).toMatch(new RegExp(`<th scope="col"[^>]*class="sas-th-sort"><a[^>]*>${col}<`));
      // Default sort: facts to review first; the to-review row has Approve in the row and Reject in ⋯.
      const rows = factRows(html);
      expect(rows[0]).toEqual({ status: "suggested", statement: "Buyers can install the sensors themselves." });
      expect(rows.at(-1)?.status).toBe("rejected");
      const suggestedRow = html.slice(html.indexOf('data-fact="suggested"'), html.indexOf("</tr>", html.indexOf('data-fact="suggested"')));
      expect(suggestedRow).toMatch(/aria-label="Approve: Buyers can install/);
      expect(suggestedRow).toContain(">Reject</button>");
      expect(suggestedRow).not.toContain(">Delete<");
      // Source chips stay in words, normal font.
      expect(html).toContain("sas-chip sas-chip--plain");
      expect(text(html)).toMatch(/Note: [^·<]+/);
      // Questions we couldn't answer sit under the table.
      expect(html.indexOf("data-questions")).toBeGreaterThan(html.indexOf("sas-listtable"));
    });

    it("filters by status chip, search, source and topic; sorts by a heading", async () => {
      const review = factRows(await render(KnowledgePage, slug, { status: "suggested" }));
      expect(review.map((r) => r.status)).toEqual(["suggested"]);
      const approved = factRows(await render(KnowledgePage, slug, { status: "approved" }));
      expect(approved.length).toBeGreaterThan(0);
      expect(approved.every((r) => r.status === "approved")).toBe(true);
      const zebra = await render(KnowledgePage, slug, { q: "zebra" });
      expect(factRows(zebra).map((r) => r.statement)).toEqual(["Zebra mounts are sold separately."]);
      expect(zebra).toContain('data-facts-shown="">Showing 1 of');
      const manual = factRows(await render(KnowledgePage, slug, { source: "manual" }));
      expect(manual.map((r) => r.statement).sort()).toEqual(["Buyers can install the sensors themselves.", "Zebra mounts are sold separately."]);
      const topic = await render(KnowledgePage, slug, { topic: "Installation" });
      const inTopic = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, account.id), eq(knowledgeFacts.topic, "Installation")));
      expect(factRows(topic).length).toBe(inTopic.length);
      expect(topic).toMatch(/aria-current="page" style="[^"]*var\(--primary-soft\)[^"]*" href="[^"]*topic=Installation"><span[^>]*>Installation</);
      const az = factRows(await render(KnowledgePage, slug, { sort: "fact", dir: "asc" })).map((r) => r.statement);
      expect(az).toEqual([...az].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
      const nothing = await render(KnowledgePage, slug, { q: "no such fact anywhere" });
      expect(nothing).toContain("No facts match these filters.");
    });

    it("Add fact, Edit and Answer open the same panel; saves keep the list as it was", async () => {
      const add = await render(KnowledgePage, slug, { panel: "new", topic: "Installation" });
      save("knowledge-add", add);
      expect(add).toMatch(/role="dialog"[\s\S]*Add fact/);
      const topicInput = add.match(/<input class="sas-input" id="kf-topic"[^>]*>/)?.[0] ?? "";
      expect(topicInput).toContain('name="topic"');
      expect(topicInput).toContain('value="Installation"');
      expect(topicInput).toContain('list="kf-topics"');
      expect(add).toContain("Pick a topic, or type a new one.");
      expect(add).toContain("Facts you add yourself are approved at once.");

      const url = await go(knowledge.addFactAction(form({ slug, filter: "Installation", list: "topic=Installation&status=approved&panel=new&next=/evil", topic: "Brackets", statement: "Brackets fit any wall.", source: "" })));
      expect(url).toBe(`/app/${slug}/setup/knowledge?topic=Installation&status=approved&done=added`);
      const [brackets] = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, account.id), eq(knowledgeFacts.topic, "Brackets")));
      expect(brackets).toMatchObject({ statement: "Brackets fit any wall.", status: "approved" });
      // An empty fact reopens the panel with the error.
      expect(await go(knowledge.addFactAction(form({ slug, list: "q=x", topic: "Brackets", statement: "" })))).toBe(`/app/${slug}/setup/knowledge?q=x&panel=new&error=statement`);
      const err = await render(KnowledgePage, slug, { panel: "new", error: "statement" });
      expect(err).toMatch(/role="dialog"[\s\S]*Write the fact/);

      const edit = await render(KnowledgePage, slug, { panel: brackets.id });
      save("knowledge-edit", edit);
      expect(edit).toMatch(/role="dialog"[\s\S]*Edit fact/);
      expect(edit).toContain(">Brackets fit any wall.</textarea>");
      expect(edit).toMatch(new RegExp(`<tr data-current="" data-fact="approved">`));
      expect(await go(knowledge.updateFactAction(form({ slug, list: "sort=fact&dir=asc", factId: brackets.id, topic: "Brackets", statement: "Brackets fit any flat wall.", source: "Fitter" })))).toBe(`/app/${slug}/setup/knowledge?sort=fact&dir=asc&done=saved`);
      expect((await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, brackets.id)))[0]).toMatchObject({ statement: "Brackets fit any flat wall.", sourceLabel: "Fitter" });

      const answer = await render(KnowledgePage, slug, { panel: "answer", question: "Does it work in a blast chiller?" });
      expect(answer).toMatch(/role="dialog"[\s\S]*Answer a question/);
      expect(answer).toContain('name="q.0.question" value="Does it work in a blast chiller?"');
      expect(await go(knowledge.answerQuestionsAction(form({ slug, list: "", panel: "answer", "q.0.question": "Does it work in a blast chiller?", "q.0.answer": "", "q.0.topic": "General" }))))
        .toBe(`/app/${slug}/setup/knowledge?error=answer&panel=answer&question=Does+it+work+in+a+blast+chiller%3F`);
      expect(await go(knowledge.answerQuestionsAction(form({ slug, list: "", panel: "answer", "q.0.question": "Does it work in a blast chiller?", "q.0.answer": "Yes, down to -40 °C.", "q.0.topic": "Product" }))))
        .toBe(`/app/${slug}/setup/knowledge?done=answered&n=1`);
      const [answered] = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, account.id), eq(knowledgeFacts.statement, "Yes, down to -40 °C.")));
      expect(answered).toMatchObject({ topic: "Product", status: "approved" });
    });

    it("Delete asks to confirm in the page; Approve and Reject keep the filters", async () => {
      const [brackets] = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, account.id), eq(knowledgeFacts.topic, "Brackets")));
      const list = await render(KnowledgePage, slug, { topic: "Brackets" });
      expect(list).toContain(`href="/app/${slug}/setup/knowledge?topic=Brackets&amp;confirm=${brackets.id}"`);
      const confirm = await render(KnowledgePage, slug, { topic: "Brackets", confirm: brackets.id });
      save("knowledge-confirm", confirm);
      expect(confirm).toMatch(/role="alertdialog"[\s\S]*Delete this fact\?/);
      expect(await go(knowledge.removeFactAction(form({ slug, filter: "Brackets", list: "topic=Brackets", factId: brackets.id })))).toBe(`/app/${slug}/setup/knowledge?topic=Brackets&done=removed`);
      expect(await db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, brackets.id))).toHaveLength(0);

      const [suggested] = await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, account.id), eq(knowledgeFacts.status, "suggested")));
      expect(await go(knowledge.setFactStatusAction(form({ slug, list: "status=suggested&q=install", factId: suggested.id, status: "approved" })))).toBe(`/app/${slug}/setup/knowledge?q=install&status=suggested&done=approved`);
      // Older forms (only the topic as "filter") still go back to the topic.
      expect(await go(knowledge.setFactStatusAction(form({ slug, filter: "Installation", factId: suggested.id, status: "rejected" })))).toBe(`/app/${slug}/setup/knowledge?topic=Installation&done=rejected`);
    });
  });

  describe("Order form setup", () => {
    it("legal texts are a table with a version link per language, Updated and ⋯ (New version, Remove)", async () => {
      const html = await render(OrderFormSetupPage, slug);
      save("order-form", html);
      expect(html).toContain("data-legal-table");
      expect(html).toMatch(/<a data-legal-version="en\.1"[^>]*>English · v1<\/a><a data-legal-version="he\.1"[^>]*>Hebrew · v1<\/a>/);
      expect(html).toContain(">New version</a>");
      expect(html).toMatch(/href="[^"]*\?confirm=sales_terms"[^>]*>[\s\S]*?Remove<\/a>/);
      // One Save in the header for the settings form; no other submit for it.
      expect(html).toMatch(/<button type="submit" form="ofs-settings"[^>]*data-page-save="">Save<\/button>/);
      expect(html).not.toContain("Save settings");
      expect(html).not.toContain("Save section");
      // Brand colour is read-only here, changed in Company; the signature note sits under Signature.
      expect(html).not.toContain('name="brandColor"');
      expect(html).toContain(`href="/app/${slug}/setup/company" data-brand-change="">Change in Company</a>`);
      expect(html).toMatch(/id="of-sig"[^>]*>[\s\S]*?<\/select><span class="sas-hint" id="of-sig-note" data-signature-note="">Recorded with each signature/);
      // The preview is unchanged and follows the ticks.
      expect(html).toContain('data-preview-field="company_name"');
      expect(html).not.toContain('data-preview-field="po_number"');
    });

    it("Add legal text and New version open the same panel; saving makes a new version", async () => {
      const add = await render(OrderFormSetupPage, slug, { panel: "legal" });
      save("order-form-add", add);
      expect(add).toMatch(/role="dialog"[\s\S]*Add legal text/);
      expect(add).toMatch(/<select class="sas-select" id="ls-lang" name="language"/);
      expect(add).toContain(">Save text</button>");

      const he = await render(OrderFormSetupPage, slug, { panel: "legal:sales_terms", lang: "he" });
      save("order-form-version", he);
      expect(he).toMatch(/role="dialog"[\s\S]*Sales terms · Hebrew/);
      expect(he).toContain('aria-current="page" href="/app/');
      expect(he).toMatch(/<textarea[^>]*id="ls-body"[^>]*dir="rtl"[^>]*>טקסט לדוגמה/);
      expect(he).toContain(">Save as version 2</button>");
      expect(he).toMatch(/<tr data-current="" data-legal-row="sales_terms">/);

      expect(await go(orderForm.saveSectionAction(form({ slug, sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "תנאים חדשים" })))).toBe(`/app/${slug}/setup/order-form?legal=sales_terms.he.2`);
      const after = await render(OrderFormSetupPage, slug);
      expect(after).toMatch(/data-legal-version="he\.2"[^>]*>Hebrew · v2</);
      // A missing title reopens the panel with the error.
      expect(await go(orderForm.saveSectionAction(form({ slug, sectionKey: "sales_terms", title: "", language: "en", body: "x" }))))
        .toBe(`/app/${slug}/setup/order-form?panel=legal:sales_terms&lang=en&error=Enter%20a%20title%20and%20the%20text.`);
      expect(await go(orderForm.saveSectionAction(form({ slug, sectionKey: "", title: "Returns", language: "en", body: "" }))))
        .toBe(`/app/${slug}/setup/order-form?panel=legal&error=Enter%20a%20title%20and%20the%20text.`);
      // A new text in one language shows as missing in the other.
      await go(orderForm.saveSectionAction(form({ slug, sectionKey: "", title: "Returns", language: "en", body: "30 days." })));
      const withReturns = await render(OrderFormSetupPage, slug);
      expect(withReturns).toMatch(/data-legal-row="returns"[\s\S]*?Hebrew missing/);
    });

    it("Remove asks to confirm first", async () => {
      const confirm = await render(OrderFormSetupPage, slug, { confirm: "returns" });
      save("order-form-confirm", confirm);
      expect(confirm).toMatch(/role="alertdialog"[\s\S]*Remove Returns\?/);
      expect(await go(orderForm.removeSectionAction(form({ slug, sectionKey: "returns" })))).toBe(`/app/${slug}/setup/order-form`);
      expect((await currentLegal(db, account.id)).some((s) => s.sectionKey === "returns")).toBe(false);
    });

    it("the page Save keeps the brand colour set in Company", async () => {
      await db.update(orderFormSettings).set({ brandColor: "#123456" }).where(eq(orderFormSettings.accountId, account.id));
      const url = await go(orderForm.saveSettingsAction(form({ slug, fields: ["company_name", "po_number"], linkValidDays: "14", card: "on", bankDetails: "" })));
      expect(url).toBe(`/app/${slug}/setup/order-form?saved=1`);
      const s = await getOrderFormSettings(db, account.id);
      expect(s).toMatchObject({ fields: ["company_name", "po_number"], linkValidDays: 14, card: true, bankTransfer: false, brandColor: "#123456" });
      expect(await db.select().from(legalSections).where(eq(legalSections.accountId, account.id))).not.toHaveLength(0);
    });
  });

  describe("Versions and test lab", () => {
    it("scenarios table: Tested / Not run on the chosen version, last chat link, Run per scenario, no pass or fail", async () => {
      const [live] = await listVersions(db, account.id);
      // A draft next to the live version, so "Results for" offers a choice.
      await saveDraftPlaybook(db, account.id, live.playbook, "R3-5 test");
      const c = await startTestConversation(db, account.id, seller.id, { language: "en", scenario: "discount_push", versionId: live.id });
      const html = await render(TestLabPage, slug, { v: live.id });
      save("test-lab", html);
      expect(html).toContain("data-new-chat");
      expect(html.indexOf("data-new-chat")).toBeLessThan(html.indexOf("data-scenarios"));
      expect(html).toMatch(/data-scenarios-tested="">1 of \d+ tested on v1</);
      const row = (id: string) => html.slice(html.indexOf(`data-scenario="${id}"`), html.indexOf("</tr>", html.indexOf(`data-scenario="${id}"`)));
      expect(row("discount_push")).toContain('data-scenario-tested="tested"');
      expect(row("discount_push")).toContain(`href="/app/${slug}/setup/test-lab?c=${c!.conversationId}&amp;v=${live.id}" data-last-chat=""`);
      expect(row("ready_buyer")).toContain('data-scenario-tested="not_run"');
      expect(row("ready_buyer")).toMatch(/<input type="hidden" name="scenario" value="ready_buyer"\/>[\s\S]*name="versionId" value="[^"]+"[\s\S]*data-run="">Run</);
      expect(html).not.toMatch(/>Passed<|>Failed<|>Not yet</);
      expect(html).toContain("there is no run-all");
      // Results for applies on change (auto-submit marker) with a no-JS fallback.
      expect(html).toMatch(/<select class="sas-select" name="v"[^>]*data-results-for=""/);
      expect(html).toContain("data-autosubmit");
      // Recent test chats are named by scenario; the model stays hidden from sellers.
      expect(html).toMatch(/data-chat-name="">Discount push above the limit</);
      expect(html).toMatch(/data-chat-name="">Free chat</);
      expect(html).not.toContain("data-version-model");
    });

    it("Run starts a test chat for that scenario without calling the model", async () => {
      const live = (await listVersions(db, account.id)).find((v) => v.status === "live")!;
      const url = await go(lab.startChatAction(form({ slug, scenario: "asks_for_person", language: "en", versionId: live.id })));
      expect(url).toMatch(new RegExp(`^/app/${slug}/setup/test-lab\\?c=[0-9a-f-]{36}$`));
      const chat = await render(TestLabPage, slug, { c: url.split("c=")[1] });
      save("test-lab-chat", chat);
      // The opening waits in the composer; the scenario note is neutral.
      expect(chat).toContain("data-scenario-seen");
      expect(chat).toContain("You judge whether it did what you expect.");
      expect(chat).not.toMatch(/data-scenario-result=/);
    });
  });
});

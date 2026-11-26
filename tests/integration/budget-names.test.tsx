/**
 * B2 and C2 against the database (scripted or fake model only, never the API):
 * automatic name versions made once with a fake light model (success, invalid
 * output, failure, over budget, no model), stored in the draft and never made
 * per message; own versions with Reset and account isolation; the 17 Nov
 * Hebrew values kept as the Hebrew rows' own versions and used for buyers;
 * the question budget saved from the editor; and the Playbook and Company
 * pages (rows from the markets, tags, notice, budget stepper and warning).
 *
 * With BN_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { agentVersions, auditLog, markets, sellerAccounts, users, type PlaybookField, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { parseCompany, saveCompany } = await import("@/lib/accounts/company");
const { ScriptedLlm } = await import("@/lib/agent/llm");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation } = await import("@/lib/agent/service");
const { savePlaybookForm } = await import("@/lib/agent/playbook-save");
const { refreshAgentNameAuto, agentNameLanguages } = await import("@/lib/agent/names-auto");
const { runBuyerTurn } = await import("@/lib/agent/turn");
const { chatNames } = await import("@/lib/simulator/service");
const { default: PlaybookPage } = await import("@/app/app/[account]/setup/playbook/page");
const { default: PartPage } = await import("@/app/app/[account]/setup/playbook/[part]/page");
const { default: CompanyPage } = await import("@/app/app/[account]/setup/company/page");

type Llm = InstanceType<typeof ScriptedLlm>;
const reply = (text: string) => () => ({ content: [{ type: "text", text }] });

describe("B2 and C2 against the database", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount, other: SellerAccount;
  const actor = () => ({ userId: me.id, actingAs: false });
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  const save = (name: string, html: string) => {
    const dir = process.env.BN_RENDER_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="sas-app">${html}</div></body></html>`);
  };
  const render = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
  const page = (Page: typeof PlaybookPage, a: SellerAccount) => {
    holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" };
    return render(Page({ params: Promise.resolve({ account: a.slug }), searchParams: Promise.resolve({}) }));
  };
  /** A part of the Playbook (Agent, What it asks, …); `edit` opens one row first. */
  const partPage = (a: SellerAccount, part: string, sp: Record<string, string> = {}) => {
    holder.access = { account: a, user: me, actingAs: false, role: "seller_admin" };
    return render(PartPage({ params: Promise.resolve({ account: a.slug, part }), searchParams: Promise.resolve(sp) }));
  };
  const draftOf = async (id: string) => (await ensureDraftVersion(db, id)).playbook;
  const form = (agentName: string, extra: [string, string][] = []): [string, string][] => [
    ["slug", "x"], ["agentName", agentName], ["goal", "Sell well."], ["tone", ""], ["maxDiscount", "5"], ["offerMeetingWhen", ""], ["handOffWhen", ""],
    ["field.0.label", "Number of users"], ["field.0.stage", "before_quote"], ["field.0.key", "users"], ...extra,
  ];
  const env = process.env;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-bn", email: "bn@p.test", firstName: "Dana", role: "super_admin" }).returning();
    const mk = async (tradeName: string, languages: string[]) => {
      const p = parseCreateAccount({ tradeName, market: "IL", languages, timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `o@${tradeName.toLowerCase()}.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor(), p.value)).account;
    };
    acc = await mk("Acme", ["en"]);
    other = await mk("Other", ["en", "he"]);
    // Acme's account speaks English only; one of its markets sells in Hebrew too.
    await db.insert(markets).values({ id: randomUUID(), accountId: acc.id, name: "Israel HE", overrides: { languages: ["en", "he"] } });
    const d = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, { ...d.playbook, agentName: "Daniel" });
  });
  afterAll(async () => {
    process.env = env;
    await t.close();
  });

  it("language rows come from the markets (union), without the language the name is typed in", async () => {
    expect(await agentNameLanguages(db, acc.id, "Daniel")).toEqual(["he"]);
    expect(await agentNameLanguages(db, acc.id, "דניאל")).toEqual(["en"]);
    // The other account has only its home market, which follows the account's languages.
    expect(await agentNameLanguages(db, other.id, "Daniel")).toEqual(["he"]);
  });

  it("success: one light-model call for the missing languages, stored in the draft and audited; not repeated", async () => {
    const llm: Llm = new ScriptedLlm([reply('{"he": "דניאל"}')]);
    const r = await refreshAgentNameAuto(db, acc.id, llm, { actor: actor() });
    expect(r).toMatchObject({ generated: ["he"], asWritten: [], reason: "ok" });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]).toMatchObject({ model: "claude-haiku-5-5", effort: "low", maxTokens: 300, fallbacks: false, tools: [] });
    expect(llm.requests[0].system[1]).toBe("Name: Daniel\nLanguages: he (Hebrew, hebrew script)");
    expect((await draftOf(acc.id)).agentNameAuto).toEqual({ source: "Daniel", values: { he: "דניאל" } });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.accountId, acc.id), eq(auditLog.action, "agent.names_generated")));
    expect(audit.details).toMatchObject({ languages: ["he"], made: ["he"], model: "scripted", usage: { inputTokens: 10, outputTokens: 5 } });
    // Nothing missing: no call, on a view or on a save.
    expect((await refreshAgentNameAuto(db, acc.id, llm)).reason).toBe("nothing");
    expect((await refreshAgentNameAuto(db, acc.id, llm, { retry: true })).reason).toBe("nothing");
    expect(llm.requests).toHaveLength(1);
    // The other account is untouched.
    expect((await draftOf(other.id)).agentNameAuto).toBeUndefined();
  });

  it("never per message: a buyer turn reads the stored names and makes no extra model call", async () => {
    await publishDraftVersion(db, actor(), acc.id);
    const c = (await startTestConversation(db, acc.id, me.id, { language: "he" }))!;
    const llm: Llm = new ScriptedLlm([reply("שלום")]);
    await runBuyerTurn(db, llm, { accountId: acc.id, conversationId: c.conversationId, text: "שלום" });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].system[1]).toContain("Your name: דניאל. The seller's name: Acme.");
    expect(llm.requests[0].model).not.toBe("claude-haiku-5-5");
  });

  it("a new name makes the old versions stale: buyers see the name as typed until the new ones are made", async () => {
    await saveDraftPlaybook(db, acc.id, { ...(await draftOf(acc.id)), agentName: "Noa" });
    const stale = await draftOf(acc.id);
    expect(stale.agentNameAuto?.source).toBe("Daniel");
    const { localAgentName } = await import("@/lib/agent/core/names");
    expect(localAgentName(stale, "he", "Acme")).toBe("Noa");
    const llm: Llm = new ScriptedLlm([reply('{"he": "נועה"}')]);
    await refreshAgentNameAuto(db, acc.id, llm);
    expect((await draftOf(acc.id)).agentNameAuto).toEqual({ source: "Noa", values: { he: "נועה" } });
  });

  it("invalid output: as written, the page says so, a view does not retry, a save does", async () => {
    await saveDraftPlaybook(db, acc.id, { ...(await draftOf(acc.id)), agentName: "Lior" });
    const bad: Llm = new ScriptedLlm([reply('{"he": "Lior"}')]);
    const r = await refreshAgentNameAuto(db, acc.id, bad);
    expect(r).toMatchObject({ generated: [], asWritten: ["he"], reason: "invalid" });
    expect((await draftOf(acc.id)).agentNameAuto).toEqual({ source: "Lior", values: {}, asWritten: ["he"] });
    // The Agent part (no model configured in tests) shows the name as written, with the notice, and calls nothing.
    const html = await partPage(acc, "agent");
    expect(html).toContain("No automatic version could be made for Hebrew right now, so buyers see the name as written.");
    expect(html).toMatch(/data-tag="as_written"[^>]*>As written</);
    expect(bad.requests).toHaveLength(1);
    // A save retries the failed language.
    const good: Llm = new ScriptedLlm([reply('{"he": "ליאור"}')]);
    expect(await savePlaybookForm(db, acc.id, form("Lior"), { names: good, actor: actor() })).toEqual({ ok: true });
    expect(good.requests).toHaveLength(1);
    expect((await draftOf(acc.id)).agentNameAuto).toEqual({ source: "Lior", values: { he: "ליאור" } });
  });

  it("failure, over budget or no model: as written, nothing stored as a value", async () => {
    await saveDraftPlaybook(db, acc.id, { ...(await draftOf(acc.id)), agentName: "Tal" });
    const failing: Llm = new ScriptedLlm([() => { throw new Error("overloaded"); }]);
    expect((await refreshAgentNameAuto(db, acc.id, failing)).reason).toBe("failed");
    expect((await draftOf(acc.id)).agentNameAuto).toEqual({ source: "Tal", values: {}, asWritten: ["he"] });
    const refused: Llm = new ScriptedLlm([() => ({ content: [], stopReason: "refusal" })]);
    expect((await refreshAgentNameAuto(db, acc.id, refused, { retry: true })).reason).toBe("failed");
    expect((await refreshAgentNameAuto(db, acc.id, null, { retry: true })).reason).toBe("unavailable");
    process.env.AI_PLATFORM_MONTHLY_BUDGET_USD = "0";
    try {
      const unused: Llm = new ScriptedLlm([reply('{"he": "טל"}')]);
      expect((await refreshAgentNameAuto(db, acc.id, unused, { retry: true })).reason).toBe("over_budget");
      expect(unused.requests).toHaveLength(0);
    } finally {
      delete process.env.AI_PLATFORM_MONTHLY_BUDGET_USD;
    }
    const { localAgentName } = await import("@/lib/agent/core/names");
    expect(localAgentName(await draftOf(acc.id), "he", "Acme")).toBe("Tal");
  });

  it("own versions: typed over the automatic one, Reset removes it; saves stay in their account", async () => {
    const llm: Llm = new ScriptedLlm([]);
    expect(await savePlaybookForm(db, acc.id, form("Tal", [["agentNameLocal.he", "טל"]]), { names: llm })).toEqual({ ok: true });
    let p = await draftOf(acc.id);
    expect(p.agentNameLocal).toEqual({ he: "טל" });
    // An own version needs no automatic one: no call.
    expect(llm.requests).toHaveLength(0);
    // Read first: the Hebrew version is marked as the seller's own; the name row opened shows it with Reset.
    expect(await partPage(acc, "agent")).toMatch(/data-tag="own">Your version</);
    const html = await partPage(acc, "agent", { edit: "name" });
    expect(html).toMatch(/data-lang="he" data-own=""/);
    expect(html).toContain(">Your version<");
    expect(html).toContain(">Reset<");
    // Reset (an empty value) removes it; the automatic version is then made on save.
    const after: Llm = new ScriptedLlm([reply('{"he": "טל"}')]);
    expect(await savePlaybookForm(db, acc.id, form("Tal", [["agentNameLocal.he", ""]]), { names: after })).toEqual({ ok: true });
    p = await draftOf(acc.id);
    expect(p.agentNameLocal).toBeUndefined();
    expect(p.agentNameAuto).toMatchObject({ source: "Tal", values: { he: "טל" } });
    // A refused value saves nothing.
    const refused = await savePlaybookForm(db, acc.id, form("Tal", [["agentNameLocal.he", "Tal"]]), { names: null });
    expect(refused).toMatchObject({ ok: false, errors: { "agentNameLocal.he": "Write the Hebrew name in Hebrew letters, or leave it empty." } });
    // The other account never sees Acme's names.
    expect(await draftOf(other.id)).not.toHaveProperty("agentNameLocal");
    expect(await draftOf(other.id)).not.toHaveProperty("agentNameAuto");
  });

  it("question budget: saved from the editor, kept when the form does not send it, refused out of range", async () => {
    expect(await savePlaybookForm(db, acc.id, form("Tal", [["questionBudget", "5"]]))).toEqual({ ok: true });
    expect((await draftOf(acc.id)).questionBudget).toBe(5);
    expect(await savePlaybookForm(db, acc.id, form("Tal"))).toEqual({ ok: true });
    expect((await draftOf(acc.id)).questionBudget).toBe(5);
    expect(await savePlaybookForm(db, acc.id, form("Tal", [["questionBudget", "7"]]))).toMatchObject({ ok: false, errors: { questionBudget: "Choose a number from 2 to 6." } });
    expect((await draftOf(acc.id)).questionBudget).toBe(5);
    expect((await draftOf(other.id)).questionBudget).toBeUndefined();
  });

  it("Playbook › What it asks: the stepper and the advice when the quote needs more than the budget; Agent: speaks as, names", async () => {
    const p = await draftOf(acc.id);
    await saveDraftPlaybook(db, acc.id, {
      ...p, questionBudget: 3,
      fields: ["Users", "Offices", "Start date", "Plan"].map((label, i): PlaybookField => ({ key: `f${i}`, label, stage: "before_quote" }))
        .concat([{ key: "today", label: "How they plan today", stage: "optional" }]),
    });
    const html = await partPage(acc, "asks");
    save("playbook", html);
    expect(html).toContain("Questions before recommending");
    expect(html).toContain('name="questionBudget" value="3"');
    expect(html).toContain('aria-label="Fewer"');
    expect(html).toContain("4 questions are needed for the quote, but the agent asks at most 3 before recommending. It will quote the last one on a stated assumption.");
    expect(html).toContain("What counts toward the 3");
    expect(html).toContain("Safety limit in the app: after 6 questions the agent always recommends, whatever the setting.");
    const agent = await partPage(acc, "agent", { edit: "gender" });
    expect(agent).toContain("Speaks as");
    expect(agent).toContain('aria-label="How the agent speaks about itself"');
    const names = await partPage(acc, "agent", { edit: "name" });
    expect(names).toContain("Names in other languages");
    expect(names).toContain("1 language · from your markets");
    // The 17 Nov field is gone.
    expect(names).not.toContain("Agent name (Hebrew)");
    expect(names).not.toContain('id="pb-agentNameHe"');
    // Within the budget: no advice.
    await saveDraftPlaybook(db, acc.id, { ...(await draftOf(acc.id)), questionBudget: 4 });
    expect(await partPage(acc, "asks")).not.toContain('data-testid="budget-warning"');
    // Home says it in one line.
    expect(await page(PlaybookPage, acc)).toContain("5 questions · recommends after 4");
  });

  it("the 17 Nov Hebrew values: shown as the Hebrew rows' own versions and used for buyers, nothing lost", async () => {
    // As the 17 Nov fields stored them.
    const d = await ensureDraftVersion(db, other.id);
    await saveDraftPlaybook(db, other.id, { ...d.playbook, agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentGender: "female" });
    await db.update(sellerAccounts).set({ tradeNameLocal: { he: "אחר" } }).where(eq(sellerAccounts.id, other.id));
    other = (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, other.id)))[0];
    const pb = await partPage(other, "agent", { edit: "name" });
    expect(pb).toMatch(/name="agentNameLocal\.he"[^>]*value="מאיה"/);
    const co = await page(CompanyPage, other);
    save("company", co);
    expect(co).toMatch(/name="tradeNameLocal\.he"[^>]*value="אחר"/);
    expect(co).toContain(">Your version<");
    // The 17 Nov field (its own input and hint) is gone: the Hebrew row replaces it.
    expect(co).not.toContain('id="co-tn-he"');
    expect(co).not.toContain("Optional. Empty: buyers see");
    expect(co).toContain("Brand names aren&#x27;t changed automatically");
    await publishDraftVersion(db, actor(), other.id);
    expect(await chatNames(db, other, "he")).toMatchObject({ agent: "מאיה", seller: "אחר", gender: "female" });
    expect(await chatNames(db, other, "en")).toMatchObject({ agent: "Maya", seller: "Other" });
    // The live version still has it as stored: no data loss.
    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, other.id), eq(agentVersions.status, "live")));
    expect(live.playbook.agentNameLocal).toEqual({ he: "מאיה" });
  });

  it("Company › Trade name: own versions with Reset, kept as written otherwise, per account", async () => {
    const p = parseCompany({ tradeName: "Acme", brandColor: "#0e6fb8", "tradeNameLocal.he": "אקמה" });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    expect(await saveCompany(db, actor(), acc.id, p.value)).toEqual({ ok: true });
    const read = async (id: string) => (await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id)))[0];
    expect((await read(acc.id)).tradeNameLocal).toEqual({ he: "אקמה" });
    const reset = parseCompany({ tradeName: "Acme", brandColor: "#0e6fb8", "tradeNameLocal.he": "" });
    if (!reset.ok) throw new Error();
    await saveCompany(db, actor(), acc.id, reset.value);
    expect((await read(acc.id)).tradeNameLocal).toBeNull();
    expect((await read(other.id)).tradeNameLocal).toEqual({ he: "אחר" });
    const html = await page(CompanyPage, await read(acc.id));
    expect(html).toMatch(/data-tag="as_written"[^>]*>As written</);
    expect(html).toContain('placeholder="Acme" name="tradeNameLocal.he" value=""');
  });
});

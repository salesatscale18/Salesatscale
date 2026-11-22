/**
 * KQ2 (A): a newly found fact that says something different from a fact the
 * seller approved is marked against it (the model's known_fact_id, or the
 * code's backstop), held out of "Approve all", shown on the Knowledge list
 * with the approved fact, and resolved only by the seller's click: replace
 * (approve the new, retire the old, history kept) or keep (reject the new).
 * Scripted model only (no API call). With POLISH_RENDER_DIR set, the
 * Knowledge page is also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { auditLog, knowledgeFacts, users, type SellerAccount, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
/** The viewer's own zone (sas_tz cookie): the conflict card's dates follow it. */
const ZONE = "America/New_York";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (n: string) => (n === "sas_tz" ? { value: "America/New_York" } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { parseCreateAccount } = await import("@/lib/accounts/rules");
const { createAccount } = await import("@/lib/accounts/service");
const { addFact } = await import("@/lib/agent/service");
const { ScriptedPipelineLlm } = await import("@/lib/pipeline/llm");
const { FACTS_TOOL, PLAYBOOK_TOOL } = await import("@/lib/pipeline/prompts/system");
const svc = await import("@/lib/pipeline/service");
const { addNote, listSections } = await import("@/lib/sources/service");
const actions = await import("@/app/app/[account]/setup/knowledge/actions");
const { default: KnowledgePage } = await import("@/app/app/[account]/setup/knowledge/page");

const EMPTY = { facts: [], contradictions: [], gaps: [], source_about: [], customer_specific: [] };
const PLAYBOOK = { goal: { text: "", text_he: "", evidence: [] }, fields: [], objections: [], limits: [], tone: { text: "", text_he: "", evidence: [] }, never: [], discovery_questions: [] };

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.POLISH_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};

describe("a new fact that differs from an approved fact", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let other: string;
  const actor = () => ({ userId: me.id, actingAs: false });
  const ids: Record<string, string> = {};
  const factByText = async (statement: string) => (await db.select().from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, account.id), eq(knowledgeFacts.statement, statement))))[0];

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u-kq2", email: "kq2@p.test", firstName: "K", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "USD", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name.toLowerCase()}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor(), p.value)).account;
    };
    account = await mk("Kqtwo");
    other = (await mk("Other")).id;
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };
    // Approved facts, in the order the model sees them (topic, then statement): K1, K2, K3.
    ids.delivery = (await addFact(db, actor(), account.id, { topic: "Delivery", statement: "Delivery takes 3 working days.", status: "approved" })).id;
    ids.install = (await addFact(db, actor(), account.id, { topic: "Installation", statement: "Installation is included in the price.", status: "approved" })).id;
    ids.warranty = (await addFact(db, actor(), account.id, { topic: "Warranty", statement: "Warranty is 24 months.", status: "approved" })).id;
  });
  afterAll(async () => t.close());

  it("marks the fact the model names and the one the code finds; others are plain suggestions", async () => {
    const src = (await addNote(db, actor(), account.id, { title: "New terms", body: "Warranty 12 months from delivery. Installation not included. 7-inch screen." })).id;
    const loc = (await listSections(db, account.id, src))[0].locator;
    const fact = (topic: string, statement: string, known = "") =>
      ({ topic, statement, language: "en", customer_specific: false, known_fact_id: known, evidence: [{ source_id: src, locator: loc, quote: "Warranty 12 months" }] });
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY, facts: [
        fact("Warranty", "The warranty is 12 months from delivery.", "K3"),
        fact("Installation", "Installation is not included in the price."),
        fact("Product", "The panel has a 7-inch screen.", "K99"),
        fact("Delivery", "Delivery takes 3 working days."),
      ] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    expect((await svc.analyzeSources(db, llm, account.id, { store: null })).failed).toBeNull();
    // The known facts went with ids, in the stable order.
    expect(llm.requests[0].instruction).toContain('{"id":"K3","topic":"Warranty","statement":"Warranty is 24 months."}');
    ids.newWarranty = (await factByText("The warranty is 12 months from delivery."))!.id;
    ids.newInstall = (await factByText("Installation is not included in the price."))!.id;
    ids.screen = (await factByText("The panel has a 7-inch screen."))!.id;
    const run = (await svc.listRuns(db, account.id, 10)).find((r) => r.kind === "facts" && r.status === "done")!;
    const result = svc.runData(run)!.result as import("@/lib/pipeline/service").FactsRunResult;
    expect(result.factsAdded).toBe(3);
    expect(result.conflicts).toEqual([
      { factId: ids.newWarranty, approvedFactId: ids.warranty, by: "model" },
      { factId: ids.newInstall, approvedFactId: ids.install, by: "check" },
    ]);
    const open = await svc.openFactConflicts(db, account.id);
    expect([...open.keys()].sort()).toEqual([ids.newWarranty, ids.newInstall].sort());
    expect(open.get(ids.newWarranty)!.statement).toBe("Warranty is 24 months.");
    // Another account sees nothing.
    expect((await svc.openFactConflicts(db, other)).size).toBe(0);
  });

  it("shows the conflict card (board KnowConflict): approved and new side by side, who approved it, dates in the viewer's zone, the two actions", async () => {
    // The installation fact was approved on its own by a teammate (audit row), with only a first name shown.
    const [dana] = await db.insert(users).values({ clerkId: "u-kq2-dana", email: "dana.private@p.test", firstName: "Dana", role: "user" }).returning();
    const approvedAt = new Date("2026-11-20T23:30:00Z");
    await db.insert(auditLog).values({ accountId: account.id, actorUserId: dana.id, action: "knowledge.fact_approved", targetType: "knowledge_fact", targetId: ids.install, createdAt: approvedAt });
    const html = renderToStaticMarkup(await (KnowledgePage as unknown as Page)({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({}) }));
    save("kq2-knowledge", html);
    const cards = html.split("<section").filter((s) => s.includes("data-conflict="));
    expect(cards).toHaveLength(2);
    const warranty = cards.find((r) => r.includes("The warranty is"))!;
    expect(warranty).toContain('border-color:#e9c98a');
    expect(warranty).toContain("background:#fdf1dc");
    expect(warranty).toContain("sas-pill sas-pill--warning");
    expect(warranty).toContain("Differs from an approved fact");
    expect(warranty).toContain("From &quot;New terms&quot;");
    expect(warranty).toContain("Approved · used by the agent now");
    expect(warranty).toContain("Warranty is 24 months.");
    // Added by the viewer: "by you".
    const today = (z: string, d: Date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: z }).format(d);
    const added = (await factByText("Warranty is 24 months."))!.createdAt;
    expect(warranty).toContain(`Approved ${today(ZONE, added)} by you`);
    // The new text, with the differing number in bold.
    expect(warranty).toContain("The warranty is <b>12</b> months from delivery.");
    expect(warranty).toContain("color:#a15c07");
    expect(warranty).toContain("background:#fffbf3");
    expect(warranty).toContain(`Found ${today(ZONE, (await factByText("The warranty is 12 months from delivery."))!.createdAt)}`);
    expect(warranty).toContain("sas-btn sas-btn--primary sas-btn--sm");
    expect(warranty).toMatch(/sas-btn--primary sas-btn--sm"[^>]*>Replace the approved fact/);
    expect(warranty).toMatch(/sas-btn--secondary sas-btn--sm"[^>]*>Keep the approved fact/);
    expect(warranty).toContain("The agent keeps using the approved fact until you choose.");
    // Approved by a teammate: first name only, never the email; the date in the viewer's zone (21 Nov in UTC, 20 Nov in New York).
    const install = cards.find((r) => r.includes("Installation is not included"))!;
    expect(install).toContain("Approved 20 Nov by Dana");
    expect(html).not.toContain("dana.private@p.test");
    // No number differs: plain text.
    expect(install).not.toContain("<b>");
    // In the table, the row only points at its card: no Approve, no Replace.
    const row = html.split("<tr").find((r) => r.includes("The warranty is 12 months from delivery."))!;
    expect(row).toContain(`href="#kx-${ids.newWarranty}"`);
    expect(row).not.toContain("data-approve");
    expect(row).not.toContain("data-replace");
    // A plain suggestion keeps its Approve button.
    const screen = html.split("<tr").find((r) => r.includes("The panel has a 7-inch screen."))!;
    expect(screen).toContain("data-approve");
    expect(screen).not.toContain("Differs from an approved fact");
  });

  it("Approve all leaves the differing suggestions for the seller", async () => {
    expect(await svc.approveAllSuggestedFacts(db, account.id)).toBe(1);
    expect((await factByText("The panel has a 7-inch screen."))!.status).toBe("approved");
    expect((await factByText("The warranty is 12 months from delivery."))!.status).toBe("suggested");
  });

  it("another account cannot resolve it", async () => {
    expect(await svc.resolveFactConflict(db, actor(), other, { factId: ids.newWarranty, choice: "replace" })).toBe(false);
    expect((await factByText("Warranty is 24 months."))!.status).toBe("approved");
  });

  it("Replace the approved fact: the new one is approved and the old one retired (kept as rejected), with an audit row", async () => {
    await expect(actions.resolveFactConflictAction(form({ slug: account.slug, factId: ids.newWarranty, choice: "replace" })))
      .rejects.toMatchObject({ url: `/app/${account.slug}/setup/knowledge?done=replaced` });
    expect((await factByText("The warranty is 12 months from delivery."))!.status).toBe("approved");
    expect((await factByText("Warranty is 24 months."))!.status).toBe("rejected");
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.accountId, account.id), eq(auditLog.action, "knowledge.fact_replaced")));
    expect(a).toMatchObject({ targetId: ids.newWarranty, details: { approvedFactId: ids.warranty, approvedStatement: "Warranty is 24 months." } });
    // Done: no longer open, and a second click changes nothing.
    expect((await svc.openFactConflicts(db, account.id)).has(ids.newWarranty)).toBe(false);
    expect(await svc.resolveFactConflict(db, actor(), account.id, { factId: ids.newWarranty, choice: "keep" })).toBe(false);
    expect((await factByText("The warranty is 12 months from delivery."))!.status).toBe("approved");
  });

  it("Keep the approved fact: the suggestion is rejected, the approved fact stays", async () => {
    await expect(actions.resolveFactConflictAction(form({ slug: account.slug, factId: ids.newInstall, choice: "keep" })))
      .rejects.toMatchObject({ url: `/app/${account.slug}/setup/knowledge?done=kept` });
    expect((await factByText("Installation is not included in the price."))!.status).toBe("rejected");
    expect((await factByText("Installation is included in the price."))!.status).toBe("approved");
    expect((await svc.openFactConflicts(db, account.id)).size).toBe(0);
  });

  it("an unknown choice or fact is refused", async () => {
    await expect(actions.resolveFactConflictAction(form({ slug: account.slug, factId: ids.screen, choice: "replace" })))
      .rejects.toMatchObject({ url: `/app/${account.slug}/setup/knowledge?error=missing` });
    await expect(actions.resolveFactConflictAction(form({ slug: account.slug, factId: ids.screen, choice: "both" })))
      .rejects.toMatchObject({ url: `/app/${account.slug}/setup/knowledge?error=missing` });
  });

  it("a suggestion whose approved fact is no longer approved is a plain suggestion again", async () => {
    const src = (await addNote(db, actor(), account.id, { title: "Delivery note", body: "Delivery takes 5 working days." })).id;
    const loc = (await listSections(db, account.id, src))[0].locator;
    const llm = new ScriptedPipelineLlm([
      () => ({ tool: { name: FACTS_TOOL, input: { ...EMPTY, facts: [
        { topic: "Delivery", statement: "Delivery takes 5 working days.", language: "en", customer_specific: false, known_fact_id: "", evidence: [{ source_id: src, locator: loc, quote: "Delivery takes 5" }] },
      ] } } }),
      () => ({ tool: { name: PLAYBOOK_TOOL, input: PLAYBOOK } }),
    ]);
    expect((await svc.analyzeSources(db, llm, account.id, { store: null })).failed).toBeNull();
    const fiveDays = (await factByText("Delivery takes 5 working days."))!.id;
    expect((await svc.openFactConflicts(db, account.id)).get(fiveDays)?.id).toBe(ids.delivery);
    await db.update(knowledgeFacts).set({ status: "rejected" }).where(eq(knowledgeFacts.id, ids.delivery));
    expect((await svc.openFactConflicts(db, account.id)).has(fiveDays)).toBe(false);
  });
});

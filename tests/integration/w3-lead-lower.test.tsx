/**
 * Lane W3 (lead page, lower part): verified details as a green circle-check
 * with tooltip and note line, Quotes and Orders as two cards (empty and filled,
 * the signed form and pay links on an unpaid signed order), and the timeline
 * folded by default, opened by the URL (no JS) or the remembered cookie.
 * On PGlite, with the agent's tools called directly (no model).
 *
 * With W3_RENDER_DIR set, the rendered pages are also written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { leads, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, cookie: undefined as string | undefined }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "sas_lead_timeline" && holder.cookie ? { name, value: holder.cookie } : undefined) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, publishDraftVersion, saveDraftPlaybook, startTestConversation, verifyField } = await import("@/lib/agent/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { signForm } = await import("@/lib/orders/service");
const { default: LeadCardPage } = await import("@/app/app/[account]/leads/[leadId]/page");
const { default: ConversationsPage } = await import("@/app/app/[account]/conversations/page");

const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
const save = (name: string, html: string) => {
  const dir = process.env.W3_RENDER_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="sas-app"><div class="sas-shell" style="display:block">${html}</div></div></body></html>`);
};
const page = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const section = (html: string, testid: string) => html.split(`data-testid="${testid}"`)[1]?.split("</section>")[0] ?? "";

describe("W3: lead page verified details, Quotes and Orders cards, folded timeline", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let account: SellerAccount;
  let acc = "";
  const ids: Record<string, string> = {};
  const lead = (leadId: string, sp: Record<string, string> = {}) =>
    page(LeadCardPage({ params: Promise.resolve({ account: account.slug, leadId }), searchParams: Promise.resolve(sp) }));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
    ], [{ kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true }]);
    await seedPricing(db, acc, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    for (const language of ["en", "he"]) await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Terms", language, body: "Terms" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      fields: [
        ...draft.playbook.fields.filter((f) => f.stage === "before_quote"),
        { key: "company_name", label: "Company name", stage: "before_order_form" },
        { key: "signatory_name", label: "Signatory name", stage: "before_order_form" },
      ],
    });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc);
    [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    holder.access = { account, user: me, actingAs: false, role: "seller_admin" };

    const session = async (name: string) => {
      const c = (await startTestConversation(db, acc, me.id, { language: "en" }))!;
      await db.update(leads).set({ isTest: false, fullName: name, company: `${name} Ltd` }).where(eq(leads.id, c.leadId));
      const d = await ensureDraftVersion(db, acc);
      return { c, ctx: (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: d.playbook, currency: "ILS", callId, language: "en" }) };
    };
    // A lead with no quote or order yet.
    const empty = await session("Noa Levi");
    ids.emptyLead = empty.c.leadId;
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Cafe", provenance: "buyer" }], next_step: null, objection: null }, empty.ctx("e1"));
    // A lead with a quote and a signed, unpaid order.
    const eli = await session("Eli Shapiro");
    ids.eliLead = eli.c.leadId;
    ids.eliConv = eli.c.conversationId;
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: "Quote", objection: null }, eli.ctx("u1"));
    const q = await runTool("create_quote", { lines: [{ sku: "SNS-200", qty: 1 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null }, eli.ctx("q1"));
    const sent = await runTool("send_order_form", { quote: String(q.result.quote).split(" ")[0] }, eli.ctx("o1"));
    const token = String(sent.result.link).split("/f/")[1];
    const fields = { company_name: "Shapiro Pizza Ltd", company_id: "516000111", billing_address: "1 Herzl St, Haifa", delivery_address: "1 Herzl St, Haifa", invoice_email: "eli@pizza.test" };
    const signed = await signForm(db, token, { fields, fullName: "Eli Shapiro", role: "Owner", agreed: true }, {});
    if (!signed.ok) throw new Error("not signed");
  });
  afterAll(async () => t.close());

  it("verified details: a green circle-check after the value with the source and date as tooltip and label, and one note line", async () => {
    const html = await lead(ids.eliLead);
    save("lead-eli", html);
    const pane = html.split('data-testid="deal-pane"')[1];
    // The value, then the icon, on one line; no "Verified" pill.
    expect(pane).toMatch(/<span class="sas-verified-value">Shapiro Pizza Ltd<span class="sas-verified" role="img" aria-label="From the signed order form, \d{1,2} \w{3} \d{4}" title="From the signed order form, \d{1,2} \w{3} \d{4}" data-verified="">/);
    expect(pane).not.toContain("sas-prov--verified");
    expect(pane).not.toMatch(/>Verified</);
    // Buyer said stays a tag.
    expect(pane).toMatch(/Restaurant<span class="sas-prov sas-prov--buyer">/);
    // One note line under the list.
    expect(pane.match(/data-testid="verified-note"/g)?.length).toBe(1);
    expect(pane).toContain("Filled in and signed by the buyer on the order form.");
  });

  it("verified details: the same icon in the Conversations pane (shared component)", async () => {
    const html = await page(ConversationsPage({ params: Promise.resolve({ account: account.slug }), searchParams: Promise.resolve({ c: ids.eliConv }) }));
    const side = html.split('class="sas-inbox__side"')[1] ?? "";
    expect(side).toContain('aria-label="From the signed order form, ');
    expect(side).toContain("Filled in and signed by the buyer on the order form.");
  });

  it("verified details: a value a person verified says so, and no form note without form values", async () => {
    await verifyField(db, { userId: me.id, actingAs: false }, acc, ids.emptyLead, "business_type", "Bakery");
    const html = await lead(ids.emptyLead);
    const pane = html.split('data-testid="deal-pane"')[1];
    expect(pane).toMatch(/Bakery<span class="sas-verified" role="img" aria-label="Verified by your team, \d{1,2} \w{3} \d{4}"/);
    expect(pane).not.toContain('data-testid="verified-note"');
  });

  it("Quotes and Orders: two empty cards say so, with Create quote as a ghost button", async () => {
    const html = await lead(ids.emptyLead);
    save("lead-empty", html);
    expect(html).toMatch(/<div class="sas-lead-docs" data-tab="deal">/);
    const quotes = section(html, "quotes-card");
    expect(quotes).toMatch(/Quotes <span class="sas-lead-doc__count sas-num">0<\/span>/);
    expect(quotes).toContain("No quotes yet.");
    expect(quotes).toMatch(/<a class="sas-btn sas-btn--ghost sas-btn--sm" href="\/app\/[^"]+\/leads\/[^"]+\/quote">[\s\S]*Create quote<\/a>/);
    const ordersCard = section(html, "orders-card");
    expect(ordersCard).toMatch(/Orders <span class="sas-lead-doc__count sas-num">0<\/span>/);
    expect(ordersCard).toContain("No orders yet.");
  });

  it("Quotes and Orders: filled cards with ID, amount, status and date; an unpaid signed order keeps Signed form, Open pay page and Copy link", async () => {
    const html = await lead(ids.eliLead);
    const quotes = section(html, "quotes-card");
    expect(quotes).toMatch(/Quotes <span class="sas-lead-doc__count sas-num">1<\/span>/);
    expect(quotes).toMatch(/<span class="sas-id">Q-\d+ v1<\/span>/);
    expect(quotes).toContain("sas-pill");
    expect(quotes).toMatch(/class="sas-small sas-lead-doc__date" title="[^"]+">\d{1,2} \w{3}</);
    const ordersCard = section(html, "orders-card");
    expect(ordersCard).toMatch(/Orders <span class="sas-lead-doc__count sas-num">1<\/span>/);
    const row = ordersCard.match(/<a class="sas-list__row"[^>]*data-order-row[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(row).toContain("PD-10001");
    expect(row).toContain("₪");
    expect(row).toContain("sas-pill");
    expect(row).toContain("sas-lead-doc__date");
    expect(ordersCard).toContain("Signed form");
    expect(ordersCard).toMatch(/data-pay-link=""[^>]*>[\s\S]*Open pay page/);
    expect(ordersCard).toContain("Copy link");
  });

  it("timeline: folded by default into one row with the count and the last event; the list stays in the page, hidden", async () => {
    holder.cookie = undefined;
    const html = await lead(ids.eliLead);
    const fold = html.split('data-testid="timeline-fold"')[1];
    expect(html).toContain('data-open="false" data-testid="timeline-fold"');
    expect(fold).toMatch(/aria-expanded="false"/);
    expect(fold).toMatch(/<span class="sas-tl-fold__label">Timeline<\/span><span class="sas-tl-fold__summary sas-small">\d+ events · last: [^<]+, \d{1,2} \w{3}, \d{2}:\d{2}<\/span><span class="sas-tl-fold__action">Show<\/span>/);
    // Without JS the row is a link that opens it.
    expect(fold).toMatch(/href="\/app\/[^"]+\/leads\/[^"?]+\?timeline=open#lead-timeline"/);
    expect(fold).toMatch(/<div id="lead-timeline-list" class="sas-tl-fold__list" hidden="">\s*<ol class="sas-tl"/);
  });

  it("timeline: ?timeline=open opens it in place, keeping other parameters", async () => {
    holder.cookie = undefined;
    const html = await lead(ids.eliLead, { timeline: "open", verified: "1" });
    save("lead-eli-timeline", html);
    const fold = html.split('data-testid="timeline-fold"')[1];
    expect(html).toContain('data-open="true" data-testid="timeline-fold"');
    expect(fold).toMatch(/aria-expanded="true"/);
    expect(fold).toContain(">Hide<");
    expect(fold).toMatch(/href="[^"]*\?verified=1&amp;timeline=closed#lead-timeline"/);
    expect(fold).toMatch(/<div id="lead-timeline-list" class="sas-tl-fold__list"><ol class="sas-tl"/);
  });

  it("timeline: the remembered choice (cookie) opens it; the URL wins over the cookie", async () => {
    holder.cookie = "open";
    expect(await lead(ids.eliLead)).toContain('data-open="true" data-testid="timeline-fold"');
    expect(await lead(ids.eliLead, { timeline: "closed" })).toContain('data-open="false" data-testid="timeline-fold"');
    holder.cookie = "closed";
    expect(await lead(ids.eliLead)).toContain('data-open="false" data-testid="timeline-fold"');
    holder.cookie = undefined;
  });
});

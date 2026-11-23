/**
 * A person's unit price per line in the quote editor (new version): the
 * agent's held quote that uses an approved exception ("Installation is free
 * from 3 sites") is re-priced by a person, the auto-added installation at 0.
 * Totals, VAT and the order form follow through the pricing engine; the
 * version keeps the exception on record ("Exception applied"), the timeline
 * says "Price changed by", the warning is gone, and the buyer sees "Free"
 * (English and Hebrew). The server checks the prices. Scripted data only.
 *
 * With EXC_RENDER_DIR set, the editor and the buyer pages are written there as HTML (visual check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { leadEvents, quoteLines, quotes, quoteVersions, sellerAccounts, toolCalls, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "198.51.100.7", "user-agent": "test" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { default: OrdersPage } = await import("@/app/app/[account]/orders/page");
const { default: QuoteEditorPage } = await import("@/app/app/[account]/leads/[leadId]/quote/page");
const { default: BuyerFormPage } = await import("@/app/f/[token]/page");
const { previewQuoteAction, saveQuoteAction } = await import("@/app/app/[account]/leads/[leadId]/quote/actions");
const { runTool } = await import("@/lib/agent/tools");
const { ensureDraftVersion, saveDraftPlaybook, publishDraftVersion } = await import("@/lib/agent/service");
const { createSimulatedBuyer, startSimulatorConversation } = await import("@/lib/simulator/service");
const { getQuote } = await import("@/lib/quotes/service");
const { exceptionNotice } = await import("@/lib/quotes/exception-notice");
const { createOrderForm } = await import("@/lib/orders/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { leadEventTitle } = await import("@/lib/leads/event-icons");
const { t: tr } = await import("@/lib/i18n");

const OUT = process.env.EXC_RENDER_DIR;
function save(name: string, html: string, opts: { buyer?: boolean; lang?: string } = {}) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const files = opts.buyer ? ["app/f/[token]/buyer.css"] : ["components/sas/sas.css", "components/sas/quote-card.css"];
  const css = files.map((p) => fs.readFileSync(path.join(process.cwd(), p), "utf8")).join("\n");
  const body = opts.buyer ? html : `<div class="sas-app"><div class="sas-shell__main">${html}</div></div>`;
  fs.writeFileSync(path.join(OUT, `${name}.html`), `<!doctype html><html lang="${opts.lang ?? "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${css}</style></head><body>${body}</body></html>`);
}

const EXC_TEXT = "Installation is free from 3 sites";
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const run = async (p: Promise<unknown>) => {
  try { return await p; } catch (e) { const url = (e as { url?: string }).url; if (!url) throw e; return { redirect: url }; }
};

describe("A person's line prices in the quote editor", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc: SellerAccount;
  let seq = 0;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "danny.levi+test@polar.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    await db.update(sellerAccounts).set({ maxDiscountBp: 500, allowSimulatedBuyers: true, status: "live" }).where(eq(sellerAccounts.id, acc.id));
    await seedCatalog(db, acc.id, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
      { sku: "SVC-INST", name: "Installation", plainName: "installation", unit: "site", kind: "service" },
    ], [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false },
    ]);
    await seedPricing(db, acc.id, [{ sku: "SNS-200", oneTime: 59_000 }, { sku: "GW-10", oneTime: 66_000, recurring: 9_000 }, { sku: "SVC-INST", oneTime: 25_000 }], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800, name: "Israel" });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms." });
    await saveLegalSection(db, acc.id, me.id, { sectionKey: "sales_terms", title: "תנאי מכירה", language: "he", body: "תנאים." });
    const draft = await ensureDraftVersion(db, acc.id);
    await saveDraftPlaybook(db, acc.id, {
      ...draft.playbook, agentName: "Maya", maxDiscountBp: 500, fields: draft.playbook.fields.filter((f) => f.stage === "before_quote"),
      exceptions: [{ id: "exc-install", text: EXC_TEXT, approvedAt: "2026-11-01T00:00:00Z", approvedBy: null }],
    });
    await publishDraftVersion(db, { userId: me.id, actingAs: false }, acc.id);
    [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc.id));
    holder.access = { account: acc, user: me, actingAs: false, role: "seller_admin" as const };
  });
  afterAll(async () => t.close());

  /** The agent's quote held for the seller: 3 sensors, 1 hub, 1 site (installation added by the rule), with the exception. */
  const heldQuote = async (language: "en" | "he" = "en") => {
    const made = await createSimulatedBuyer(db, { userId: me.id, actingAs: false }, acc, { fullName: "Rina Cohen", company: "Rina's Kitchen", language, country: "IL" });
    if (!made.ok) throw new Error("buyer");
    const started = await startSimulatorConversation(db, { userId: me.id, actingAs: false }, acc.id, made.lead.id);
    if (!started.ok) throw new Error(started.reason);
    const draft = await ensureDraftVersion(db, acc.id);
    const ctx = (callId: string) => ({ db, accountId: acc.id, conversationId: started.conversationId, leadId: made.lead.id, playbook: draft.playbook, currency: "ILS", callId, language });
    await runTool("update_deal_state", { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null }, ctx(`u${++seq}`));
    const input = { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: "exc-install", headline: null };
    const r = await runTool("create_quote", input, ctx(`q${++seq}`));
    await db.insert(toolCalls).values({ accountId: acc.id, conversationId: started.conversationId, sequence: seq, name: "create_quote", input, result: r.result, outcome: r.outcome });
    const quoteId = String(r.result.quote_id);
    const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(q.status).toBe("awaiting_approval");
    return { quoteId, leadId: made.lead.id };
  };
  /** The editor's form: the agent's lines, plus `extra` fields (prices, note). */
  const editorForm = (b: { quoteId: string; leadId: string }, extra: Record<string, string> = {}) =>
    form({ slug: acc.slug, leadId: b.leadId, fromQuote: b.quoteId, idem: crypto.randomUUID(), "qty:SNS-200": "2", "qty:GW-10": "1", sites: "1", discount: "", removedSet: "1", ...extra });
  const ok = <T extends { status: string }>(p: T) => { expect(p.status).toBe("ok"); return p as Extract<T, { status: "ok" }>; };

  it("preview: a lower price, 0 on the auto-added installation and a monthly price go through the engine (totals and VAT); reset gives the list price back", async () => {
    const b = await heldQuote();
    const list = ok(await previewQuoteAction(editorForm(b)));
    expect(list.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ autoAdded: true, unitPriceMinor: 25_000, priceSource: "list" });
    expect(list.oneTime).toMatchObject({ subtotal: 209_000, tax: 37_620, total: 246_620 });

    const pv = ok(await previewQuoteAction(editorForm(b, { "price:SNS-200:one_time": "500", "price:SVC-INST:one_time": "0", "price:GW-10:recurring": "45.50" })));
    expect(pv.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ autoAdded: true, unitPriceMinor: 0, lineTotalMinor: 0, priceSource: "custom", listUnitPriceMinor: 25_000 });
    expect(pv.lines.find((l) => l.sku === "SNS-200")).toMatchObject({ unitPriceMinor: 50_000, lineTotalMinor: 100_000, listUnitPriceMinor: 59_000 });
    expect(pv.lines.find((l) => l.sku === "GW-10" && l.charge === "recurring")).toMatchObject({ unitPriceMinor: 4_550, priceSource: "custom", listUnitPriceMinor: 9_000 });
    // 2 × 500 + 660 + 0 = 1,660; VAT 18% = 298.80.
    expect(pv.oneTime).toMatchObject({ subtotal: 166_000, tax: 29_880, total: 195_880 });
    expect(pv.recurring).toMatchObject({ subtotal: 4_550, tax: 819, total: 5_369 });

    // Reset: no price field sent, the list price is back.
    expect(ok(await previewQuoteAction(editorForm(b))).lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ unitPriceMinor: 25_000, priceSource: "list" });
  });

  it("the server refuses a negative, absurd or over-precise price, and a malformed field", async () => {
    const b = await heldQuote();
    for (const bad of ["-5", "99999999", "10000000.01", "1.234", "abc", "1e5"]) {
      const pv = await previewQuoteAction(editorForm(b, { "price:SNS-200:one_time": bad }));
      expect(pv).toEqual({ status: "errors", messages: ["The price for SNS-200 must be a number of 0 or more, up to ₪10,000,000.00."] });
      expect(await saveQuoteAction({ status: "idle" }, editorForm(b, { "price:SNS-200:one_time": bad, note: "x", intent: "draft" })))
        .toEqual({ status: "error", messages: ["The price for SNS-200 must be a number of 0 or more, up to ₪10,000,000.00."] });
    }
    expect((await previewQuoteAction(editorForm(b, { "price:SNS 200:one_time": "1" }))).status).toBe("errors");
    // The highest allowed price is fine.
    expect((await previewQuoteAction(editorForm(b, { "price:SNS-200:one_time": "10000000" }))).status).toBe("ok");
    // The "What changed" note is still required.
    expect(await saveQuoteAction({ status: "idle" }, editorForm(b, { "price:SVC-INST:one_time": "0", intent: "draft" }))).toEqual({ status: "error", messages: [tr("quote.editor.note_required")] });
  });

  it("saving: a person's version keeps the exception, needs no approval, the warning is gone; timeline and history say who changed the price; the 0 survives re-pricing", async () => {
    const b = await heldQuote();
    const r = await run(saveQuoteAction({ status: "idle" }, editorForm(b, { "price:SVC-INST:one_time": "0", note: "Installation free from 3 sites", intent: "draft" })));
    expect(r).toEqual({ redirect: `/app/${acc.slug}/orders?quote=${b.quoteId}` });
    const d = (await getQuote(db, acc.id, b.quoteId))!;
    const cur = d.versions[0];
    expect(d.quote.status).toBe("draft");
    expect(cur.version).toMatchObject({ version: 2, createdByActor: "human", approvedByUserId: me.id, oneTimeSubtotalMinor: 184_000, oneTimeTaxMinor: 33_120, oneTimeTotalMinor: 217_120 });
    expect(cur.version.approvalReasons).toEqual([{ kind: "exception", id: "exc-install", text: EXC_TEXT }]);
    expect(cur.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ priceSource: "custom", unitPriceMinor: 0, lineTotalMinor: 0 });
    expect(exceptionNotice(d.quote.status, cur.version, cur.lines)).toBeNull();

    // Timeline: "Price changed by Danny" (display name, never the email).
    const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, b.leadId), eq(leadEvents.type, "quote.price_changed")));
    expect(ev.data).toMatchObject({ quoteId: b.quoteId, version: 2, by: "Danny" });
    expect(leadEventTitle(ev.type, ev.data, tr)).toBe("Price changed by Danny");
    expect(JSON.stringify(ev.data)).not.toContain("@");

    // The seller's quote view: the exception on record, who changed the price, no warning.
    const page = renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ account: acc.slug }), searchParams: Promise.resolve({ quote: b.quoteId }) }));
    save("orders-price-changed", page);
    expect(page).toContain(`Exception applied: ${EXC_TEXT}`);
    expect(page).toMatch(/data-price-changed=""> · Price changed by <bdi>you<\/bdi>|data-price-changed=""> · Price changed by ⁨you⁩|data-price-changed=""> · Price changed by you/);
    expect(page).not.toContain("data-exception-notice");

    // The next version starts from the person's prices: the editor shows 0 with the list price struck, and the rule does not put 250 back.
    const editor = renderToStaticMarkup(await QuoteEditorPage({ params: Promise.resolve({ account: acc.slug, leadId: b.leadId }), searchParams: Promise.resolve({ from: b.quoteId }) }));
    save("editor-price", editor);
    expect(editor).toMatch(/data-price-edit="SVC-INST:one_time" data-changed="true"><s class="sas-small sas-num" data-list-price="" aria-label="List price ₪250.00">₪250.00<\/s><input[^>]*name="price:SVC-INST:one_time" value="0.00"/);
    expect(editor).toContain("data-reset-price");
    const again = ok(await previewQuoteAction(editorForm(b, { "price:SVC-INST:one_time": "0.00" })));
    expect(again.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ autoAdded: true, unitPriceMinor: 0, priceSource: "custom" });
    // A version with no price change (a quantity) adds no "Price changed" event.
    await run(saveQuoteAction({ status: "idle" }, editorForm(b, { "qty:SNS-200": "3", "price:SVC-INST:one_time": "0.00", note: "3 sensors", intent: "draft" })));
    expect(await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, b.leadId), eq(leadEvents.type, "quote.price_changed")))).toHaveLength(1);
    const v3 = (await getQuote(db, acc.id, b.quoteId))!.versions[0];
    expect(v3.version.version).toBe(3);
    expect(v3.lines.find((l) => l.sku === "SVC-INST")).toMatchObject({ priceSource: "custom", lineTotalMinor: 0 });
    expect(v3.version.approvalReasons).toEqual([{ kind: "exception", id: "exc-install", text: EXC_TEXT }]);
  });

  it("the order form follows the person's prices and shows the 0 line as Free, in English and Hebrew", async () => {
    for (const lang of ["en", "he"] as const) {
      const b = await heldQuote(lang);
      await run(saveQuoteAction({ status: "idle" }, editorForm(b, { "price:SVC-INST:one_time": "0", note: "Installation free", intent: "draft" })));
      const f = await createOrderForm(db, acc.id, { kind: "human", userId: me.id, actingAs: false }, b.quoteId);
      if (!f.ok) throw new Error(f.reason);
      const html = renderToStaticMarkup(await BuyerFormPage({ params: Promise.resolve({ token: f.token }), searchParams: Promise.resolve({ lang }) }));
      save(`order-form-free-${lang}`, html, { buyer: true, lang });
      expect(html).toContain(lang === "he" ? ">חינם<" : ">Free<");
      expect(html).not.toMatch(/₪0\.00(?!\/)/);
      // Totals from the engine: 2 × 590 + 660 + 0 = 1,840 + 18% VAT = 2,171.20.
      expect(html).toContain("₪2,171.20");
      const [line] = await db.select().from(quoteLines).where(and(eq(quoteLines.sku, "SVC-INST"), eq(quoteLines.quoteVersionId, (await db.select().from(quoteVersions).where(and(eq(quoteVersions.quoteId, b.quoteId), eq(quoteVersions.version, 2))))[0].id)));
      expect(line.lineTotalMinor).toBe(0);
    }
  });
});

/**
 * Auto-added lines removed at the buyer's request (quote_versions.removed_auto_add):
 * stored on the version, inherited by the next one, honoured only for removable
 * rules, and kept through the editor, the order form's re-price and the agent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { quoteLines, quoteVersions, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { createQuote, createQuoteVersion, previewQuote } from "@/lib/quotes/service";
import { acceptNewPrice, createOrderForm, loadForm, priceCheck } from "@/lib/orders/service";
import { saveLegalSection } from "@/lib/orders/settings";
import { ensureDraftVersion, startTestConversation } from "@/lib/agent/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { republishPricing, seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { previewQuoteAction, saveQuoteAction } = await import("@/app/app/[account]/leads/[leadId]/quote/actions");
const { default: QuoteEditorPage } = await import("@/app/app/[account]/leads/[leadId]/quote/page");
const { runTool, TOOL_DEFS } = await import("@/lib/agent/tools");
const { renderToStaticMarkup } = await import("react-dom/server");

/** Form data; an array value appends the key once per item. */
const form = (v: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) for (const x of Array.isArray(val) ? val : [val]) f.append(k, x);
  return f;
};
const run = async <T,>(p: Promise<T>) => {
  try {
    return await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (!url) throw e;
    return { redirect: url };
  }
};

describe("auto-added lines removed at the buyer's request", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let accA: SellerAccount, accB: SellerAccount;
  let lineageA = "";
  let phone = 5550300;
  const human = () => ({ kind: "human" as const, userId: me.id, actingAs: false });
  const as = (account: SellerAccount) => { holder.access = { account, user: me, actingAs: false, role: "seller_admin" }; };
  const newLead = async (account: SellerAccount) => {
    const p = parseLead({ fullName: "Rina Cohen", company: "Rina's Kitchen", phone: `052${phone++}`, language: "en", consent: "on", consentSource: "web form" }, "IL", { language: "en", now: new Date() });
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const r = await upsertLead(db, account.id, { userId: me.id, actingAs: false }, p.value, "manual", { now: new Date() });
    if (!r.ok) throw new Error();
    return r.lead.id;
  };
  const linesOf = async (versionId: string) =>
    (await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, versionId)).orderBy(asc(quoteLines.sortOrder))).map((l) => l.sku);
  const versionOf = async (id: string) => (await db.select().from(quoteVersions).where(eq(quoteVersions.id, id)))[0];
  const editorHtml = async (account: SellerAccount, leadId: string, from?: string) =>
    renderToStaticMarkup(await QuoteEditorPage({ params: Promise.resolve({ account: account.slug, leadId }), searchParams: Promise.resolve(from ? { from } : {}) }));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account;
    };
    accA = await mk("Alpha");
    accB = await mk("Beta");
    const items = [
      { sku: "GW-10", name: "Site gateway", unit: "site" },
      { sku: "SNS-200", name: "Wireless fridge sensor", unit: "device" },
      { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service" as const },
      { sku: "SETUP", name: "Setup fee", unit: "item", kind: "service" as const },
    ];
    const entries = [
      { sku: "GW-10", oneTime: 66_000 },
      { sku: "SNS-200", oneTime: 59_000 },
      { sku: "SVC-INST", oneTime: 25_000 },
      { sku: "SETUP", oneTime: 15_000 },
    ];
    // A: installation is required with a gateway; the setup fee can be removed.
    await seedCatalog(db, accA.id, items, [
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false },
      { kind: "auto_add", sku: "SETUP", whenAnyOf: ["SNS-200"], qty: "one", removable: true },
    ]);
    ({ lineageId: lineageA } = await seedPricing(db, accA.id, entries, { userId: me.id }));
    // B: the same SKUs, but its setup fee can not be removed.
    await seedCatalog(db, accB.id, items, [{ kind: "auto_add", sku: "SETUP", whenAnyOf: ["SNS-200"], qty: "one", removable: false }]);
    await seedPricing(db, accB.id, entries, { userId: me.id });
    await saveLegalSection(db, accA.id, me.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "Terms" });
  });
  afterAll(async () => t.close());

  const lines = [{ sku: "GW-10", qty: 1 }, { sku: "SNS-200", qty: 2 }];

  it("stores a removal on the version; the next version inherits it unless the input overrides it", async () => {
    const leadId = await newLead(accA);
    const r = await createQuote(db, accA.id, human(), leadId, { lines, discountBp: 0, sites: 1, removedByBuyer: ["SETUP"] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.version.removedAutoAdd).toEqual(["SETUP"]);
    expect(await linesOf(r.version.id)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);
    expect(r.version.oneTimeTotalMinor).toBe(66_000 + 2 * 59_000 + 25_000);

    // No removals in the input: the current version's carry over.
    const v2 = await createQuoteVersion(db, accA.id, human(), r.quote.id, { lines: [{ sku: "GW-10", qty: 1 }, { sku: "SNS-200", qty: 3 }], discountBp: 0, sites: 1, changeNote: "3 sensors" });
    if (!v2.ok) throw new Error(v2.reason);
    expect(v2.version.removedAutoAdd).toEqual(["SETUP"]);
    expect(await linesOf(v2.version.id)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);

    // A removal stays stored while its product is off the quote, so it holds when the product comes back.
    const v3 = await createQuoteVersion(db, accA.id, human(), r.quote.id, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0, sites: 1, changeNote: "No sensors" });
    if (!v3.ok) throw new Error(v3.reason);
    expect(v3.version.removedAutoAdd).toEqual(["SETUP"]);
    const v4 = await createQuoteVersion(db, accA.id, human(), r.quote.id, { lines, discountBp: 0, sites: 1, changeNote: "Sensors back" });
    if (!v4.ok) throw new Error(v4.reason);
    expect(await linesOf(v4.version.id)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);

    // An empty list adds the line back.
    const v5 = await createQuoteVersion(db, accA.id, human(), r.quote.id, { lines, discountBp: 0, sites: 1, removedByBuyer: [], changeNote: "Setup back" });
    if (!v5.ok) throw new Error(v5.reason);
    expect(v5.version.removedAutoAdd).toEqual([]);
    expect(await linesOf(v5.version.id)).toEqual(["GW-10", "SNS-200", "SVC-INST", "SETUP"]);
  });

  it("a non-removable rule ignores the removal; unknown SKUs and SKUs the seller quoted are not stored", async () => {
    const leadId = await newLead(accA);
    const r = await createQuote(db, accA.id, human(), leadId, { lines, discountBp: 0, sites: 2, removedByBuyer: ["SVC-INST", "NOPE", "GW-10", "SETUP", "SETUP"] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.version.removedAutoAdd).toEqual(["SETUP"]);
    expect(await linesOf(r.version.id)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);
    // The seller picks the setup fee by hand: it is on the quote, so it is no removal.
    const v2 = await createQuoteVersion(db, accA.id, human(), r.quote.id, { lines: [...lines, { sku: "SETUP", qty: 1 }], discountBp: 0, sites: 2, changeNote: "Setup fee" });
    if (!v2.ok) throw new Error(v2.reason);
    expect(v2.version.removedAutoAdd).toEqual([]);
  });

  it("the editor preview with a removal matches the saved quote, and a new version restores the removal", async () => {
    as(accA);
    const leadId = await newLead(accA);
    const f = { slug: accA.slug, leadId, "qty:GW-10": "1", "qty:SNS-200": "2", sites: "1", removedSet: "1", removed: ["SETUP", "SVC-INST"] };
    const pv = await previewQuoteAction(form(f));
    if (pv.status !== "ok") throw new Error(JSON.stringify(pv));
    expect(pv.lines.map((l) => [l.sku, l.autoAdded, l.removable])).toEqual([["GW-10", false, true], ["SNS-200", false, true], ["SVC-INST", true, false]]);
    expect(pv.lines.find((l) => l.sku === "SVC-INST")?.requiredWith).toBe("Site gateway");
    expect(pv.removed).toEqual([{ sku: "SETUP", name: "Setup fee" }]);

    const saved = await run(saveQuoteAction({ status: "idle" }, form({ ...f, idem: "rm-1" })));
    const quoteId = /quote=([0-9a-f-]{36})/.exec((saved as { redirect: string }).redirect)![1];
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
    expect(v.removedAutoAdd).toEqual(["SETUP"]);
    expect({ subtotal: v.oneTimeSubtotalMinor, discount: v.oneTimeDiscountMinor, tax: v.oneTimeTaxMinor, total: v.oneTimeTotalMinor }).toEqual(pv.oneTime);
    expect(await linesOf(v.id)).toEqual(pv.lines.map((l) => l.sku));

    // Opening the version: the removal comes back (hidden input, "Removed" row, "Add back"); the locked line has its hint.
    const html = await editorHtml(accA, leadId, quoteId);
    expect(html).toContain('name="removed" value="SETUP"');
    expect(html).toContain("Removed at the buyer&#x27;s request");
    expect(html).toContain('id="q-back-SETUP"');
    expect(html).toContain("Required with Site gateway. You can discount it within your limits.");
    expect(html).not.toContain('id="q-rm-SVC-INST"');
    for (const id of ['id="qe-add"', 'id="q-GW-10"', 'id="q-SNS-200"', 'id="q-sites"', 'id="q-disc"']) expect(html).toContain(id);
    expect(html).not.toContain('id="q-SETUP"');

    // Adding it back (no "removed" fields) brings the line back.
    const back = await previewQuoteAction(form({ ...f, removed: [] }));
    if (back.status !== "ok") throw new Error();
    expect(back.lines.map((l) => l.sku)).toContain("SETUP");
    expect(back.lines.find((l) => l.sku === "SETUP")).toMatchObject({ autoAdded: true, removable: true });
    expect(back.removed).toEqual([]);

    // A version without removals: the removable line has a Remove button, the required one does not.
    const plain = await createQuote(db, accA.id, human(), leadId, { lines, discountBp: 0, sites: 1 });
    if (!plain.ok) throw new Error(plain.reason);
    const html2 = await editorHtml(accA, leadId, plain.quote.id);
    expect(html2).toContain('id="q-rm-SETUP"');
    expect(html2).not.toContain('id="q-rm-SVC-INST"');
    expect(html2).not.toContain('name="removed"');
    expect(html2).toContain('name="removedSet"');
  });

  it("previewQuote of a new version carries the current removals over, like createQuoteVersion", async () => {
    const leadId = await newLead(accA);
    const r = await createQuote(db, accA.id, human(), leadId, { lines, discountBp: 0, sites: 1, removedByBuyer: ["SETUP"] });
    if (!r.ok) throw new Error(r.reason);
    const pv = await previewQuote(db, accA.id, leadId, { lines, discountBp: 0, sites: 1 }, r.quote.id);
    if (!pv.ok) throw new Error(pv.reason);
    expect(pv.removed).toEqual(["SETUP"]);
    expect(pv.priced.lines.map((l) => l.sku)).not.toContain("SETUP");
  });

  it("priceCheck and acceptNewPrice keep the removal; the order snapshot has no removed line", async () => {
    const leadId = await newLead(accA);
    const r = await createQuote(db, accA.id, human(), leadId, { lines, discountBp: 0, sites: 1, removedByBuyer: ["SETUP"] });
    if (!r.ok) throw new Error(r.reason);
    const f = await createOrderForm(db, accA.id, human(), r.quote.id);
    if (!f.ok) throw new Error(f.reason);
    expect(f.form.snapshot.lines.map((l) => l.sku)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);

    await republishPricing(db, accA.id, lineageA, [{ sku: "SNS-200", oneTime: 60_000 }]);
    const check = await priceCheck(db, f.form);
    if (check.status !== "changed") throw new Error(check.status);
    expect(check.lines.map((l) => l.sku)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);
    expect(check.oneTimeMinor).toBe(66_000 + 2 * 60_000 + 25_000);

    const accepted = await acceptNewPrice(db, f.token);
    if (!accepted.ok) throw new Error(accepted.reason);
    const fresh = await loadForm(db, accepted.token);
    if (fresh?.state !== "open") throw new Error();
    expect(fresh.form.snapshot.lines.map((l) => l.sku)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);
    expect(fresh.form.snapshot.oneTime.totalMinor).toBe(check.oneTimeMinor);
    const v = await versionOf(fresh.form.quoteVersionId);
    expect(v.removedAutoAdd).toEqual(["SETUP"]);
    await republishPricing(db, accA.id, lineageA, [{ sku: "SNS-200", oneTime: 59_000 }]);
  });

  it("the agent's create_quote removes only removable automatic lines and says which ones stay", async () => {
    const def = TOOL_DEFS.find((d) => d.name === "create_quote")!;
    const schema = def.input_schema as unknown as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(def.strict).toBe(true);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.remove_auto_added).toMatchObject({ type: ["array", "null"], items: { type: "string" } });

    const draft = await ensureDraftVersion(db, accA.id);
    const c = (await startTestConversation(db, accA.id, me.id, { language: "en" }))!;
    const ctx = (callId: string) => ({ db, accountId: accA.id, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId });
    const fields = draft.playbook.fields.filter((x) => x.stage === "before_quote").map((x) => ({ key: x.key, value: x.key === "sites" ? "1" : "Cafe", provenance: "buyer" }));
    await runTool("update_deal_state", { updates: fields, next_step: null, objection: null }, ctx("q0"));

    const r = await runTool("create_quote", { lines, discount_percent: 0, sites: 1, remove_auto_added: ["setup", "SVC-INST"] }, ctx("q1"));
    expect(r.result).toMatchObject({ ok: true, removed_at_buyer_request: ["SETUP"], cannot_remove: ["SVC-INST"] });
    expect(String(r.result.cannot_remove_message)).toContain("SVC-INST");
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.idempotencyKey, "tool:q1"));
    expect(v.removedAutoAdd).toEqual(["SETUP"]);
    expect(await linesOf(v.id)).toEqual(["GW-10", "SNS-200", "SVC-INST"]);

    // null: nothing removed.
    const plain = await runTool("create_quote", { lines, discount_percent: 0, sites: 1, remove_auto_added: null }, ctx("q2"));
    expect(plain.result).not.toHaveProperty("removed_at_buyer_request");
    expect(plain.result).not.toHaveProperty("cannot_remove");
    const [v2] = await db.select().from(quoteVersions).where(eq(quoteVersions.idempotencyKey, "tool:q2"));
    expect(await linesOf(v2.id)).toEqual(["GW-10", "SNS-200", "SVC-INST", "SETUP"]);
  });

  it("account isolation: each account's own rules decide, and nobody reaches another account's quote", async () => {
    const leadA = await newLead(accA);
    const leadB = await newLead(accB);
    const a = await createQuote(db, accA.id, human(), leadA, { lines, discountBp: 0, sites: 1, removedByBuyer: ["SETUP"] });
    if (!a.ok) throw new Error(a.reason);
    // B's setup fee is required: the same removal does nothing there.
    const b = await createQuote(db, accB.id, human(), leadB, { lines, discountBp: 0, sites: 1, removedByBuyer: ["SETUP"] });
    if (!b.ok) throw new Error(b.reason);
    expect(b.version.removedAutoAdd).toEqual([]);
    expect(await linesOf(b.version.id)).toContain("SETUP");

    expect(await createQuoteVersion(db, accB.id, human(), a.quote.id, { lines, discountBp: 0, removedByBuyer: [] })).toEqual({ ok: false, reason: "quote_not_found" });
    expect(await previewQuote(db, accB.id, leadA, { lines, discountBp: 0 }, a.quote.id)).toEqual({ ok: false, reason: "lead_not_found" });
    expect(await previewQuote(db, accB.id, leadB, { lines, discountBp: 0 }, a.quote.id)).toEqual({ ok: false, reason: "quote_not_found" });
    as(accB);
    await expect(editorHtml(accB, leadB, a.quote.id)).rejects.toThrow("NEXT_NOT_FOUND");
    // A's stored removal is untouched.
    expect((await versionOf(a.version.id)).removedAutoAdd).toEqual(["SETUP"]);
  });
});

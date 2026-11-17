/** P11.2–P11.3 (lane B): prices only when it is time, the app's quote message, the delivery phrase, the order form without chat company fields. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { messages, quoteVersions, sellerAccounts, signatures, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalog, seedPricing } from "../helpers/pricing";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => null,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { default: BuyerFormPage } = await import("@/app/f/[token]/page");
const { runTool, PRICES_WITHHELD } = await import("@/lib/agent/tools");
const { ensureDraftVersion, saveDraftPlaybook, startTestConversation } = await import("@/lib/agent/service");
const { saveLegalSection } = await import("@/lib/orders/settings");
const { loadForm, signForm } = await import("@/lib/orders/service");
const { deliveryByPhrase, shortDate } = await import("@/lib/agent/quote-message");
const { estimateDelivery } = await import("@/lib/delivery/eta");
const { deliveryPlanFor } = await import("@/lib/delivery/plan");
const { resolveMarket } = await import("@/lib/markets/service");
const { t: tr } = await import("@/lib/i18n");

describe("P11 tools: prices, the quote message and the order form", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let me: User;
  let acc = "";

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [me] = await db.insert(users).values({ clerkId: "u", email: "d@p.test", firstName: "Danny", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Polar Demo", market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@polar.test" });
    if (!p.ok) throw new Error();
    acc = (await createAccount(db, { userId: me.id, actingAs: false }, p.value)).account.id;
    await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc));
    await seedCatalog(db, acc, [
      { sku: "SNS-200", name: "Wireless fridge sensor", plainName: "wireless fridge sensor", valueLine: "Alerts your phone the moment a fridge drifts out of range.", description: "Bluetooth, 2-year battery.", unit: "device" },
      { sku: "GW-10", name: "Site gateway", plainName: "kitchen hub", unit: "site" },
      { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service", description: "About an hour on site." },
    ], [
      { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true },
      { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false },
    ]);
    // Prices before VAT, VAT 18% (the spec's example).
    await seedPricing(db, acc, [
      { sku: "SNS-200", oneTime: 59_000 },
      { sku: "GW-10", oneTime: 66_000, recurring: 9_000 },
      { sku: "SVC-INST", oneTime: 25_000 },
    ], { userId: me.id, pricesIncludeTax: false, taxRateBp: 1800 });
    for (const language of ["en", "he"]) await saveLegalSection(db, acc, me.id, { sectionKey: "sales_terms", title: "Terms", language, body: "Terms" });
    const draft = await ensureDraftVersion(db, acc);
    await saveDraftPlaybook(db, acc, {
      ...draft.playbook,
      maxDiscountBp: 500,
      fields: [
        ...draft.playbook.fields.filter((f) => f.stage === "before_quote"),
        { key: "company_name", label: "Company name", stage: "before_order_form" },
        { key: "company_id", label: "Company ID", stage: "before_order_form" },
      ],
    });
  });
  afterAll(async () => t.close());

  const session = async (language: "en" | "he") => {
    const c = (await startTestConversation(db, acc, me.id, { language }))!;
    const draft = await ensureDraftVersion(db, acc);
    return { c, ctx: (callId: string) => ({ db, accountId: acc, conversationId: c.conversationId, leadId: c.leadId, playbook: draft.playbook, currency: "ILS", callId, language }) };
  };
  const qualify = { updates: [{ key: "business_type", value: "Restaurant", provenance: "buyer" }, { key: "sites", value: "1", provenance: "buyer" }], next_step: null, objection: null };
  const quoteInput = { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], discount_percent: 0, sites: 1, remove_auto_added: null, exception: null };
  const expectedDeliveryBy = async (language: string) => {
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, acc));
    const plan = deliveryPlanFor(account, await resolveMarket(db, acc, null))!;
    return deliveryByPhrase(estimateDelivery({ ...plan, from: new Date() }).latest, language);
  };
  const validUntil = async (callId: string, language: string) => {
    const [v] = await db.select().from(quoteVersions).where(eq(quoteVersions.idempotencyKey, `tool:${callId}`));
    return shortDate(v.validUntil, "Asia/Jerusalem", language);
  };

  it("lookups return plain names and value lines, and no price until it is time", async () => {
    const { ctx } = await session("en");
    const s = await runTool("search_catalog", { query: "fridge" }, ctx("s1"));
    expect(s.result).toMatchObject({ ok: true, prices: PRICES_WITHHELD });
    expect((s.result.items as unknown[])[0]).toEqual({
      sku: "SNS-200", name: "Wireless fridge sensor", plain_name: "wireless fridge sensor", kind: "product", unit: "device", sold_here: true,
      availability: null, value: "Alerts your phone the moment a fridge drifts out of range.", details: "Bluetooth, 2-year battery.",
    });
    // Without a value line the description is the value; without a plain name the name is.
    const all = (await runTool("search_catalog", { query: "" }, ctx("s2"))).result.items as Record<string, unknown>[];
    expect(all.find((i) => i.sku === "SVC-INST")).toMatchObject({ plain_name: "Installation", value: "About an hour on site." });
    expect(all.find((i) => i.sku === "SVC-INST")).not.toHaveProperty("details");
    // Searching finds plain names too.
    expect(((await runTool("search_catalog", { query: "hub" }, ctx("s3"))).result.items as { sku: string }[]).map((i) => i.sku)).toEqual(["GW-10"]);
    const fit = await runTool("check_fit", { lines: [{ sku: "SNS-200", qty: 2 }, { sku: "GW-10", qty: 1 }], sites: 1 }, ctx("f1"));
    expect(fit.result).toMatchObject({ ok: true, prices: PRICES_WITHHELD, lines: expect.arrayContaining([expect.objectContaining({ sku: "GW-10", plain_name: "kitchen hub" })]) });
    expect(JSON.stringify(fit.result)).not.toMatch(/₪|total/);
    expect(String(fit.result.delivery)).toMatch(/^estimate /);
  });

  it("create_quote: the app sends the quote message in English; the result labels every total and gives the delivery phrase", async () => {
    const { c, ctx } = await session("en");
    await runTool("update_deal_state", qualify, ctx("u1"));
    const r = await runTool("create_quote", quoteInput, ctx("q-en"));
    expect(r.outcome).toBe("ok");
    expect(r.result).toMatchObject({
      status: "ready",
      price_basis: "Prices are before VAT; VAT 18% is added on the quote.",
      totals: {
        subtotal_before_vat: "₪2,090.00", vat_rate: "18%", vat_amount: "₪376.20", total_today_including_vat: "₪2,466.20",
        recurring_before_vat: "₪90.00/month", recurring_vat_amount: "₪16.20/month", recurring_total_including_vat: "₪106.20/month",
      },
      delivery_by: await expectedDeliveryBy("en"),
      message: "The quote message was sent to the buyer by the app. Do not repeat the lines or totals. Add only the closing sentence.",
    });
    expect(String(r.result.delivery_by)).toMatch(/^by about \d{1,2} [A-Z][a-z]{2}$/);
    // The old ambiguous fields are gone.
    for (const k of ["due_on_signing", "monthly", "recurring", "prices_include_tax"]) expect(r.result).not.toHaveProperty(k);
    const rows = await db.select().from(messages).where(and(eq(messages.conversationId, c.conversationId), eq(messages.actor, "agent")));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(r.result.quote_message_id);
    expect(rows[0].language).toBe("en");
    expect(rows[0].body).toBe([
      "*Quote Q-1001*",
      "2 × wireless fridge sensor (SNS-200): ₪1,180",
      "1 × kitchen hub (GW-10): ₪660, plus ₪90 a month",
      "Installation: ₪250",
      "VAT 18%: ₪376.20",
      "*Today: ₪2,466.20 including VAT*",
      "*Then: ₪106.20 a month including VAT*",
      `Valid until ${await validUntil("q-en", "en")}`,
    ].join("\n"));
    // Once a quote exists, lookups show prices again (a changed need gets a new quote).
    expect((await runTool("search_catalog", { query: "hub" }, ctx("s4"))).result).toMatchObject({ prices_include_tax: false });
  });

  it("create_quote in a Hebrew conversation writes the Hebrew layout and the Hebrew delivery phrase", async () => {
    const { c, ctx } = await session("he");
    await runTool("update_deal_state", qualify, ctx("u2"));
    const r = await runTool("create_quote", quoteInput, ctx("q-he"));
    expect(r.result.delivery_by).toBe(await expectedDeliveryBy("he"));
    expect(String(r.result.delivery_by)).toMatch(/^עד בערך \d{1,2} /);
    const [m] = await db.select().from(messages).where(eq(messages.id, String(r.result.quote_message_id)));
    expect(m.conversationId).toBe(c.conversationId);
    expect(m.body).toBe([
      "*הצעת מחיר Q-1002*",
      "2 × wireless fridge sensor (SNS-200): ₪1,180",
      "1 × kitchen hub (GW-10): ₪660, ועוד ₪90 לחודש",
      "Installation: ₪250",
      "מע\"מ 18%: ₪376.20",
      "*היום: ₪2,466.20 כולל מע\"מ*",
      "*לאחר מכן: ₪106.20 לחודש כולל מע\"מ*",
      `בתוקף עד ${await validUntil("q-he", "he")}`,
    ].join("\n"));
  });

  it("a quote awaiting the seller's approval sends no quote message and promises no totals", async () => {
    const { c, ctx } = await session("en");
    await runTool("update_deal_state", qualify, ctx("u3"));
    const r = await runTool("create_quote", { ...quoteInput, discount_percent: 15 }, ctx("q-wait"));
    expect(r.result).toMatchObject({ status: "awaiting_seller_approval", totals: "not final: the seller must approve this quote first" });
    expect(String(r.result.message)).toContain("confirming the price with the team");
    // P11 wave 2: the web chat gets a placeholder card instead (no numbers), linked as a held quote message.
    expect(r.result).toMatchObject({ quote_held: true });
    const rows = await db.select().from(messages).where(eq(messages.conversationId, c.conversationId));
    expect(rows.map((m) => m.id)).toEqual([r.result.quote_message_id]);
    expect(rows[0].body).not.toMatch(/\d/);
  });

  it("without a delivery lead time the result says it is not set", async () => {
    await db.update(sellerAccounts).set({ deliveryLeadTime: null }).where(eq(sellerAccounts.id, acc));
    try {
      const { ctx } = await session("en");
      await runTool("update_deal_state", qualify, ctx("u4"));
      const r = await runTool("create_quote", quoteInput, ctx("q-nodate"));
      expect(String(r.result.delivery_by)).toMatch(/^not set: /);
    } finally {
      await db.update(sellerAccounts).set({ deliveryLeadTime: { minDays: 5, maxDays: 10, businessDays: true } }).where(eq(sellerAccounts.id, acc));
    }
  });

  it("send_order_form goes out without company fields; the form asks for them, prefilled from the chat, and requires them before signing", async () => {
    const { ctx } = await session("en");
    // The buyer said the company name in chat; the company ID is still unknown.
    await runTool("update_deal_state", { ...qualify, updates: [...qualify.updates, { key: "company_name", value: "Rina's Kitchen Ltd", provenance: "buyer" }] }, ctx("u5"));
    const q = await runTool("create_quote", quoteInput, ctx("q-form"));
    const sent = await runTool("send_order_form", { quote: String(q.result.quote).split(" ")[0] }, ctx("o1"));
    expect(sent).toMatchObject({ outcome: "ok", result: { ok: true, link: expect.stringMatching(/\/f\//) } });
    const token = String(sent.result.link).split("/f/")[1];

    // P11: company and signer fields are step 2 of the order form.
    const html = renderToStaticMarkup(await BuyerFormPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({ step: "2" }) }));
    const input = (name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
    for (const name of ["company_name", "company_id", "billing_address", "invoice_email", "full_name", "signatory_role"]) {
      expect(input(name), name).not.toBe("");
      expect(input(name), name).not.toMatch(/readonly|disabled/i);
    }
    expect(input("company_name")).toContain('value="Rina&#x27;s Kitchen Ltd"');
    expect(input("company_id")).toContain('value=""');
    expect(input("full_name")).toContain("Test");

    const view = await loadForm(db, token);
    if (view?.state !== "open") throw new Error("form not open");
    expect(view.form.snapshot.fields).toEqual(expect.arrayContaining(["company_name", "company_id", "billing_address", "invoice_email", "signatory_role"]));
    // Missing company details block signing.
    const missing = await signForm(db, token, { fields: { company_name: "Rina's Kitchen Ltd" }, fullName: "", role: "", agreed: true }, {});
    expect(missing).toMatchObject({ ok: false, reason: "invalid", errors: { company_id: "required", billing_address: "required", invoice_email: "required", signatory_role: "required", full_name: "required" } });
    const fields = { company_name: "Rina's Kitchen Ltd", company_id: "512345678", billing_address: "8 Dizengoff St, Tel Aviv", delivery_address: "8 Dizengoff St, Tel Aviv", invoice_email: "billing@rina.test" };
    const ok = await signForm(db, token, { fields, fullName: "Rina Cohen", role: "Owner", agreed: true }, {});
    expect(ok.ok).toBe(true);
    const [sig] = await db.select().from(signatures).where(eq(signatures.orderFormId, view.form.id));
    expect(sig).toMatchObject({ fullName: "Rina Cohen", role: "Owner", buyerFields: fields });
  });

  it("the playbook stage label says the buyer fills these fields in the order form", () => {
    expect(tr("playbook.stage.before_order_form")).toBe("Filled in the order form");
    expect(tr("playbook.fields_hint")).toContain("the agent does not ask for them in chat");
  });
});

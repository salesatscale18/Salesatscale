import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { leadEvents, leads, markets, quoteLines, quotes, quoteVersions, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseCatalogItem } from "@/lib/catalog/rules";
import {
  addDraftRule, catalogState, discardDraft, ensureDraft, publishDraft, publishedCatalog, removeDraftItem, saveDraftItem, saveDraftSettings,
} from "@/lib/catalog/service";
import { parseLead } from "@/lib/leads/rules";
import { optOutLead, upsertLead } from "@/lib/leads/service";
import { createMarket, ensureHomeMarket } from "@/lib/markets/service";
import {
  approveQuote, cancelQuote, countAwaitingApproval, createQuote, createQuoteVersion, displayQuoteStatus, getQuote, listQuotes, previewQuote,
} from "@/lib/quotes/service";
import { catalogAutoAdd } from "@/lib/quotes/pricing";
import { createTestDb, type TestDb } from "../helpers/db";
import { republishPricing, seedCatalog, seedPricing } from "../helpers/pricing";

const now = new Date("2026-11-12T10:00:00Z");

describe("catalog and quotes (priced from the market's price list)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: string, accB: string, leadA: string, leadB: string;
  let lineageA = "";
  const human = () => ({ kind: "human" as const, userId: admin.id, actingAs: false });
  const actor = () => ({ userId: admin.id, actingAs: false });
  const item = async (acc: string, raw: Record<string, unknown>) => {
    const p = parseCatalogItem(raw, "ILS");
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const r = await saveDraftItem(db, acc, p.value);
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };
  const linesOf = async (versionId: string) => db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, versionId)).orderBy(quoteLines.sortOrder);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error();
      const id = (await createAccount(db, actor(), p.value)).account.id;
      const l = parseLead({ fullName: "Rina Cohen", phone: "0521234567", consent: "yes", consentSource: "form" }, "IL", { language: "he", now });
      if (!l.ok) throw new Error();
      const r = await upsertLead(db, id, { userId: admin.id, actingAs: false }, l.value, "manual", { now });
      if (!r.ok) throw new Error();
      return { id, lead: r.lead.id };
    };
    ({ id: accA, lead: leadA } = await mk("Alpha"));
    ({ id: accB, lead: leadB } = await mk("Beta"));
    await db.update(sellerAccounts).set({ maxDiscountBp: 700 }).where(eq(sellerAccounts.id, accA));
  });
  afterAll(async () => t.close());

  it("refuses to quote before any catalog is published", async () => {
    expect(await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "no_catalog" });
  });

  it("builds a draft, refuses to publish an empty one, then publishes v1 (items hold no price)", async () => {
    await ensureDraft(db, accA);
    expect(await publishDraft(db, actor(), accA)).toEqual({ ok: false, reason: "no_active_items" });
    await item(accA, { sku: "SNS-200", name: "Wireless fridge sensor", unit: "sensor" });
    await item(accA, { sku: "GW-10", name: "Site gateway, Wi-Fi", unit: "site" });
    await item(accA, { sku: "PLAN-M", name: "Monitoring plan", unit: "site" });
    await item(accA, { sku: "KIT-1", name: "Starter kit", unit: "item" });
    await item(accA, { sku: "SVC-INST", name: "Installation", unit: "site" });
    await item(accA, { sku: "LOCAL-ONLY", name: "Local service", unit: "hour" });
    const dup = parseCatalogItem({ sku: "GW-10", name: "x", unit: "u" }, "ILS");
    if (!dup.ok) throw new Error();
    expect(await saveDraftItem(db, accA, dup.value)).toEqual({ ok: false, reason: "sku_taken" });
    await addDraftRule(db, accA, { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true });
    // Setup fee per site, added automatically with a gateway (only where the price list sells it).
    await addDraftRule(db, accA, { kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false });
    await saveDraftSettings(db, accA, { pricesIncludeTax: true, taxRateBp: 1800 });
    expect(await publishDraft(db, actor(), accA, now)).toEqual({ ok: true, version: 1 });
    const state = await catalogState(db, accA);
    expect(state).toMatchObject({ draft: null, draftChanges: 0 });
    expect(state.published?.version).toBe(1);
    expect(state.items).toHaveLength(6);
    // The auto-add rule is a valid rule, not dropped as invalid.
    const published = (await publishedCatalog(db, accA))!;
    expect(catalogAutoAdd(published)).toEqual([{ kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false }]);
    expect(published.rules.filter((r) => r.kind !== "auto_add").map((r) => r.kind)).toEqual(["requires"]);
  });

  it("refuses with no_price_list while the home market has no live price list", async () => {
    expect(await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "no_price_list" });
    expect(await previewQuote(db, accA, leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "no_price_list" });
    const seeded = await seedPricing(db, accA, [
      { sku: "SNS-200", oneTime: 59_000, oneTimeTiers: [{ minQty: 10, priceMinor: 55_000 }] },
      { sku: "GW-10", oneTime: 66_000 },
      { sku: "PLAN-M", recurring: 9_000 },
      { sku: "KIT-1", oneTime: 100_000, recurring: 5_000, customFrom: 10 },
    ], { name: "Israel ILS", userId: admin.id });
    lineageA = seeded.lineageId;
  });

  it("quotes the canvas example from the price list and freezes market, price list and catalog", async () => {
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discountBp: 0, sites: 2, idempotencyKey: "k1" }, now);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const home = (await ensureHomeMarket(db, accA))!;
    expect(r.quote).toMatchObject({ number: 1001, status: "draft", currentVersion: 1, marketId: home.id });
    expect(r.version).toMatchObject({ oneTimeTotalMinor: 486_000, recurringTotalMinor: 18_000, recurringPeriod: "month", currency: "ILS", approvalReasons: [], marketId: home.id, pricesIncludeTax: true, taxRateBp: 1800 });
    expect(r.version.priceListId).toBeTruthy();
    expect(r.version.catalogVersionId).toBe((await publishedCatalog(db, accA))!.version.id);
    expect(r.version.validUntil.getTime() - now.getTime()).toBe(7 * 86_400_000);
    // SVC-INST is not in this price list: the auto-add rule adds nothing.
    expect((await linesOf(r.version.id)).map((l) => [l.sku, l.chargeType])).toEqual([["SNS-200", "one_time"], ["GW-10", "one_time"], ["PLAN-M", "recurring"]]);
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadA));
    expect(events.map((e) => e.type)).toContain("quote.created");
  });

  it("one item with a one-time and a recurring price gives two lines; the discount applies to one-time only", async () => {
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "KIT-1", qty: 2 }], discountBp: 500 }, now);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const lines = await linesOf(r.version.id);
    expect(lines.map((l) => [l.sku, l.chargeType, l.period, l.unitPriceMinor, l.lineTotalMinor, l.priceSource])).toEqual([
      ["KIT-1", "one_time", null, 100_000, 200_000, "list"],
      ["KIT-1", "recurring", "month", 5_000, 10_000, "list"],
    ]);
    expect(r.version).toMatchObject({ oneTimeSubtotalMinor: 200_000, oneTimeDiscountMinor: 10_000, oneTimeTotalMinor: 190_000, recurringDiscountMinor: 0, recurringTotalMinor: 10_000 });
  });

  it("is idempotent: the same key returns the same quote", async () => {
    const again = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 9 }], discountBp: 0, idempotencyKey: "k1" }, now);
    expect(again.ok && again.reused && again.quote.number).toBe(1001);
  });

  it("refuses fit problems, unknown SKUs and items not sold in the market, with reasons", async () => {
    const fit = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "SNS-200", qty: 3 }, { sku: "GW-10", qty: 1 }], discountBp: 0, sites: 2 });
    expect(fit).toEqual({ ok: false, reason: "fit", problems: ["SNS-200 needs one GW-10 per site: 2 sites, 1 quoted."] });
    const unknown = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "NOPE", qty: 1 }], discountBp: 0 });
    expect(unknown).toEqual({ ok: false, reason: "pricing", errors: [{ kind: "unknown_sku", sku: "NOPE" }] });
    // In the catalog, not in the price list: not sold here (never a price of 0).
    const notSold = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "LOCAL-ONLY", qty: 1 }], discountBp: 0 });
    expect(notSold).toEqual({ ok: false, reason: "pricing", errors: [{ kind: "not_sold", sku: "LOCAL-ONLY" }] });
  });

  it("an agent quote with a discount over the limit waits for approval; a person approves it", async () => {
    const r = await createQuote(db, accA, { kind: "agent" }, leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 1500 }, now);
    expect(r.ok && r.quote.status).toBe("awaiting_approval");
    expect(await countAwaitingApproval(db, accA)).toBe(1);
    if (!r.ok) return;
    const a = await approveQuote(db, accA, actor(), r.quote.id, {}, now);
    expect(a.ok && a.quote.status).toBe("draft");
    expect(a.ok && a.version.approvedByUserId).toBe(admin.id);
    expect(await approveQuote(db, accA, actor(), r.quote.id, {}, now)).toEqual({ ok: false, reason: "quote_closed" });
  });

  it("a person's quote over the discount limit is approved by them, with the reasons on the timeline", async () => {
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 5000 }, now);
    expect(r.ok && r.quote.status).toBe("draft");
    expect(r.ok && r.version.approvedByUserId).toBe(admin.id);
    const evs = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, leadA), eq(leadEvents.type, "quote.approved")));
    const mine = evs.find((e) => (e.data as { quoteId?: string }).quoteId === (r.ok ? r.quote.id : ""));
    expect((mine?.data as { reasons: string[] }).reasons[0]).toMatch(/50/);
  });

  it("custom pricing quantity needs approval; the seller prices one charge and the other keeps its list price", async () => {
    const r = await createQuote(db, accA, { kind: "agent" }, leadA, { lines: [{ sku: "KIT-1", qty: 12 }], discountBp: 0 }, now);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.quote.status).toBe("awaiting_approval");
    expect(r.version.approvalReasons).toEqual([{ kind: "custom_pricing_qty", sku: "KIT-1", qty: 12, from: 10 }]);
    const a = await approveQuote(db, accA, actor(), r.quote.id, { "KIT-1:recurring": 4_000 }, now);
    if (!a.ok) throw new Error(JSON.stringify(a));
    expect(a.quote).toMatchObject({ status: "draft", currentVersion: 2 });
    expect(a.version).toMatchObject({ approvedByUserId: admin.id, oneTimeTotalMinor: 12 * 100_000, recurringTotalMinor: 12 * 4_000 });
    const lines = await linesOf(a.version.id);
    expect(lines.map((l) => [l.chargeType, l.unitPriceMinor, l.priceSource])).toEqual([["one_time", 100_000, "list"], ["recurring", 4_000, "custom"]]);
    // A new version keeps the seller's price for that charge.
    const v3 = await createQuoteVersion(db, accA, human(), r.quote.id, { lines: [{ sku: "KIT-1", qty: 12 }], discountBp: 0, changeNote: "same" }, now, { "KIT-1:recurring": 4_000 });
    expect(v3.ok && v3.version.recurringTotalMinor).toBe(48_000);
  });

  it("new versions reprice; old versions never change", async () => {
    const created = (await listQuotes(db, accA)).find((r) => r.quote.number === 1001)!;
    const v2 = await createQuoteVersion(db, accA, human(), created.quote.id, { lines: [{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 1 }], discountBp: 0, changeNote: "12 sensors" }, now);
    expect(v2.ok && v2.version).toMatchObject({ version: 2, oneTimeTotalMinor: 12 * 55_000 + 66_000, changeNote: "12 sensors" });
    const full = await getQuote(db, accA, created.quote.id);
    expect(full?.versions[1].version.oneTimeTotalMinor).toBe(486_000);
  });

  it("a quote freezes its price list version: a new version changes new quotes only", async () => {
    const before = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 }, now);
    if (!before.ok) throw new Error();
    const v2 = await republishPricing(db, accA, lineageA, [{ sku: "GW-10", oneTime: 70_000 }]);
    expect(v2.version).toBe(2);
    const after = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 }, now);
    if (!after.ok) throw new Error();
    expect(after.version.oneTimeTotalMinor).toBe(70_000);
    expect(after.version.priceListId).toBe(v2.id);
    const [old] = await db.select().from(quoteVersions).where(eq(quoteVersions.id, before.version.id));
    expect(old).toMatchObject({ oneTimeTotalMinor: 66_000, priceListId: before.version.priceListId });
    expect(old.priceListId).not.toBe(v2.id);
    expect((await linesOf(before.version.id))[0].unitPriceMinor).toBe(66_000);
  });

  it("adds the setup fee per site automatically once the price list sells it", async () => {
    await republishPricing(db, accA, lineageA, [{ sku: "SVC-INST", oneTime: 25_000 }]);
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 3 }], discountBp: 0, sites: 3 }, now);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect((await linesOf(r.version.id)).map((l) => [l.sku, l.qty, l.lineTotalMinor])).toEqual([["GW-10", 3, 210_000], ["SVC-INST", 3, 75_000]]);
    expect(r.version.oneTimeTotalMinor).toBe(285_000);
    // Not removable: the buyer's removal is refused for this pricing.
    const kept = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0, removedByBuyer: ["SVC-INST"] }, now);
    expect(kept.ok && (await linesOf(kept.version.id)).map((l) => l.sku)).toEqual(["GW-10", "SVC-INST"]);
    // Approving a quote with an auto-added line keeps it and its quantity.
    const agent = await createQuote(db, accA, { kind: "agent" }, leadA, { lines: [{ sku: "GW-10", qty: 2 }], discountBp: 1000, sites: 2 }, now);
    if (!agent.ok) throw new Error();
    const a = await approveQuote(db, accA, actor(), agent.quote.id, { "GW-10:one_time": 60_000 }, now);
    if (!a.ok) throw new Error(JSON.stringify(a));
    expect((await linesOf(a.version.id)).map((l) => [l.sku, l.qty, l.priceSource])).toEqual([["GW-10", 2, "custom"], ["SVC-INST", 2, "list"]]);
  });

  it("prices a lead in its own market with that market's price list and currency", async () => {
    const uk = await createMarket(db, actor(), accA, { name: "United Kingdom", countries: ["GB"], phonePrefixes: ["+44"] });
    if (!uk.ok) throw new Error(JSON.stringify(uk.errors));
    await seedPricing(db, accA, [{ sku: "GW-10", oneTime: 15_000 }, { sku: "PLAN-M", recurring: 20_000, period: "year" }], { name: "UK GBP", currency: "GBP", pricesIncludeTax: false, taxRateBp: 2000, marketId: uk.market.id });
    await db.update(leads).set({ marketId: uk.market.id }).where(eq(leads.id, leadA));
    try {
      const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 1 }], discountBp: 0 }, now);
      if (!r.ok) throw new Error(JSON.stringify(r));
      expect(r.quote.marketId).toBe(uk.market.id);
      expect(r.version).toMatchObject({ currency: "GBP", marketId: uk.market.id, pricesIncludeTax: false, oneTimeSubtotalMinor: 30_000, oneTimeTaxMinor: 6_000, oneTimeTotalMinor: 36_000, recurringTotalMinor: 24_000, recurringPeriod: "year" });
      // Sold at home, not in the UK list.
      expect(await createQuote(db, accA, human(), leadA, { lines: [{ sku: "SNS-200", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "pricing", errors: [{ kind: "not_sold", sku: "SNS-200" }] });
    } finally {
      await db.update(leads).set({ marketId: null }).where(eq(leads.id, leadA));
    }
  });

  it("removing an item and discarding the draft leaves the published catalog untouched", async () => {
    const state = await catalogState(db, accA);
    expect(await removeDraftItem(db, accA, state.items[0].id)).toBe(true);
    expect((await catalogState(db, accA)).draftChanges).toBe(1);
    await discardDraft(db, accA);
    expect((await publishedCatalog(db, accA))?.items).toHaveLength(6);
  });

  it("cancels, and a cancelled quote can't get new versions", async () => {
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 }, now);
    if (!r.ok) throw new Error();
    expect((await cancelQuote(db, accA, actor(), r.quote.id))?.status).toBe("cancelled");
    expect(await createQuoteVersion(db, accA, human(), r.quote.id, { lines: [{ sku: "GW-10", qty: 2 }], discountBp: 0 })).toEqual({ ok: false, reason: "quote_closed" });
  });

  it("keeps accounts apart, and never prices with another account's price list", async () => {
    const [mine] = await listQuotes(db, accA);
    expect(await getQuote(db, accB, mine.quote.id)).toBeNull();
    expect(await cancelQuote(db, accB, actor(), mine.quote.id)).toBeNull();
    expect(await createQuoteVersion(db, accB, human(), mine.quote.id, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "quote_not_found" });
    expect(await createQuote(db, accB, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "lead_not_found" });
    expect(await previewQuote(db, accB, leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "lead_not_found" });
    expect(await listQuotes(db, accB)).toEqual([]);
    expect((await catalogState(db, accB)).published).toBeNull();
    // B's home market pointed at A's price list (only possible by a direct write): never used.
    await seedCatalog(db, accB, [{ sku: "GW-10", name: "Gateway" }]);
    const homeB = (await ensureHomeMarket(db, accB))!;
    await db.update(markets).set({ priceListLineageId: lineageA }).where(eq(markets.id, homeB.id));
    expect(await createQuote(db, accB, human(), leadB, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "no_price_list" });
    // A context preloaded for another account is ignored.
    const pv = await previewQuote(db, accA, leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 });
    if (!pv.ok) throw new Error();
    const foreign = await createQuote(db, accB, human(), leadB, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0, preloaded: { context: pv.context } });
    expect(foreign).toEqual({ ok: false, reason: "no_price_list" });
    expect(await db.select().from(quotes).where(eq(quotes.accountId, accB))).toEqual([]);
  });

  it("refuses quotes for opted-out leads", async () => {
    await optOutLead(db, actor(), accA, leadA);
    expect(await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "lead_opted_out" });
  });

  it("derives Expires today and Expired from the valid-until date", () => {
    const until = new Date("2026-11-19T15:00:00Z");
    expect(displayQuoteStatus("draft", until, new Date("2026-11-18T10:00:00Z"))).toBe("draft");
    expect(displayQuoteStatus("sent", until, new Date("2026-11-19T10:00:00Z"))).toBe("expires_today");
    expect(displayQuoteStatus("sent", until, new Date("2026-11-19T16:00:00Z"))).toBe("expired");
    expect(displayQuoteStatus("cancelled", until, new Date("2026-12-01T00:00:00Z"))).toBe("cancelled");
  });
});

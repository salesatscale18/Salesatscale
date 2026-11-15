import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { catalogVersions, leadEvents, quoteLines, quotes, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseCatalogItem } from "@/lib/catalog/rules";
import {
  addDraftRule, catalogState, discardDraft, ensureDraft, publishDraft, publishedCatalog, removeDraftItem, saveDraftItem, saveDraftSettings,
} from "@/lib/catalog/service";
import { parseLead } from "@/lib/leads/rules";
import { optOutLead, upsertLead } from "@/lib/leads/service";
import {
  approveQuote, cancelQuote, countAwaitingApproval, createQuote, createQuoteVersion, displayQuoteStatus, getQuote, listQuotes,
} from "@/lib/quotes/service";
import { createTestDb, type TestDb } from "../helpers/db";

const now = new Date("2026-11-12T10:00:00Z");

describe("catalog and quotes", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: string, accB: string, leadA: string, leadB: string;
  const human = () => ({ kind: "human" as const, userId: admin.id, actingAs: false });
  const actor = () => ({ userId: admin.id, actingAs: false });
  const item = async (acc: string, raw: Record<string, unknown>) => {
    const p = parseCatalogItem(raw, "ILS");
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    const r = await saveDraftItem(db, acc, p.value);
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };

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

  it("builds a draft, refuses to publish an empty one, then publishes v1", async () => {
    await ensureDraft(db, accA);
    expect(await publishDraft(db, actor(), accA)).toEqual({ ok: false, reason: "no_active_items" });
    await item(accA, { sku: "SNS-200", name: "Wireless fridge sensor", unit: "sensor", price: "590", tiers: "10: 550", customPricingFromQty: "20" });
    await item(accA, { sku: "GW-10", name: "Site gateway, Wi-Fi", unit: "site", price: "660" });
    await item(accA, { sku: "PLAN-M", name: "Monitoring plan", unit: "site", price: "90", chargeType: "recurring" });
    await item(accA, { sku: "ADD-CELL", name: "Cellular backup", unit: "gateway", price: "", chargeType: "recurring" });
    const dup = parseCatalogItem({ sku: "GW-10", name: "x", unit: "u", price: "1" }, "ILS");
    if (!dup.ok) throw new Error();
    expect(await saveDraftItem(db, accA, dup.value)).toEqual({ ok: false, reason: "sku_taken" });
    await addDraftRule(db, accA, { kind: "requires", sku: "SNS-200", oneOf: ["GW-10"], perSite: true });
    await saveDraftSettings(db, accA, { pricesIncludeTax: true, taxRateBp: 1800 });
    expect(await publishDraft(db, actor(), accA, now)).toEqual({ ok: true, version: 1 });
    const state = await catalogState(db, accA);
    expect(state).toMatchObject({ draft: null, draftChanges: 0 });
    expect(state.published?.version).toBe(1);
    expect(state.items).toHaveLength(4);
  });

  it("quotes the canvas example from the published catalog", async () => {
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "SNS-200", qty: 6 }, { sku: "GW-10", qty: 2 }, { sku: "PLAN-M", qty: 2 }], discountBp: 0, sites: 2, idempotencyKey: "k1" }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote).toMatchObject({ number: 1001, status: "draft", currentVersion: 1 });
    expect(r.version).toMatchObject({ oneTimeTotalMinor: 486_000, recurringTotalMinor: 18_000, currency: "ILS", approvalReasons: [] });
    expect(r.version.validUntil.getTime() - now.getTime()).toBe(7 * 86_400_000);
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, leadA));
    expect(events.map((e) => e.type)).toContain("quote.created");
  });

  it("is idempotent: the same key returns the same quote", async () => {
    const again = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 9 }], discountBp: 0, idempotencyKey: "k1" }, now);
    expect(again.ok && again.reused && again.quote.number).toBe(1001);
    expect(await db.select().from(quotes)).toHaveLength(1);
  });

  it("refuses fit problems, unknown SKUs and opted-out leads with reasons", async () => {
    const fit = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "SNS-200", qty: 3 }, { sku: "GW-10", qty: 1 }], discountBp: 0, sites: 2 });
    expect(fit).toEqual({ ok: false, reason: "fit", problems: ["SNS-200 needs one GW-10 per site: 2 sites, 1 quoted."] });
    const unknown = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "NOPE", qty: 1 }], discountBp: 0 });
    expect(unknown).toEqual({ ok: false, reason: "pricing", errors: [{ kind: "unknown_sku", sku: "NOPE" }] });
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

  it("a missing price needs a person's price; approving with it makes an approved v2", async () => {
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "PLAN-M", qty: 1 }, { sku: "ADD-CELL", qty: 1 }], discountBp: 0 }, now);
    expect(r.ok && r.quote.status).toBe("awaiting_approval");
    if (!r.ok) return;
    expect((await approveQuote(db, accA, actor(), r.quote.id, {}, now)).ok).toBe(false);
    const a = await approveQuote(db, accA, actor(), r.quote.id, { "ADD-CELL": 2_500 }, now);
    expect(a.ok && a.quote).toMatchObject({ status: "draft", currentVersion: 2 });
    expect(a.ok && a.version).toMatchObject({ recurringTotalMinor: 11_500, approvedByUserId: admin.id });
    const full = await getQuote(db, accA, r.quote.id);
    expect(full?.versions.map((v) => v.version.version)).toEqual([2, 1]);
    expect(full?.versions[0].lines.find((l) => l.sku === "ADD-CELL")).toMatchObject({ priceSource: "custom", unitPriceMinor: 2_500 });
  });

  it("new versions reprice from the catalog; old versions never change", async () => {
    const [first] = await listQuotes(db, accA);
    const created = (await listQuotes(db, accA)).find((r) => r.quote.number === 1001)!;
    const v2 = await createQuoteVersion(db, accA, human(), created.quote.id, { lines: [{ sku: "SNS-200", qty: 12 }, { sku: "GW-10", qty: 1 }], discountBp: 0, changeNote: "12 sensors" }, now);
    expect(v2.ok && v2.version).toMatchObject({ version: 2, oneTimeTotalMinor: 12 * 55_000 + 66_000, changeNote: "12 sensors" });
    const full = await getQuote(db, accA, created.quote.id);
    expect(full?.versions[1].version.oneTimeTotalMinor).toBe(486_000);
    expect(first).toBeTruthy();
  });

  it("quotes keep their catalog version after a new catalog is published", async () => {
    await item(accA, { sku: "GW-10", name: "Site gateway, Wi-Fi", unit: "site", price: "700" }).catch(() => null);
    const state = await catalogState(db, accA);
    const gw = state.items.find((i) => i.sku === "GW-10")!;
    const p = parseCatalogItem({ sku: "GW-10", name: "Site gateway, Wi-Fi", unit: "site", price: "700" }, "ILS");
    if (!p.ok) throw new Error();
    expect((await saveDraftItem(db, accA, p.value, gw.id)).ok).toBe(true);
    expect((await catalogState(db, accA)).draftChanges).toBe(1);
    expect(await publishDraft(db, actor(), accA, now)).toEqual({ ok: true, version: 2 });
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 }, now);
    expect(r.ok && r.version.oneTimeTotalMinor).toBe(70_000);
    const old = (await listQuotes(db, accA)).find((x) => x.quote.number === 1001)!;
    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteVersionId, old.version.id));
    expect(lines.find((l) => l.sku === "GW-10")?.unitPriceMinor).toBe(66_000);
    const versions = await db.select().from(catalogVersions).where(eq(catalogVersions.accountId, accA));
    expect(versions.map((v) => [v.version, v.status]).sort()).toEqual([[1, "archived"], [2, "published"]]);
  });

  it("removing an item and discarding the draft leaves the published catalog untouched", async () => {
    const state = await catalogState(db, accA);
    expect(await removeDraftItem(db, accA, state.items[0].id)).toBe(true);
    expect((await catalogState(db, accA)).draftChanges).toBe(1);
    await discardDraft(db, accA);
    expect((await publishedCatalog(db, accA))?.items).toHaveLength(4);
  });

  it("cancels, and a cancelled quote can't get new versions", async () => {
    const r = await createQuote(db, accA, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 }, now);
    if (!r.ok) throw new Error();
    expect((await cancelQuote(db, accA, actor(), r.quote.id))?.status).toBe("cancelled");
    expect(await createQuoteVersion(db, accA, human(), r.quote.id, { lines: [{ sku: "GW-10", qty: 2 }], discountBp: 0 })).toEqual({ ok: false, reason: "quote_closed" });
  });

  it("keeps accounts apart", async () => {
    const [mine] = await listQuotes(db, accA);
    expect(await getQuote(db, accB, mine.quote.id)).toBeNull();
    expect(await cancelQuote(db, accB, actor(), mine.quote.id)).toBeNull();
    expect(await createQuoteVersion(db, accB, human(), mine.quote.id, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "quote_not_found" });
    expect(await createQuote(db, accB, human(), leadA, { lines: [{ sku: "GW-10", qty: 1 }], discountBp: 0 })).toEqual({ ok: false, reason: "lead_not_found" });
    expect(await listQuotes(db, accB)).toEqual([]);
    expect((await catalogState(db, accB)).published).toBeNull();
    expect(leadB).toBeTruthy();
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

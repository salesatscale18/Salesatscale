import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, leadIntakeKeys, legalSections, markets, priceLists, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { saveLegalSection, saveOrderFormSettings } from "@/lib/orders/settings";
import { marketLegal, saveMarketLegalSection } from "@/lib/markets/legal";
import {
  createMarket, ensureHomeMarket, getMarket, getMarketGoLiveChecks, getMarketView, listMarkets, marketForLead, resolveMarket, setMarketPriceList,
  setMarketStatus, updateMarket,
} from "@/lib/markets/service";
import { overrideSetting, resetSetting } from "@/lib/markets/settings";
import { priceWithList } from "@/lib/pricing/engine";
import {
  copyAndAdjust, createPriceList, discardDraft, ensureDraft, entriesOf, listPriceLists, livePriceList, priceListVersion, priceListVersions, publish,
  removeEntry, saveDraftMeta, setEntry,
} from "@/lib/pricing/price-lists";
import { createTestDb, type TestDb } from "../helpers/db";

describe("markets and price lists", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let accA: string, accB: string;
  const actor = () => ({ userId: admin.id, actingAs: false });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const mk = async (name: string) => {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["he", "en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      return (await createAccount(db, actor(), p.value)).account.id;
    };
    accA = await mk("Alpha");
    accB = await mk("Beta");
  });
  afterAll(async () => t.close());

  describe("markets", () => {
    it("creates the home market lazily, once, even with concurrent calls", async () => {
      expect(await db.select().from(markets).where(eq(markets.accountId, accA))).toHaveLength(0);
      const results = await Promise.all(Array.from({ length: 5 }, () => ensureHomeMarket(db, accA)));
      const ids = new Set(results.map((m) => m!.id));
      expect(ids.size).toBe(1);
      const rows = await db.select().from(markets).where(eq(markets.accountId, accA));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "Israel", isHome: true, status: "setting_up", countries: ["IL"], phonePrefixes: ["+972"], overrides: {} });
      expect((await ensureHomeMarket(db, accA))!.id).toBe(rows[0].id);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, accA), eq(auditLog.action, "market.created")));
      expect(audits).toHaveLength(1);
      expect(await ensureHomeMarket(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("the database allows only one home market per account", async () => {
      await expect(db.insert(markets).values({ id: crypto.randomUUID(), accountId: accA, name: "Second home", isHome: true })).rejects.toThrow();
    });

    it("creates, lists and updates markets, scoped to the account", async () => {
      const r = await createMarket(db, actor(), accA, { name: "United Kingdom", countries: ["gb"], phonePrefixes: ["+44"], formCountryValues: ["GB"] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.market).toMatchObject({ isHome: false, status: "setting_up", countries: ["GB"] });
      const list = await listMarkets(db, accA);
      expect(list.map((m) => m.name)).toEqual(["Israel", "United Kingdom"]);

      const bad = await createMarket(db, actor(), accA, { name: "X", phonePrefixes: ["44"] });
      expect(bad.ok).toBe(false);
      const badOverride = await createMarket(db, actor(), accA, { name: "X", overrides: { timezone: "Nowhere/Never" } });
      expect(badOverride).toEqual({ ok: false, errors: { overrides: "Choose a time zone." } });

      const u = await updateMarket(db, actor(), accA, r.market.id, { name: "UK", phonePrefixes: ["+44", "+4420"] });
      expect(u.ok && u.market.name).toBe("UK");
      expect(u.ok && u.market.phonePrefixes).toEqual(["+44", "+4420"]);

      // Account B sees none of it, and cannot change it.
      expect((await listMarkets(db, accB)).map((m) => m.name)).toEqual(["Israel"]);
      expect(await getMarket(db, accB, r.market.id)).toBeNull();
      expect(await updateMarket(db, actor(), accB, r.market.id, { name: "Hacked" })).toEqual({ ok: false, errors: { market: "This market was not found." } });
      expect((await getMarket(db, accA, r.market.id))!.name).toBe("UK");
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.accountId, accA), eq(auditLog.action, "market.updated")));
      expect(audits.length).toBeGreaterThan(0);
    });

    it("resolves effective settings with overrides and reset", async () => {
      await saveOrderFormSettings(db, accA, { fields: ["company_name"], card: true, bankTransfer: true, bankDetails: "IBAN IL00", linkValidDays: 7, brandColor: "#0f6b5a" });
      const uk = (await listMarkets(db, accA)).find((m) => m.name === "UK")!;
      let overrides = overrideSetting(uk.overrides, "languages", ["en"]);
      overrides = overrideSetting(overrides, "timezone", "Europe/London");
      overrides = overrideSetting(overrides, "paymentMethods", { card: true, bankTransfer: false });
      expect((await updateMarket(db, actor(), accA, uk.id, { overrides })).ok).toBe(true);

      let view = (await getMarketView(db, accA, uk.id))!;
      expect(view.settings.languages).toEqual({ value: ["en"], source: "market" });
      expect(view.settings.timezone).toEqual({ value: "Europe/London", source: "market" });
      expect(view.settings.paymentMethods).toEqual({ value: { card: true, bankTransfer: false }, source: "market" });
      expect(view.settings.bankDetails).toEqual({ value: "IBAN IL00", source: "account" });
      expect(view.settings.contactHours.source).toBe("account");

      expect((await updateMarket(db, actor(), accA, uk.id, { overrides: resetSetting(view.market.overrides, "timezone") })).ok).toBe(true);
      view = (await getMarketView(db, accA, uk.id))!;
      expect(view.settings.timezone).toEqual({ value: "Asia/Jerusalem", source: "account" });
      expect(view.settings.languages.source).toBe("market");

      // The home market follows the account.
      const home = (await ensureHomeMarket(db, accA))!;
      const homeView = (await getMarketView(db, accA, home.id))!;
      expect(homeView.settings.languages).toEqual({ value: ["he", "en"], source: "account" });
    });

    it("matches leads by intake key, form country and phone prefix, else the home market", async () => {
      const [keyUk] = await db.insert(leadIntakeKeys).values({ accountId: accA, name: "UK landing page", keyPrefix: "sas_lead_", keyHash: "h-uk" }).returning();
      const [keyB] = await db.insert(leadIntakeKeys).values({ accountId: accB, name: "B key", keyPrefix: "sas_lead_", keyHash: "h-b" }).returning();
      const uk = (await listMarkets(db, accA)).find((m) => m.name === "UK")!;
      const eu = await createMarket(db, actor(), accA, { name: "Cyprus and Greece", countries: ["CY", "GR"], phonePrefixes: ["+357", "+30"], formCountryValues: ["CY", "GR"] });
      if (!eu.ok) throw new Error();

      // Another account's key cannot be attached.
      expect(await updateMarket(db, actor(), accA, uk.id, { intakeKeyIds: [keyB.id] })).toEqual({ ok: false, errors: { intakeKeyIds: "Choose intake keys from the list." } });
      expect((await updateMarket(db, actor(), accA, uk.id, { intakeKeyIds: [keyUk.id] })).ok).toBe(true);
      expect((await db.select().from(leadIntakeKeys).where(eq(leadIntakeKeys.id, keyUk.id)))[0].marketId).toBe(uk.id);

      expect(await marketForLead(db, accA, { intakeKeyId: keyUk.id, phone: "+35799123456" })).toMatchObject({ market: { id: uk.id }, reason: "intake_key" });
      expect(await marketForLead(db, accA, { formCountry: "gr", phone: "+447700900123" })).toMatchObject({ market: { id: eu.market.id }, reason: "form_country" });
      expect(await marketForLead(db, accA, { phone: "+44 20 5550 0142" })).toMatchObject({ market: { id: uk.id }, reason: "phone_prefix" });
      expect(await marketForLead(db, accA, { phone: "+972521234567" })).toMatchObject({ market: { isHome: true }, reason: "phone_prefix" });
      expect(await marketForLead(db, accA, { phone: "+33612345678" })).toMatchObject({ market: { isHome: true }, reason: "home" });
      // Account B has no UK market: the same number goes to B's home market.
      expect(await marketForLead(db, accB, { phone: "+447700900123" })).toMatchObject({ market: { isHome: true, accountId: accB }, reason: "home" });

      // Moving the key to another market takes it away from the first.
      expect((await updateMarket(db, actor(), accA, eu.market.id, { intakeKeyIds: [keyUk.id] })).ok).toBe(true);
      expect((await getMarket(db, accA, uk.id))!.intakeKeyIds).toEqual([]);
      expect((await db.select().from(leadIntakeKeys).where(eq(leadIntakeKeys.id, keyUk.id)))[0].marketId).toBe(eu.market.id);
      expect((await marketForLead(db, accA, { intakeKeyId: keyUk.id })).market.id).toBe(eu.market.id);

      // A null or foreign market id resolves to the home market.
      expect((await resolveMarket(db, accA, null)).isHome).toBe(true);
      expect((await resolveMarket(db, accB, uk.id)).accountId).toBe(accB);
    });

    it("keeps per-market legal texts apart from the account defaults", async () => {
      const uk = (await listMarkets(db, accA)).find((m) => m.name === "UK")!;
      await saveLegalSection(db, accA, admin.id, { sectionKey: "sales_terms", title: "Sales terms", language: "he", body: "IL terms" });
      await saveLegalSection(db, accA, admin.id, { sectionKey: "sales_terms", title: "Sales terms", language: "en", body: "IL terms (en)" });
      const v = await saveMarketLegalSection(db, actor(), accA, uk.id, { sectionKey: "sales_terms", title: "Sales terms (UK)", language: "en", body: "UK terms" });
      expect(v).toBe(2);
      const ukLegal = await marketLegal(db, accA, uk.id);
      expect(ukLegal.map((s) => [s.language, s.body, s.source])).toEqual([["he", "IL terms", "account"], ["en", "UK terms", "market"]]);
      const accLegal = await marketLegal(db, accA, null);
      expect(accLegal.find((s) => s.language === "en")!.body).toBe("IL terms (en)");
      const rows = await db.select().from(legalSections).where(eq(legalSections.accountId, accA));
      expect(rows.filter((r) => r.marketId === uk.id)).toHaveLength(1);
    });
  });

  describe("price lists", () => {
    let lineage: string;
    let firstLiveId: string;

    it("creates a draft, adds entries, and refuses to publish with a price missing", async () => {
      const c = await createPriceList(db, actor(), accA, { name: "Israel 2026", currency: "ILS", pricesIncludeTax: true, taxRateBp: 1_800, validFrom: "2026-12-01" });
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      lineage = c.list.lineageId;
      expect(c.list).toMatchObject({ status: "draft", version: 1, validFrom: "2026-12-01" });
      expect(await publish(db, actor(), accA, lineage)).toEqual({ ok: false, reason: "no_entries" });

      expect(await setEntry(db, actor(), accA, lineage, {
        sku: "SNS-200", oneTimeCharged: true, oneTimeMinor: 12_900, oneTimeTiers: [{ minQty: 10, priceMinor: 11_900 }],
        recurringCharged: true, recurringMinor: 300, recurringPeriod: "month",
      })).toEqual({ ok: true });
      expect(await setEntry(db, actor(), accA, lineage, { sku: "GW-10", oneTimeCharged: true, oneTimeMinor: 14_900, recurringCharged: false, recurringMinor: null })).toEqual({ ok: true });
      expect(await setEntry(db, actor(), accA, lineage, { sku: "SVC-INST", oneTimeCharged: true, oneTimeMinor: null, recurringCharged: false, recurringMinor: null })).toEqual({ ok: true });
      expect(await setEntry(db, actor(), accA, lineage, { sku: "PLAN-M", oneTimeCharged: false, oneTimeMinor: null, recurringCharged: true, recurringMinor: 1_900 })).toEqual({ ok: true });
      expect((await setEntry(db, actor(), accA, lineage, { sku: "bad sku", oneTimeCharged: false, oneTimeMinor: null, recurringCharged: false, recurringMinor: null })).ok).toBe(false);

      const blocked = await publish(db, actor(), accA, lineage);
      expect(blocked).toEqual({ ok: false, reason: "problems", problems: [{ sku: "SVC-INST", charge: "one_time", kind: "price_missing", message: "SVC-INST: the one-time price is missing." }] });
      const summary = (await listPriceLists(db, accA)).find((s) => s.lineageId === lineage)!;
      expect(summary).toMatchObject({ entryCount: 4, missingPrices: 1, live: null });
    });

    it("blocks tiers that break the tier rule", async () => {
      await setEntry(db, actor(), accA, lineage, { sku: "SVC-INST", oneTimeCharged: true, oneTimeMinor: 35_000, oneTimeTiers: [{ minQty: 5, priceMinor: 36_000 }], recurringCharged: false, recurringMinor: null });
      const r = await publish(db, actor(), accA, lineage);
      expect(r.ok === false && r.reason === "problems" && r.problems[0].kind).toBe("tiers");
    });

    it("publishes once fixed", async () => {
      await setEntry(db, actor(), accA, lineage, { sku: "SVC-INST", oneTimeCharged: true, oneTimeMinor: 35_000, recurringCharged: false, recurringMinor: null });
      const r = await publish(db, actor(), accA, lineage);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      firstLiveId = r.list.id;
      expect(r.list).toMatchObject({ status: "live", version: 1, publishedByUserId: admin.id });
      const live = (await livePriceList(db, accA, lineage))!;
      expect(live.entries.map((e) => e.sku)).toEqual(["GW-10", "PLAN-M", "SNS-200", "SVC-INST"]);
      expect(await publish(db, actor(), accA, lineage)).toEqual({ ok: false, reason: "no_draft" });
    });

    it("starts a new draft as a copy of the live version; publishing archives the old one", async () => {
      const draft = (await ensureDraft(db, actor(), accA, lineage))!;
      expect(draft).toMatchObject({ status: "draft", version: 2, copiedFromId: firstLiveId, name: "Israel 2026" });
      expect((await entriesOf(db, accA, draft.id)).map((e) => e.sku)).toEqual(["GW-10", "PLAN-M", "SNS-200", "SVC-INST"]);
      // Concurrent draft starts end with one draft.
      await discardDraft(db, actor(), accA, lineage);
      const many = await Promise.all(Array.from({ length: 4 }, () => ensureDraft(db, actor(), accA, lineage)));
      expect(new Set(many.map((d) => d!.id)).size).toBe(1);

      await setEntry(db, actor(), accA, lineage, { sku: "GW-10", oneTimeCharged: true, oneTimeMinor: 13_900, recurringCharged: false, recurringMinor: null });
      expect(await removeEntry(db, actor(), accA, lineage, "PLAN-M")).toEqual({ ok: true });
      expect((await removeEntry(db, actor(), accA, lineage, "NOPE")).ok).toBe(false);
      expect(await saveDraftMeta(db, actor(), accA, lineage, { name: "Israel 2027" })).toEqual({ ok: true });
      // The live version is untouched while the draft changes.
      const liveNow = (await livePriceList(db, accA, lineage))!;
      expect(liveNow.list.id).toBe(firstLiveId);
      expect(liveNow.entries.find((e) => e.sku === "GW-10")!.oneTimeMinor).toBe(14_900);

      const r = await publish(db, actor(), accA, lineage);
      expect(r.ok && r.list.version).toBe(2);
      const versions = await priceListVersions(db, accA, lineage);
      expect(versions.map((v) => [v.version, v.status, v.name])).toEqual([[2, "live", "Israel 2027"], [1, "archived", "Israel 2026"]]);
      // The archived version still loads for quotes that froze it.
      const old = (await priceListVersion(db, accA, firstLiveId))!;
      expect(old.entries.find((e) => e.sku === "GW-10")!.oneTimeMinor).toBe(14_900);
      expect(old.entries.some((e) => e.sku === "PLAN-M")).toBe(true);
      expect((await livePriceList(db, accA, lineage))!.entries.some((e) => e.sku === "PLAN-M")).toBe(false);
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.accountId, accA), eq(auditLog.action, "price_list.published")));
      expect(audit).toHaveLength(2);
    });

    it("copies and adjusts into a new price list", async () => {
      const live = (await livePriceList(db, accA, lineage))!;
      const r = await copyAndAdjust(db, actor(), accA, live.list.id, { name: "UK 2026", currency: "GBP", factor: "0.215", rounding: "whole", pricesIncludeTax: false, taxRateBp: 2_000 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.list).toMatchObject({ status: "draft", version: 1, currency: "GBP", pricesIncludeTax: false, taxRateBp: 2_000, copiedFromId: live.list.id });
      expect(r.list.lineageId).not.toBe(lineage);
      const entries = await entriesOf(db, accA, r.list.id);
      const sns = entries.find((e) => e.sku === "SNS-200")!;
      // 129.00 × 0.215 = 27.735 → 28.00; tier 119.00 → 25.585 → 26.00; 3.00 → 0.645 → 1.00
      expect([sns.oneTimeMinor, sns.oneTimeTiers, sns.recurringMinor, sns.recurringPeriod]).toEqual([2_800, [{ minQty: 10, priceMinor: 2_600 }], 100, "month"]);
      expect(entries.find((e) => e.sku === "SVC-INST")!.oneTimeMinor).toBe(7_500);
      expect(r.problems).toEqual([]);

      const pct = await copyAndAdjust(db, actor(), accA, live.list.id, { name: "Israel promo", percent: "-10", rounding: "minor" });
      expect(pct.ok).toBe(true);
      if (!pct.ok) return;
      expect(pct.list.currency).toBe("ILS");
      expect((await entriesOf(db, accA, pct.list.id)).find((e) => e.sku === "GW-10")!.oneTimeMinor).toBe(12_510);

      expect((await copyAndAdjust(db, actor(), accA, live.list.id, { name: "Bad", factor: "0", rounding: "minor" })).ok).toBe(false);
      // Rounding that flattens tiers is reported, and blocks publishing.
      const flat = await copyAndAdjust(db, actor(), accA, live.list.id, { name: "Flat", factor: "0.001", rounding: "whole_up" });
      expect(flat.ok && flat.problems.some((p) => p.kind === "tiers")).toBe(true);
      if (flat.ok) expect((await publish(db, actor(), accA, flat.list.lineageId)).ok).toBe(false);
    });

    it("keeps price lists apart between accounts", async () => {
      const live = (await livePriceList(db, accA, lineage))!;
      expect(await livePriceList(db, accB, lineage)).toBeNull();
      expect(await priceListVersion(db, accB, live.list.id)).toBeNull();
      expect(await ensureDraft(db, actor(), accB, lineage)).toBeNull();
      expect((await setEntry(db, actor(), accB, lineage, { sku: "X", oneTimeCharged: false, oneTimeMinor: null, recurringCharged: false, recurringMinor: null })).ok).toBe(false);
      expect((await publish(db, actor(), accB, lineage)).ok).toBe(false);
      expect((await copyAndAdjust(db, actor(), accB, live.list.id, { name: "Stolen", rounding: "minor" })).ok).toBe(false);
      expect(await listPriceLists(db, accB)).toEqual([]);
      expect(await db.select().from(priceLists).where(eq(priceLists.accountId, accB))).toEqual([]);
    });
  });

  describe("markets with price lists", () => {
    it("assigns a price list and runs the go-live checks", async () => {
      const uk = (await listMarkets(db, accA)).find((m) => m.name === "UK")!;
      let checks = (await getMarketGoLiveChecks(db, accA, uk.id))!;
      expect(checks.map((c) => [c.key, c.ok])).toEqual([["where", true], ["price_list", false], ["legal_texts", true], ["payment_methods", true], ["whatsapp", false]]);
      expect(await setMarketStatus(db, actor(), accA, uk.id, "live")).toMatchObject({ ok: false, reason: "checks_failed" });

      const ukList = (await listPriceLists(db, accA)).find((s) => s.shown.name === "UK 2026")!;
      // Another account's price list cannot be assigned.
      expect((await setMarketPriceList(db, actor(), accB, (await ensureHomeMarket(db, accB))!.id, ukList.lineageId)).ok).toBe(false);
      expect((await setMarketPriceList(db, actor(), accA, uk.id, ukList.lineageId)).ok).toBe(true);
      checks = (await getMarketGoLiveChecks(db, accA, uk.id))!;
      expect(checks.find((c) => c.key === "price_list")).toMatchObject({ ok: false, detail: "Publish the price list." });

      expect((await publish(db, actor(), accA, ukList.lineageId)).ok).toBe(true);
      const view = (await getMarketView(db, accA, uk.id))!;
      expect(view.settings.currency).toEqual({ value: "GBP", source: "market" });
      expect(view.checks.find((c) => c.key === "price_list")!.ok).toBe(true);
      expect((await listPriceLists(db, accA)).find((s) => s.lineageId === ukList.lineageId)!.usedBy.map((m) => m.name)).toEqual(["UK"]);

      // Selling in Hebrew too needs a Hebrew legal text in this market: the account's applies.
      expect((await updateMarket(db, actor(), accA, uk.id, { overrides: overrideSetting(view.market.overrides, "languages", ["en", "he"]) })).ok).toBe(true);
      expect((await getMarketGoLiveChecks(db, accA, uk.id))!.find((c) => c.key === "legal_texts")!.ok).toBe(true);

      const live = await setMarketStatus(db, actor(), accA, uk.id, "live");
      expect(live.ok && live.market.status).toBe("live");
      expect((await setMarketStatus(db, actor(), accA, uk.id, "paused")).ok).toBe(true);
      expect(await setMarketStatus(db, actor(), accB, uk.id, "live")).toEqual({ ok: false, reason: "not_found" });
    });

    it("prices a quote from the published list with the engine", async () => {
      const uk = (await listMarkets(db, accA)).find((m) => m.name === "UK")!;
      const live = (await livePriceList(db, accA, uk.priceListLineageId!))!;
      const items = [
        { sku: "SNS-200", name: "Wireless sensor", unit: "device", kind: "product" as const, active: true },
        { sku: "GW-10", name: "Site gateway", unit: "device", kind: "product" as const, active: true },
        { sku: "SVC-INST", name: "Installation", unit: "site", kind: "service" as const, active: true },
        { sku: "SNS-210", name: "Freezer probe", unit: "device", kind: "product" as const, active: true },
      ];
      const r = priceWithList({
        items,
        entries: live.entries,
        priceList: live.list,
        lines: [{ sku: "SNS-200", qty: 10 }, { sku: "GW-10", qty: 2 }],
        sites: 2,
        discountBp: 500,
        maxDiscountBp: 1_000,
        autoAdd: [{ kind: "auto_add", sku: "SVC-INST", whenAnyOf: ["GW-10"], qty: "sites", removable: false }],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.currency).toBe("GBP");
      // GW-10 13,900 ILS ×0.215 → 29.885 → 30.00; SVC-INST 75.00; SNS-200 tier 26.00 ×10; recurring 1.00 ×10
      expect(r.lines.map((l) => [l.sku, l.charge, l.qty, l.unitPriceMinor])).toEqual([
        ["SNS-200", "one_time", 10, 2_600],
        ["SNS-200", "recurring", 10, 100],
        ["GW-10", "one_time", 2, 3_000],
        ["SVC-INST", "one_time", 2, 7_500],
      ]);
      const oneTime = 26_000 + 6_000 + 15_000;
      expect(r.oneTime).toEqual({ subtotalMinor: oneTime, discountMinor: 2_350, taxMinor: 8_930, totalMinor: oneTime - 2_350 + 8_930 });
      expect(r.recurring).toEqual({ subtotalMinor: 1_000, discountMinor: 0, taxMinor: 200, totalMinor: 1_200 });
      expect(priceWithList({ items, entries: live.entries, priceList: live.list, lines: [{ sku: "SNS-210", qty: 1 }], discountBp: 0, maxDiscountBp: 0 })).toEqual({ ok: false, errors: [{ kind: "not_sold", sku: "SNS-210" }] });
    });

    it("leaves existing accounts and data loading as before", async () => {
      const [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accB));
      expect(acc.market).toBe("IL");
      expect((await listMarkets(db, accB))).toHaveLength(1);
    });
  });
});

/**
 * Lane M (wave 2): markets screen actions, account creation with a home
 * market, lead intake with markets, order-form legal defaults. Server actions
 * run against PGlite with the caller's access mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, leadEvents, leadIntakeKeys, leads, markets, priceLists, sellerAccounts, users, type SellerAccount, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount, homeMarketName } from "@/lib/accounts/service";
import { parseLead } from "@/lib/leads/rules";
import { createIntakeKey, importLeadsCsv, listLeads, getLead, setIntakeKeyMarket, upsertLead } from "@/lib/leads/service";
import { createMarket, ensureHomeMarket, getMarket, getMarketView, listMarkets, updateMarket } from "@/lib/markets/service";
import { saveMarketLegalSection } from "@/lib/markets/legal";
import { overrideSetting } from "@/lib/markets/settings";
import { createPriceList, listPriceLists, publish, setEntry } from "@/lib/pricing/price-lists";
import { currentLegal, currentLegalKeys, saveLegalSection } from "@/lib/orders/settings";
import { createTestDb, type TestDb } from "../helpers/db";

const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown, admin: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  requireSuperAdmin: async () => holder.admin,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const marketActions = await import("@/app/app/[account]/markets/actions");
const leadActions = await import("@/app/app/[account]/leads/actions");
const settingsActions = await import("@/app/app/[account]/settings/actions");
const orderFormActions = await import("@/app/app/[account]/setup/order-form/actions");
const sadminActions = await import("@/app/sadmin/accounts/actions");
const { POST } = await import("@/app/api/leads/[account]/route");

const form = (v: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) for (const x of Array.isArray(val) ? val : [val]) f.append(k, x);
  return f;
};

/** Runs a redirecting server action and returns the URL it redirected to. */
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return url;
    throw e;
  }
  throw new Error("expected a redirect");
}

const consent = { source: "Contact form", text: "I agree to be contacted on WhatsApp", at: "2026-11-09T09:12:00Z" };
function webhook(slug: string, key: string, body: Record<string, unknown>) {
  return POST(
    new Request(`http://test/api/leads/${slug}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ consent, ...body }) }),
    { params: Promise.resolve({ account: slug }) },
  );
}

describe("markets, accounts and leads (lane M)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;
  let alpha: SellerAccount, beta: SellerAccount;
  let ukId = "";
  const actor = () => ({ userId: admin.id, actingAs: false });
  const as = (account: SellerAccount) => { holder.access = { account, user: admin, actingAs: false, role: "seller_admin" }; };

  beforeAll(async () => {
    process.env.APP_URL = "https://app.test";
    t = await createTestDb();
    db = t.db;
    holder.db = db;
    [admin] = await db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    holder.admin = admin;
  });
  afterAll(async () => t.close());

  describe("account creation", () => {
    it("parses the home market countries and keeps the old validation", () => {
      const base = { tradeName: "X", market: "IL", languages: ["he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" };
      const ok = parseCreateAccount({ ...base, countries: "cy, GR il" });
      expect(ok.ok && ok.value.countries).toEqual(["IL", "CY", "GR"]);
      const none = parseCreateAccount(base);
      expect(none.ok && none.value.countries).toEqual(["IL"]);
      const bad = parseCreateAccount({ ...base, countries: "Cyprus" });
      expect(bad.ok ? null : bad.errors.countries).toBe("Use two-letter country codes, for example CY, GR.");
      expect(homeMarketName(["CY", "GR"])).toBe("Cyprus and Greece");
      expect(homeMarketName(["DE", "AT", "CH"])).toBe("Germany, Austria and Switzerland");
    });

    it("the admin create form makes the home market and an empty first price list", async () => {
      const r = await sadminActions.createAccountAction({ status: "idle" }, form({
        tradeName: "Alpha", market: "IL", countries: "", languages: ["he", "en"], timezone: "Asia/Jerusalem", currency: "ILS",
        plan: "pilot", monthlySpendCap: "1000", ownerName: "Owner", ownerEmail: "owner@alpha.test",
      }));
      expect(r.status).toBe("created");
      if (r.status !== "created") return;
      [alpha] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, r.accountId));
      const ms = await db.select().from(markets).where(eq(markets.accountId, alpha.id));
      expect(ms).toHaveLength(1);
      expect(ms[0]).toMatchObject({ name: "Israel", isHome: true, countries: ["IL"], phonePrefixes: ["+972"], status: "setting_up" });
      const lists = await listPriceLists(db, alpha.id);
      expect(lists).toHaveLength(1);
      expect(lists[0].shown).toMatchObject({ name: "Israel prices", currency: "ILS", status: "draft", version: 1 });
      expect(lists[0].usedBy).toEqual([{ id: ms[0].id, name: "Israel" }]);
      expect(ms[0].priceListLineageId).toBe(lists[0].lineageId);
      const actions = (await db.select().from(auditLog).where(eq(auditLog.accountId, alpha.id))).map((a) => a.action).sort();
      expect(actions).toEqual(["account.created", "invite.created", "market.created", "market.price_list_set", "price_list.created"]);
    });

    it("a home market with several countries gets their prefixes and form values; old accounts get one lazily", async () => {
      const p = parseCreateAccount({ tradeName: "Beta", market: "IL", countries: "CY GR", languages: ["he"], timezone: "Asia/Jerusalem", currency: "EUR", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@beta.test" });
      if (!p.ok) throw new Error(JSON.stringify(p.errors));
      const r = await createAccount(db, actor(), p.value, new Date(), { homeMarket: true });
      beta = r.account;
      expect(r.homeMarket).toMatchObject({ name: "Israel, Cyprus and Greece", countries: ["IL", "CY", "GR"], phonePrefixes: ["+972", "+357", "+30"], formCountryValues: ["IL", "CY", "GR"] });
      const [list] = await db.select().from(priceLists).where(eq(priceLists.accountId, beta.id));
      expect(list).toMatchObject({ name: "Israel, Cyprus and Greece prices", currency: "EUR", lineageId: r.priceListLineageId });

      // Without the option (older callers and tests) nothing is created up front.
      const q = parseCreateAccount({ tradeName: "Gamma", market: "GB", languages: ["en"], timezone: "Europe/London", currency: "GBP", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@g.test" });
      if (!q.ok) throw new Error();
      const g = await createAccount(db, actor(), q.value);
      expect(g.homeMarket).toBeNull();
      expect(await db.select().from(markets).where(eq(markets.accountId, g.account.id))).toHaveLength(0);
    });

    it("keeps form errors on the create form", async () => {
      const r = await sadminActions.createAccountAction({ status: "idle" }, form({ tradeName: "", market: "XX", countries: "nope" }));
      expect(r.status).toBe("error");
      if (r.status === "error") expect(Object.keys(r.errors)).toEqual(expect.arrayContaining(["tradeName", "market", "countries"]));
    });
  });

  describe("markets screen actions", () => {
    it("adds a market, filling phone prefixes and form values from its countries", async () => {
      as(alpha);
      const url = await redirectOf(marketActions.addMarketAction(form({ slug: "alpha", name: "United Kingdom", countries: "gb", phonePrefixes: "", formCountryValues: "" })));
      ukId = new URL(url, "http://x").searchParams.get("m")!;
      expect(url).toContain("saved=added");
      expect(await getMarket(db, alpha.id, ukId)).toMatchObject({ name: "United Kingdom", status: "setting_up", countries: ["GB"], phonePrefixes: ["+44"], formCountryValues: ["GB", "United Kingdom"], isHome: false });
      const bad = await redirectOf(marketActions.addMarketAction(form({ slug: "alpha", name: "", countries: "" })));
      expect(bad).toContain("add=1&error=");
    });

    it("overrides a setting, refuses an invalid value, and resets it", async () => {
      as(alpha);
      expect(await redirectOf(marketActions.overrideSettingAction(form({ slug: "alpha", marketId: ukId, key: "languages", languages: "en" })))).toContain("saved=languages");
      let view = (await getMarketView(db, alpha.id, ukId))!;
      expect(view.settings.languages).toEqual({ value: ["en"], source: "market" });

      const bad = await redirectOf(marketActions.overrideSettingAction(form({ slug: "alpha", marketId: ukId, key: "timezone", timezone: "Mars/Olympus" })));
      expect(decodeURIComponent(bad)).toContain("error=Choose a time zone.");
      const none = await redirectOf(marketActions.overrideSettingAction(form({ slug: "alpha", marketId: ukId, key: "paymentMethods" })));
      expect(decodeURIComponent(none)).toContain("Turn on card or bank transfer.");

      await redirectOf(marketActions.overrideSettingAction(form({ slug: "alpha", marketId: ukId, key: "timezone", timezone: "Europe/London" })));
      await redirectOf(marketActions.overrideSettingAction(form({ slug: "alpha", marketId: ukId, key: "holidays", holidays: "2026-12-25\n2026-12-26, 2026-12-25" })));
      view = (await getMarketView(db, alpha.id, ukId))!;
      expect(view.settings.timezone).toEqual({ value: "Europe/London", source: "market" });
      expect(view.settings.holidays.value).toEqual(["2026-12-25", "2026-12-26"]);

      expect(await redirectOf(marketActions.resetSettingAction(form({ slug: "alpha", marketId: ukId, key: "timezone" })))).toContain("reset=timezone");
      view = (await getMarketView(db, alpha.id, ukId))!;
      expect(view.settings.timezone).toEqual({ value: "Asia/Jerusalem", source: "account" });
      expect(view.settings.languages.source).toBe("market");
      // An unknown key changes nothing.
      expect(await redirectOf(marketActions.resetSettingAction(form({ slug: "alpha", marketId: ukId, key: "currency" })))).toBe(`/app/alpha/markets?m=${ukId}`);
    });

    it("assigns a price list of the account only", async () => {
      as(alpha);
      const own = await createPriceList(db, actor(), alpha.id, { name: "UK 2026", currency: "GBP", pricesIncludeTax: false, taxRateBp: 2_000 });
      const foreign = await createPriceList(db, actor(), beta.id, { name: "Beta list", currency: "EUR", pricesIncludeTax: false, taxRateBp: 0 });
      if (!own.ok || !foreign.ok) throw new Error();
      expect(await redirectOf(marketActions.setPriceListAction(form({ slug: "alpha", marketId: ukId, lineageId: own.list.lineageId })))).toContain("saved=price_list");
      expect((await getMarket(db, alpha.id, ukId))!.priceListLineageId).toBe(own.list.lineageId);
      const refused = await redirectOf(marketActions.setPriceListAction(form({ slug: "alpha", marketId: ukId, lineageId: foreign.list.lineageId })));
      expect(decodeURIComponent(refused)).toContain("Choose a price list from the list.");
      expect((await getMarket(db, alpha.id, ukId))!.priceListLineageId).toBe(own.list.lineageId);
      expect(await redirectOf(marketActions.setPriceListAction(form({ slug: "alpha", marketId: ukId, lineageId: "not-a-uuid" })))).toContain("error=");
    });

    it("refuses Live until the go-live checks pass, then allows it", async () => {
      as(alpha);
      expect(await redirectOf(marketActions.setMarketStatusAction(form({ slug: "alpha", marketId: ukId, status: "live" })))).toContain("status_error=checks_failed");
      expect((await getMarket(db, alpha.id, ukId))!.status).toBe("setting_up");
      // Fix the checks: publish the price list, add the English legal text.
      const lineage = (await getMarket(db, alpha.id, ukId))!.priceListLineageId!;
      await setEntry(db, actor(), alpha.id, lineage, { sku: "ITEM-1", oneTimeCharged: true, oneTimeMinor: 1_000, recurringCharged: false, recurringMinor: null });
      expect((await publish(db, actor(), alpha.id, lineage)).ok).toBe(true);
      await saveMarketLegalSection(db, actor(), alpha.id, ukId, { sectionKey: "sales_terms", title: "Sales terms (UK)", language: "en", body: "UK terms" });
      // Bank transfer is on by default but has no bank details: card only in this market.
      const failing = (await getMarketView(db, alpha.id, ukId))!.checks.filter((c) => !c.ok && c.blocking).map((c) => c.key);
      expect(failing).toEqual(["payment_methods"]);
      await redirectOf(marketActions.overrideSettingAction(form({ slug: "alpha", marketId: ukId, key: "paymentMethods", card: "on" })));
      expect(await redirectOf(marketActions.setMarketStatusAction(form({ slug: "alpha", marketId: ukId, status: "live" })))).toContain("saved=status_live");
      expect(await redirectOf(marketActions.setMarketStatusAction(form({ slug: "alpha", marketId: ukId, status: "paused" })))).toContain("saved=status_paused");
      expect(await redirectOf(marketActions.setMarketStatusAction(form({ slug: "alpha", marketId: ukId, status: "setting_up" })))).toBe(`/app/alpha/markets?m=${ukId}`);
      expect((await getMarket(db, alpha.id, ukId))!.status).toBe("paused");
    });

    it("never touches another account's market", async () => {
      as(beta);
      const url = await redirectOf(marketActions.overrideSettingAction(form({ slug: "beta", marketId: ukId, key: "languages", languages: "he" })));
      expect(decodeURIComponent(url)).toBe("/app/beta/markets?error=This market was not found.");
      expect(await redirectOf(marketActions.updateWhereAction(form({ slug: "beta", marketId: ukId, name: "Hijack" })))).toContain("error=");
      expect((await getMarket(db, alpha.id, ukId))!.name).toBe("United Kingdom");
      expect((await getMarket(db, alpha.id, ukId))!.overrides.languages).toEqual(["en"]);
    });
  });

  describe("lead intake", () => {
    let keyUk = "", keyPlain = "", keyUkId = "";

    it("links intake keys to markets from Settings, within the account", async () => {
      as(alpha);
      const a = await createIntakeKey(db, actor(), alpha.id, "UK landing page");
      const b = await createIntakeKey(db, actor(), alpha.id, "Website");
      const foreign = await createIntakeKey(db, actor(), beta.id, "Beta site");
      keyUk = a.key; keyUkId = a.row.id; keyPlain = b.key;
      expect(await redirectOf(settingsActions.setIntakeKeyMarketAction(form({ slug: "alpha", keyId: a.row.id, marketId: ukId })))).toContain("key_market=1");
      expect((await db.select().from(leadIntakeKeys).where(eq(leadIntakeKeys.id, a.row.id)))[0].marketId).toBe(ukId);
      expect((await getMarket(db, alpha.id, ukId))!.intakeKeyIds).toEqual([a.row.id]);
      // Another account's key or market is refused.
      expect(await redirectOf(settingsActions.setIntakeKeyMarketAction(form({ slug: "alpha", keyId: foreign.row.id, marketId: ukId })))).toContain("key_market_error=1");
      as(beta);
      expect(await redirectOf(settingsActions.setIntakeKeyMarketAction(form({ slug: "beta", keyId: foreign.row.id, marketId: ukId })))).toContain("key_market_error=1");
      // Unlink and link again.
      expect(await setIntakeKeyMarket(db, actor(), alpha.id, a.row.id, null)).toBe(true);
      expect((await db.select().from(leadIntakeKeys).where(eq(leadIntakeKeys.id, a.row.id)))[0].marketId).toBeNull();
      expect((await getMarket(db, alpha.id, ukId))!.intakeKeyIds).toEqual([]);
      expect(await setIntakeKeyMarket(db, actor(), alpha.id, a.row.id, ukId)).toBe(true);
    });

    it("webhook: the key's market wins, then the country field, then the phone; language comes from the market", async () => {
      const byKey = await webhook("alpha", keyUk, { full_name: "Key Lead", phone: "+972525550101", country: "IL" });
      expect(byKey.status).toBe(201);
      const k = (await db.select().from(leads).where(eq(leads.id, (await byKey.json()).id)))[0];
      expect(k).toMatchObject({ marketId: ukId, language: "en" });

      const byCountry = await webhook("alpha", keyPlain, { full_name: "Country Lead", phone: "+972525550102", country: "United Kingdom" });
      expect((await db.select().from(leads).where(eq(leads.id, (await byCountry.json()).id)))[0].marketId).toBe(ukId);

      const byPhone = await webhook("alpha", keyPlain, { full_name: "Phone Lead", phone: "+44 20 5550 0142" });
      expect((await db.select().from(leads).where(eq(leads.id, (await byPhone.json()).id)))[0]).toMatchObject({ marketId: ukId, language: "en" });

      const home = (await ensureHomeMarket(db, alpha.id))!;
      const local = await webhook("alpha", keyPlain, { full_name: "Home Lead", phone: "052-555-0103" });
      expect((await db.select().from(leads).where(eq(leads.id, (await local.json()).id)))[0]).toMatchObject({ marketId: home.id, language: "he" });

      // A language sent with the lead is kept.
      const withLang = await webhook("alpha", keyPlain, { full_name: "Hebrew UK", phone: "+447700900104", language: "he" });
      expect((await db.select().from(leads).where(eq(leads.id, (await withLang.json()).id)))[0]).toMatchObject({ marketId: ukId, language: "he" });
    });

    it("an existing lead keeps its market; an empty market is filled", async () => {
      const home = (await ensureHomeMarket(db, alpha.id))!;
      // Same phone, now with a key and country that point elsewhere: market unchanged.
      const again = await webhook("alpha", keyUk, { full_name: "Home Lead", phone: "052-555-0103", country: "GB" });
      expect(again.status).toBe(200);
      const [row] = await db.select().from(leads).where(and(eq(leads.accountId, alpha.id), eq(leads.phone, "+972525550103")));
      expect(row.marketId).toBe(home.id);

      // A lead from before markets (no market) gets one on its next intake.
      await db.update(leads).set({ marketId: null }).where(eq(leads.id, row.id));
      await webhook("alpha", keyUk, { full_name: "Home Lead", phone: "052-555-0103" });
      expect((await db.select().from(leads).where(eq(leads.id, row.id)))[0].marketId).toBe(ukId);
      expect(keyUkId).toBeTruthy();
    });

    it("manual add: an optional market, else matched from the phone", async () => {
      as(alpha);
      const base = { slug: "alpha", fullName: "Manual", consent: "yes", consentSource: "Met at expo", after: "agent" };
      const home = (await ensureHomeMarket(db, alpha.id))!;
      const auto = await redirectOf(leadActions.addLeadAction({ status: "idle" }, form({ ...base, phone: "+447700900201", language: "", marketId: "" })));
      const autoId = auto.split("/leads/")[1];
      expect((await db.select().from(leads).where(eq(leads.id, autoId)))[0]).toMatchObject({ marketId: ukId, language: "en" });

      const chosen = await redirectOf(leadActions.addLeadAction({ status: "idle" }, form({ ...base, fullName: "Chosen", phone: "+447700900202", language: "", marketId: home.id })));
      expect((await db.select().from(leads).where(eq(leads.id, chosen.split("/leads/")[1])))[0]).toMatchObject({ marketId: home.id, language: "he" });

      const betaHome = (await ensureHomeMarket(db, beta.id))!;
      const refused = await leadActions.addLeadAction({ status: "idle" }, form({ ...base, fullName: "Foreign", phone: "+447700900203", language: "en", marketId: betaHome.id }));
      expect(refused).toMatchObject({ status: "error", formError: "market" });
      expect(await db.select().from(leads).where(eq(leads.phone, "+447700900203"))).toHaveLength(0);
    });

    it("CSV import without a language column: each lead gets its market's language", async () => {
      const csv = ["full_name,phone", "Uk NoLang,+447700900311", "Il NoLang,0525550312"].join("\n");
      const r = await importLeadsCsv(db, alpha, actor(), csv, { fileConsent: { source: "Imported from x.csv" } });
      expect(r).toMatchObject({ created: 2, rejected: [], missingColumns: [] });
      const by = async (phone: string) => (await db.select().from(leads).where(and(eq(leads.accountId, alpha.id), eq(leads.phone, phone))))[0];
      expect(await by("+447700900311")).toMatchObject({ marketId: ukId, language: "en" });
      expect(await by("+972525550312")).toMatchObject({ language: "he" });
    });

    it("CSV import: an optional country column, else the phone", async () => {
      const home = (await ensureHomeMarket(db, alpha.id))!;
      const csv = [
        "full_name,phone,language,country,consent_source,consent_text",
        "Csv Country,+972525550301,,GB,Expo,I agree",
        "Csv Phone,+447700900302,,,Expo,I agree",
        "Csv Home,0525550303,,,Expo,I agree",
        "Home Lead,052-555-0103,,IL,Expo,I agree",
      ].join("\n");
      const r = await importLeadsCsv(db, alpha, actor(), csv);
      expect(r).toMatchObject({ created: 3, updated: 1, rejected: [] });
      const by = async (phone: string) => (await db.select().from(leads).where(and(eq(leads.accountId, alpha.id), eq(leads.phone, phone))))[0];
      expect(await by("+972525550301")).toMatchObject({ marketId: ukId, language: "en" });
      expect(await by("+447700900302")).toMatchObject({ marketId: ukId, language: "en" });
      expect(await by("+972525550303")).toMatchObject({ marketId: home.id, language: "he" });
      // Existing lead (in the UK market) stays there.
      expect((await by("+972525550103")).marketId).toBe(ukId);
    });

    it("the lead card changes a lead's market, audited, within the account only", async () => {
      as(alpha);
      const home = (await ensureHomeMarket(db, alpha.id))!;
      const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, alpha.id), eq(leads.phone, "+972525550301")));
      expect(await redirectOf(leadActions.setLeadMarketAction(form({ slug: "alpha", leadId: lead.id, marketId: home.id })))).toBe(`/app/alpha/leads/${lead.id}?market=1`);
      expect((await getLead(db, alpha.id, lead.id))!.market).toEqual({ id: home.id, name: "Israel" });
      const [ev] = await db.select().from(leadEvents).where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, "lead.market_changed")));
      expect(ev.data).toEqual({ from: "United Kingdom", to: "Israel" });
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.targetId, lead.id), eq(auditLog.action, "lead.market_changed")));
      expect(audits).toHaveLength(1);

      const betaHome = (await ensureHomeMarket(db, beta.id))!;
      expect(await redirectOf(leadActions.setLeadMarketAction(form({ slug: "alpha", leadId: lead.id, marketId: betaHome.id })))).toContain("market_error=1");
      as(beta);
      expect(await redirectOf(leadActions.setLeadMarketAction(form({ slug: "beta", leadId: lead.id, marketId: betaHome.id })))).toContain("market_error=1");
      expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].marketId).toBe(home.id);
    });

    it("the leads list shows each lead's market", async () => {
      const { rows } = await listLeads(db, alpha.id, { limit: 500 });
      const names = Object.fromEntries(rows.map((r) => [r.lead.fullName, r.market?.name ?? null]));
      expect(names["Key Lead"]).toBe("United Kingdom");
      expect(names["Csv Home"]).toBe("Israel");
      expect((await listLeads(db, beta.id)).rows).toHaveLength(0);
    });

    it("a lead added directly with upsertLead and no hints goes to the home market", async () => {
      const p = parseLead({ fullName: "Direct", phone: "+33612345678", consent: "yes", consentSource: "x" }, "IL", { language: "he", now: new Date() });
      if (!p.ok) throw new Error();
      const r = await upsertLead(db, beta.id, { userId: null, actingAs: false }, p.value, "webhook");
      expect(r.ok && r.lead.marketId).toBe((await ensureHomeMarket(db, beta.id))!.id);
    });
  });

  describe("order-form legal texts", () => {
    it("currentLegal and saveLegalSection handle only the account defaults", async () => {
      const uk = ukId;
      const v1 = await saveLegalSection(db, alpha.id, admin.id, { sectionKey: "privacy", title: "Privacy", language: "en", body: "Account privacy" });
      const v2 = await saveMarketLegalSection(db, actor(), alpha.id, uk, { sectionKey: "privacy", title: "Privacy (UK)", language: "en", body: "UK privacy" });
      expect([v1, v2]).toEqual([1, 2]);
      // A new default version continues the shared numbering and stays a default.
      const v3 = await saveLegalSection(db, alpha.id, admin.id, { sectionKey: "privacy", title: "Privacy", language: "en", body: "Account privacy v3" });
      expect(v3).toBe(3);
      const defaults = await currentLegal(db, alpha.id);
      expect(defaults.every((s) => s.marketId === null)).toBe(true);
      expect(defaults.find((s) => s.sectionKey === "privacy")!.body).toBe("Account privacy v3");
      // The UK-only "sales_terms" text (saved earlier) is not an account default.
      expect(defaults.some((s) => s.sectionKey === "sales_terms")).toBe(false);
      expect((await currentLegalKeys(db, alpha.id)).some((k) => k.sectionKey === "sales_terms")).toBe(false);
    });

    it("the market override action saves the market's own text, within the account", async () => {
      as(alpha);
      const url = await redirectOf(orderFormActions.saveMarketSectionAction(form({ slug: "alpha", marketId: ukId, sectionKey: "privacy", language: "en", title: "Privacy (UK)", body: "UK privacy v2" })));
      expect(url).toBe(`/app/alpha/setup/order-form?market=${ukId}&mlegal=4`);
      // Hebrew is not a selling language of the UK market.
      expect(await redirectOf(orderFormActions.saveMarketSectionAction(form({ slug: "alpha", marketId: ukId, sectionKey: "privacy", language: "he", title: "x", body: "y" })))).toContain("error=");
      as(beta);
      expect(decodeURIComponent(await redirectOf(orderFormActions.saveMarketSectionAction(form({ slug: "beta", marketId: ukId, sectionKey: "privacy", language: "en", title: "x", body: "y" }))))).toContain("This market was not found.");
      expect((await currentLegal(db, alpha.id)).find((s) => s.sectionKey === "privacy")!.body).toBe("Account privacy v3");
    });
  });

  it("market lists and views stay inside their account", async () => {
    expect((await listMarkets(db, beta.id)).map((m) => m.accountId)).toEqual([beta.id]);
    expect(await getMarketView(db, beta.id, ukId)).toBeNull();
    expect((await updateMarket(db, actor(), beta.id, ukId, { overrides: overrideSetting({}, "timezone", "UTC") })).ok).toBe(false);
    const eu = await createMarket(db, actor(), beta.id, { name: "EU" });
    expect(eu.ok).toBe(true);
    expect((await listMarkets(db, alpha.id)).some((m) => m.name === "EU")).toBe(false);
  });
});

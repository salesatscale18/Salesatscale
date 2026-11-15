import { describe, expect, it } from "vitest";
import type { LegalSection } from "@/db/schema";
import { DEFAULT_CONTACT_HOURS } from "@/lib/accounts/contact-hours";
import { effectiveLegal, languagesWithoutLegal } from "@/lib/markets/legal";
import { matchMarket, normalizePhone, type MatchableMarket } from "@/lib/markets/match";
import { canGoLive, marketGoLiveChecks, parseMarketPatch, type GoLiveFacts } from "@/lib/markets/rules";
import {
  accountDefaultsFrom, effectiveSettings, overriddenCount, overrideProblem, overrideSetting, resetSetting, sanitizeOverrides,
} from "@/lib/markets/settings";

const mk = (id: string, over: Partial<MatchableMarket> = {}): MatchableMarket => ({
  id, isHome: false, phonePrefixes: [], formCountryValues: [], intakeKeyIds: [], createdAt: new Date(`2026-11-0${id.length}T00:00:00Z`), ...over,
});

describe("matchMarket", () => {
  const home = mk("il", { isHome: true, phonePrefixes: ["+972"], formCountryValues: ["IL"], createdAt: new Date("2026-01-01") });
  const uk = mk("uk", { phonePrefixes: ["+44"], formCountryValues: ["GB", "United Kingdom"], intakeKeyIds: ["key-uk"], createdAt: new Date("2026-02-01") });
  const nanp = mk("na", { phonePrefixes: ["+1"], createdAt: new Date("2026-03-01") });
  const toronto = mk("to", { phonePrefixes: ["+1416", "+1 647"], createdAt: new Date("2026-04-01") });
  const all = [nanp, uk, toronto, home];

  it("normalizes phone numbers", () => {
    expect(normalizePhone("+44 20 5550-0142")).toBe("+442055500142");
    expect(normalizePhone("0044 20 5550 0142")).toBe("+442055500142");
    expect(normalizePhone("052-123-4567")).toBe("0521234567");
    expect(normalizePhone("  ")).toBe("");
  });

  it("matches the intake key first", () => {
    expect(matchMarket(all, { intakeKeyId: "key-uk", phone: "+14165550100", formCountry: "IL" })).toEqual({ market: uk, reason: "intake_key" });
  });

  it("then the form country, case and spacing ignored", () => {
    expect(matchMarket(all, { phone: "+14165550100", formCountry: "  united   kingdom " })).toEqual({ market: uk, reason: "form_country" });
    expect(matchMarket(all, { intakeKeyId: "unknown-key", formCountry: "gb" }).market).toBe(uk);
  });

  it("then the longest matching phone prefix", () => {
    expect(matchMarket(all, { phone: "+1 416 555 0100" })).toEqual({ market: toronto, reason: "phone_prefix" });
    expect(matchMarket(all, { phone: "+16475550100" }).market).toBe(toronto);
    expect(matchMarket(all, { phone: "+12125550100" }).market).toBe(nanp);
    expect(matchMarket(all, { phone: "+447700900123" }).market).toBe(uk);
  });

  it("falls back to the home market", () => {
    expect(matchMarket(all, { phone: "+33612345678", formCountry: "FR" })).toEqual({ market: home, reason: "home" });
    expect(matchMarket(all, {})).toEqual({ market: home, reason: "home" });
    // A local number has no country code to match.
    expect(matchMarket(all, { phone: "0447700900" })).toEqual({ market: home, reason: "home" });
    expect(matchMarket([nanp], {})).toEqual({ market: null, reason: "home" });
  });

  it("breaks ties: home market first, then the oldest market", () => {
    const a = mk("aa", { phonePrefixes: ["+44"], formCountryValues: ["GB"], intakeKeyIds: ["k"], createdAt: new Date("2026-05-01") });
    const b = mk("bb", { phonePrefixes: ["+44"], formCountryValues: ["GB"], intakeKeyIds: ["k"], createdAt: new Date("2026-04-01") });
    expect(matchMarket([a, b], { phone: "+447700900123" }).market).toBe(b);
    expect(matchMarket([a, b], { formCountry: "GB" }).market).toBe(b);
    expect(matchMarket([a, b], { intakeKeyId: "k" }).market).toBe(b);
    const h = mk("hh", { isHome: true, phonePrefixes: ["+44"], createdAt: new Date("2026-06-01") });
    expect(matchMarket([a, b, h], { phone: "+447700900123" }).market).toBe(h);
    // Same date: by id, so the result never depends on input order.
    const c = mk("cc", { phonePrefixes: ["+44"], createdAt: new Date("2026-04-01") });
    expect(matchMarket([c, b], { phone: "+447700900123" }).market).toBe(b);
    expect(matchMarket([b, c], { phone: "+447700900123" }).market).toBe(b);
  });

  it("a longer prefix beats the home market on the shorter one", () => {
    const h = mk("hh", { isHome: true, phonePrefixes: ["+1"] });
    expect(matchMarket([h, toronto], { phone: "+14165550100" }).market).toBe(toronto);
  });
});

const account = { languages: ["he", "en"], timezone: "Asia/Jerusalem", contactHours: null, currency: "ILS" };
const orderForm = { card: true, bankTransfer: true, bankDetails: "Bank Leumi 123" };

describe("effective settings", () => {
  const defaults = accountDefaultsFrom(account, orderForm);

  it("builds account defaults from the account and order form settings", () => {
    expect(defaults).toEqual({
      languages: ["he", "en"],
      timezone: "Asia/Jerusalem",
      contactHours: DEFAULT_CONTACT_HOURS,
      paymentMethods: { card: true, bankTransfer: true },
      bankDetails: "Bank Leumi 123",
      holidays: [],
      currency: "ILS",
    });
  });

  it("follows the account when nothing is overridden", () => {
    const s = effectiveSettings(defaults, { overrides: {} });
    for (const v of Object.values(s)) expect(v.source).toBe("account");
    expect(s.languages.value).toEqual(["he", "en"]);
  });

  it("uses overrides and says so; reset goes back to the account", () => {
    let o = overrideSetting({}, "languages", ["en"]);
    o = overrideSetting(o, "timezone", "Europe/London");
    o = overrideSetting(o, "bankDetails", null);
    const s = effectiveSettings(defaults, { overrides: o }, { currency: "GBP" });
    expect(s.languages).toEqual({ value: ["en"], source: "market" });
    expect(s.timezone).toEqual({ value: "Europe/London", source: "market" });
    expect(s.bankDetails).toEqual({ value: null, source: "market" });
    expect(s.contactHours.source).toBe("account");
    expect(s.currency).toEqual({ value: "GBP", source: "market" });
    expect(overriddenCount(o)).toBe(3);
    const back = resetSetting(o, "timezone");
    expect(effectiveSettings(defaults, { overrides: back }).timezone).toEqual({ value: "Asia/Jerusalem", source: "account" });
    expect(overriddenCount(back)).toBe(2);
    // Helpers never change their input.
    expect(o.timezone).toBe("Europe/London");
  });

  it("a price list in the account currency is the same as the account", () => {
    expect(effectiveSettings(defaults, { overrides: {} }, { currency: "ILS" }).currency.source).toBe("account");
  });

  it("validates override values", () => {
    expect(overrideProblem("languages", [])).not.toBeNull();
    expect(overrideProblem("languages", ["xx"])).not.toBeNull();
    expect(overrideProblem("languages", ["en", "en"])).not.toBeNull();
    expect(overrideProblem("timezone", "Mars/Base")).not.toBeNull();
    expect(overrideProblem("contactHours", DEFAULT_CONTACT_HOURS)).toBeNull();
    expect(overrideProblem("contactHours", DEFAULT_CONTACT_HOURS.map((d) => ({ ...d, on: false })))).not.toBeNull();
    expect(overrideProblem("contactHours", [{ on: true, from: "20:00", to: "08:00" }, ...DEFAULT_CONTACT_HOURS.slice(1)])).not.toBeNull();
    expect(overrideProblem("paymentMethods", { card: false, bankTransfer: false })).toBeNull();
    expect(overrideProblem("paymentMethods", { card: "yes" })).not.toBeNull();
    expect(overrideProblem("holidays", ["2026-12-25", "2026-12-26"])).toBeNull();
    expect(overrideProblem("holidays", ["25/12/2026"])).not.toBeNull();
    expect(overrideProblem("bankDetails", "x".repeat(501))).not.toBeNull();
  });

  it("drops stored overrides that are not valid, instead of breaking the market", () => {
    expect(sanitizeOverrides({ timezone: "Nope/Nope", languages: ["en"], other: 1, holidays: ["2026-12-26", "2026-12-25", "2026-12-25"] })).toEqual({
      languages: ["en"],
      holidays: ["2026-12-25", "2026-12-26"],
    });
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([1])).toEqual({});
  });
});

describe("market fields", () => {
  it("normalizes countries, prefixes and form values", () => {
    expect(parseMarketPatch({ name: " United Kingdom ", countries: ["gb", "GB"], phonePrefixes: ["+44", "0044", "+1 (416)"], formCountryValues: [" GB ", "", "GB"], intakeKeyIds: [] })).toEqual({
      ok: true,
      value: { name: "United Kingdom", countries: ["GB"], phonePrefixes: ["+44", "+1416"], formCountryValues: ["GB"], intakeKeyIds: [] },
    });
  });

  it("rejects bad values", () => {
    const r = parseMarketPatch({ name: "", countries: ["GBR"], phonePrefixes: ["44"], intakeKeyIds: ["not-a-uuid"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["countries", "intakeKeyIds", "name", "phonePrefixes"]);
  });
});

describe("go-live checks", () => {
  const defaults = accountDefaultsFrom(account, orderForm);
  const facts = (over: Partial<GoLiveFacts> = {}, market: Partial<GoLiveFacts["market"]> = {}): GoLiveFacts => ({
    market: { isHome: false, countries: ["GB"], phonePrefixes: ["+44"], formCountryValues: [], intakeKeyIds: [], priceListLineageId: "pl", ...market },
    settings: effectiveSettings(defaults, { overrides: { languages: ["en"] } }),
    livePriceList: { name: "UK 2026" },
    legalLanguages: ["en"],
    whatsappNumber: null,
    ...over,
  });

  it("passes with the WhatsApp check shown but not blocking", () => {
    const checks = marketGoLiveChecks(facts());
    expect(checks.map((c) => [c.key, c.ok, c.blocking])).toEqual([
      ["where", true, true],
      ["price_list", true, true],
      ["legal_texts", true, true],
      ["payment_methods", true, true],
      ["whatsapp", false, false],
    ]);
    expect(checks[4].detail).toBe("Arrives with P6.");
    expect(canGoLive(checks)).toBe(true);
  });

  it("needs a live, assigned price list", () => {
    expect(marketGoLiveChecks(facts({}, { priceListLineageId: null }))[1]).toMatchObject({ ok: false, detail: "Choose a price list." });
    expect(marketGoLiveChecks(facts({ livePriceList: null }))[1]).toMatchObject({ ok: false, detail: "Publish the price list." });
  });

  it("needs legal texts in every selling language", () => {
    const s = effectiveSettings(defaults, { overrides: {} });
    const c = marketGoLiveChecks(facts({ settings: s, legalLanguages: ["he"] }))[2];
    expect(c).toMatchObject({ ok: false, detail: "Missing in: en." });
  });

  it("needs a payment method, and bank details for bank transfer", () => {
    const none = effectiveSettings(defaults, { overrides: { paymentMethods: { card: false, bankTransfer: false } } });
    expect(canGoLive(marketGoLiveChecks(facts({ settings: none })))).toBe(false);
    const noBank = effectiveSettings(defaults, { overrides: { paymentMethods: { card: false, bankTransfer: true }, bankDetails: null } });
    expect(marketGoLiveChecks(facts({ settings: noBank }))[3]).toMatchObject({ ok: false, detail: "Add the bank details buyers should pay to." });
  });

  it("needs a way for leads to arrive, except for the home market", () => {
    expect(marketGoLiveChecks(facts({}, { phonePrefixes: [] }))[0].ok).toBe(false);
    expect(marketGoLiveChecks(facts({}, { isHome: true, phonePrefixes: [], countries: [] }))[0].ok).toBe(true);
  });
});

describe("legal texts per market", () => {
  let n = 0;
  const row = (over: Partial<LegalSection>): LegalSection => ({
    id: `r${++n}`, accountId: "a", sectionKey: "sales_terms", title: "Sales terms", language: "en", version: 1, body: "x", active: true,
    createdByUserId: null, createdAt: new Date(2026, 0, n), marketId: null, ...over,
  });
  const rows = [
    row({ version: 1 }),
    row({ version: 2, body: "account v2" }),
    row({ sectionKey: "privacy", title: "Privacy", version: 1 }),
    row({ sectionKey: "warranty", title: "Warranty", version: 1 }),
    row({ version: 3, marketId: "uk", body: "uk v3" }),
    row({ sectionKey: "warranty", version: 2, marketId: "uk", active: false }),
    row({ language: "he", version: 1 }),
  ];

  it("uses the market's own sections over the account's, per section and language", () => {
    const uk = effectiveLegal(rows, "uk");
    expect(uk.map((s) => [s.sectionKey, s.language, s.version, s.source])).toEqual([
      ["privacy", "en", 1, "account"],
      ["sales_terms", "en", 3, "market"],
      ["sales_terms", "he", 1, "account"],
    ]);
  });

  it("the account default ignores every market's rows", () => {
    const acc = effectiveLegal(rows, null);
    expect(acc.find((s) => s.sectionKey === "sales_terms" && s.language === "en")?.body).toBe("account v2");
    expect(acc.some((s) => s.sectionKey === "warranty")).toBe(true);
    expect(acc.every((s) => s.source === "account")).toBe(true);
  });

  it("lists selling languages without legal text", () => {
    expect(languagesWithoutLegal(effectiveLegal(rows, "uk"), ["en", "he", "de"])).toEqual(["de"]);
  });
});

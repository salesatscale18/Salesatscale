import { describe, expect, it } from "vitest";
import type { Market } from "@/db/schema";
import { parseOverride, parseWhere, type FormReader } from "@/app/app/[account]/markets/form";
import { applyLeadMarket, chooseLeadMarket, marketLanguage } from "@/lib/leads/market";
import { csvToRawLeads, mergeMarketId, parseCsv, parseLead, rawFromIntakeBody } from "@/lib/leads/rules";

const reader = (v: Record<string, string | string[]>): FormReader => ({
  get: (n) => { const x = v[n]; return Array.isArray(x) ? x[0] ?? "" : x ?? ""; },
  getAll: (n) => { const x = v[n]; return x === undefined ? [] : Array.isArray(x) ? x : [x]; },
});

const market = (p: Partial<Market>): Market => ({
  id: crypto.randomUUID(), accountId: "a", name: "M", isHome: false, status: "setting_up", countries: [], phonePrefixes: [], formCountryValues: [],
  intakeKeyIds: [], priceListLineageId: null, overrides: {}, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), ...p,
});

describe("markets screen form parsing", () => {
  it("reads each kind of override and validates it", () => {
    expect(parseOverride("languages", reader({ languages: ["en", "en"] }))).toEqual({ ok: true, value: ["en"] });
    expect(parseOverride("languages", reader({}))).toEqual({ ok: false, error: "Choose at least one selling language." });
    expect(parseOverride("timezone", reader({ timezone: "Europe/London" }))).toEqual({ ok: true, value: "Europe/London" });
    expect(parseOverride("paymentMethods", reader({ bankTransfer: "on" }))).toEqual({ ok: true, value: { card: false, bankTransfer: true } });
    expect(parseOverride("paymentMethods", reader({})).ok).toBe(false);
    expect(parseOverride("bankDetails", reader({ bankDetails: "  " }))).toEqual({ ok: true, value: null });
    expect(parseOverride("holidays", reader({ holidays: "2026-12-26\n2026-12-25 2026-12-25" }))).toEqual({ ok: true, value: ["2026-12-25", "2026-12-26"] });
    expect(parseOverride("holidays", reader({ holidays: "25/12/2026" })).ok).toBe(false);
    const days = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].flatMap((d) => [[`${d}_on`, d === "sat" ? "" : "on"], [`${d}_from`, "09:00"], [`${d}_to`, "17:00"]]));
    const hours = parseOverride("contactHours", reader(days));
    expect(hours.ok && hours.value[6]).toEqual({ on: false, from: "09:00", to: "17:00" });
    expect(parseOverride("contactHours", reader({ ...days, mon_to: "08:00" })).ok).toBe(false);
  });

  it("fills prefixes and form values from the countries for a new market only", () => {
    expect(parseWhere(reader({ name: "UK", countries: "gb ie" }), { fillFromCountries: true })).toEqual({
      name: "UK", countries: ["GB", "IE"], phonePrefixes: ["+44", "+353"], formCountryValues: ["GB", "United Kingdom", "IE", "Ireland"], intakeKeyIds: [],
    });
    expect(parseWhere(reader({ name: "UK", countries: "GB", phonePrefixes: "+44 20, +44 161", formCountryValues: "" }), { fillFromCountries: false })).toMatchObject({
      phonePrefixes: ["+44 20", "+44 161"], formCountryValues: [],
    });
  });
});

describe("lead market at intake", () => {
  const home = market({ name: "Israel", isHome: true, phonePrefixes: ["+972"] });
  const uk = market({ name: "UK", phonePrefixes: ["+44"], formCountryValues: ["GB"], overrides: { languages: ["en"] }, intakeKeyIds: ["k1"] });
  const ctx = { markets: [home, uk], accountLanguages: ["he", "en"] };

  it("prefers the chosen market, then the key's market, then the match", () => {
    expect(chooseLeadMarket(ctx, { phone: "+972521234567", marketId: uk.id }).reason).toBe("chosen");
    expect(chooseLeadMarket(ctx, { phone: "+972521234567", marketId: "not-mine" }).market.id).toBe(home.id);
    expect(chooseLeadMarket(ctx, { phone: "+972521234567" }, { keyMarketId: uk.id })).toMatchObject({ market: { id: uk.id }, reason: "intake_key" });
    expect(chooseLeadMarket(ctx, { phone: "+972521234567" }, { intakeKeyId: "k1" }).market.id).toBe(uk.id);
    expect(chooseLeadMarket(ctx, { phone: "+972521234567", formCountry: "gb" }).reason).toBe("form_country");
    expect(chooseLeadMarket(ctx, { phone: "+33612345678" })).toMatchObject({ market: { id: home.id }, reason: "home" });
  });

  it("uses the market's language only when the lead has none", () => {
    expect(marketLanguage(uk, ["he"])).toBe("en");
    expect(marketLanguage(home, ["he", "en"])).toBe("he");
    const p = parseLead({ fullName: "A", phone: "+447700900123", consent: "yes", consentSource: "x" }, "IL", { language: "he", now: new Date() });
    if (!p.ok) throw new Error();
    expect(p.value.languageFromDefault).toBe(true);
    expect(applyLeadMarket(ctx, p.value)).toMatchObject({ marketId: uk.id, language: "en", languageFromDefault: false });
    const q = parseLead({ fullName: "A", phone: "+447700900123", language: "he", consent: "yes", consentSource: "x" }, "IL", { language: "he", now: new Date() });
    if (!q.ok) throw new Error();
    expect(applyLeadMarket(ctx, q.value)).toMatchObject({ marketId: uk.id, language: "he" });
  });

  it("reads the country from the webhook body and the CSV, and never replaces a market", () => {
    expect(rawFromIntakeBody({ country: "GB" }).country).toBe("GB");
    expect(csvToRawLeads(parseCsv("full_name,phone,language,country\nA,1,he,GB")).rows[0].raw.country).toBe("GB");
    expect(mergeMarketId("m1", "m2")).toBe("m1");
    expect(mergeMarketId(null, "m2")).toBe("m2");
    expect(mergeMarketId(null, undefined)).toBeNull();
  });
});

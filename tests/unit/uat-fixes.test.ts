/** Regression tests for the UAT round 2 findings (Lane F): pure logic. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SELLER_NAV } from "@/components/sas/nav";
import { activeNavId } from "@/components/sas/side-nav-client";
import { copyMetaFrom } from "@/app/app/[account]/setup/price-lists/rules";
import { playbookFormValues } from "@/app/app/[account]/setup/playbook/form";
import { legalTitle } from "@/app/f/[token]/lines";
import { defaultPlaybook, playbookRowsFromForm } from "@/lib/agent/playbook";
import { CSV_TEMPLATE_HEADER, csvTemplate, csvToRawLeads, normalizePhone, parseCsv, parseLead } from "@/lib/leads/rules";
import { headingTitle } from "@/lib/markets/legal";
import { countryTimezone, marketGoLiveChecks, newMarketTimezone } from "@/lib/markets/rules";

describe("phone numbers need a plausible national number", () => {
  it("refuses 12345 (was +97212345) and other too-short numbers", () => {
    expect(normalizePhone("12345", "IL")).toBeNull();
    expect(normalizePhone("123456", "IL")).toBeNull();
    expect(normalizePhone("+972 123456", "IL")).toBeNull();
    expect(normalizePhone("00972123456", "IL")).toBeNull();
  });
  it("keeps Israeli mobiles and landlines, and foreign numbers, passing", () => {
    expect(normalizePhone("052-555-0193", "IL")).toBe("+972525550193");
    expect(normalizePhone("03-555-0142", "IL")).toBe("+97235550142");
    expect(normalizePhone("+972 52-555-0193", "GB")).toBe("+972525550193");
    expect(normalizePhone("+1 212 555 0100", "IL")).toBe("+12125550100");
    expect(normalizePhone("+44 20 7946 0958", "IL")).toBe("+442079460958");
    expect(normalizePhone("+49 30 1234567", "IL")).toBe("+49301234567");
    // E.164 caps the total at 15 digits.
    expect(normalizePhone("+972 1234567890123", "IL")).toBeNull();
  });
});

describe("manual consent: the box must be ticked and a source given", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  const manual = (raw: Record<string, string>) => parseLead({ fullName: "Rina", phone: "0525550193", ...raw }, "IL", { language: "en", now, consentNeedsTick: true });
  it("an unticked box with 'How they agreed' filled is no consent (was saved as consented)", () => {
    const r = manual({ consent: "", consentSource: "Expo sheet" });
    expect(r.ok && r.value.consent).toBeNull();
  });
  it("a ticked box needs a source; ticked + source is consent", () => {
    const missing = manual({ consent: "yes", consentSource: "" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.consentSource).toBeTruthy();
    const ok = manual({ consent: "yes", consentSource: "Expo sheet" });
    expect(ok.ok && ok.value.consent?.source).toBe("Expo sheet");
  });
  it("CSV and the webhook keep their own rule: a consent source alone still counts", () => {
    const csv = parseLead({ fullName: "Rina", phone: "0525550193", consentSource: "Expo sheet", consentWording: "I agree" }, "IL", { language: "en", now, requireConsentText: true });
    expect(csv.ok && csv.value.consent?.source).toBe("Expo sheet");
  });
});

describe("CSV template", () => {
  it("is generated from CSV_TEMPLATE_HEADER, so it has the country column", () => {
    const text = csvTemplate();
    const rows = parseCsv(text);
    expect(rows[0].join(",")).toBe(CSV_TEMPLATE_HEADER);
    expect(rows[0]).toContain("country");
    expect(rows[1]).toHaveLength(rows[0].length);
    const mapped = csvToRawLeads(rows);
    expect(mapped.unknownColumns).toEqual([]);
    expect(mapped.missingColumns).toEqual([]);
    expect(mapped.rows[0].raw).toMatchObject({ country: "IL", consentSource: "Signed contact sheet at HoReCa Expo, 10 Nov" });
  });
});

describe("side nav: Overview matches only its own page", () => {
  const items = SELLER_NAV.flatMap((g) => g.items);
  const base = "/app/polar";
  it("highlights Settings on /markets (was Overview)", () => {
    expect(activeNavId(items, base, `${base}/markets`, "seller")).toBe("settings");
    expect(activeNavId(items, base, `${base}/markets/x`, "seller")).toBe("settings");
  });
  it("Overview on the base path only; the longest path wins elsewhere", () => {
    expect(activeNavId(items, base, base, "seller")).toBe("overview");
    expect(activeNavId(items, base, `${base}/leads/123`, "seller")).toBe("leads");
    expect(activeNavId(items, base, `${base}/setup/price-lists/abc`, "seller")).toBe("price-lists");
    expect(activeNavId(items, base, `${base}/setup/company`, "seller")).toBe("");
    expect(activeNavId(items, base, `${base}/marketsx`, "seller")).toBe("");
  });
});

describe("new market time zone", () => {
  it("takes the first country's zone when it differs from the account's", () => {
    expect(newMarketTimezone(["DE", "AT"], "Asia/Jerusalem")).toBe("Europe/Berlin");
    expect(newMarketTimezone(["at"], "Asia/Jerusalem")).toBe("Europe/Vienna");
    expect(newMarketTimezone(["IL"], "Asia/Jerusalem")).toBeNull();
    expect(newMarketTimezone([], "Asia/Jerusalem")).toBeNull();
    expect(newMarketTimezone(["ZZ"], "Asia/Jerusalem")).toBeNull();
  });
  it("maps the listed countries to valid IANA zones", () => {
    expect(countryTimezone("CY")).toBe("Asia/Nicosia");
    expect(countryTimezone("GB")).toBe("Europe/London");
    expect(countryTimezone("US")).toBe("America/New_York");
    const zones = new Set(Intl.supportedValuesOf("timeZone"));
    for (const c of ["DE", "AT", "CY", "GB", "US", "IL", "FR", "AU", "JP", "BR"]) expect(zones.has(countryTimezone(c)!)).toBe(true);
  });
});

describe("copy and adjust starts from the source list", () => {
  it("takes the source's currency, VAT included and rate", () => {
    expect(copyMetaFrom({ currency: "ILS", pricesIncludeTax: false, taxRateBp: 1800 })).toEqual({ currency: "ILS", pricesIncludeTax: false, taxRate: "18" });
    expect(copyMetaFrom({ currency: "EUR", pricesIncludeTax: true, taxRateBp: 1950 })).toEqual({ currency: "EUR", pricesIncludeTax: true, taxRate: "19.5" });
  });
});

describe("playbook form keeps what was typed after a refused save", () => {
  it("shows the submitted values, not the saved ones", () => {
    const saved = defaultPlaybook("Polar", 1000);
    const sent = playbookRowsFromForm([["agentName", ""], ["goal", "New goal"], ["tone", "Calm"], ["maxDiscount", "15"], ["offerMeetingWhen", "Big deals"], ["handOffWhen", "Upset"], ["meeting", "on"]]);
    const v = playbookFormValues(saved, { status: "error", errors: { agentName: "x" }, values: sent });
    expect(v).toMatchObject({ agentName: "", goal: "New goal", tone: "Calm", maxDiscount: "15", offerMeetingWhen: "Big deals", handOffWhen: "Upset" });
    expect(v.outcomes).toEqual({ orderForm: false, bankTransfer: false, meeting: true });
    expect(playbookFormValues(saved, { status: "idle" })).toMatchObject({ agentName: saved.agentName, goal: saved.goal, maxDiscount: "10" });
  });
});

describe("no internal phase codes in customer-facing text", () => {
  it("the WhatsApp market check reads plainly", () => {
    const checks = marketGoLiveChecks({
      market: { isHome: true, countries: ["IL"], phonePrefixes: [], formCountryValues: [], intakeKeyIds: [], priceListLineageId: null },
      settings: { languages: { value: ["en"], source: "account" }, paymentMethods: { value: { card: true, bankTransfer: false }, source: "account" }, bankDetails: { value: null, source: "account" } },
      livePriceList: null, legalLanguages: ["en"], whatsappNumber: null,
    });
    expect(checks.find((c) => c.key === "whatsapp")!.detail).toBe("Connect a number in Settings › WhatsApp.");
    expect(checks.find((c) => c.key === "whatsapp")!.detail).not.toMatch(/\bP\d+\b/);
  });
  it("no UI string names a phase (P1–P10)", () => {
    for (const f of ["en", "he"]) {
      const msgs = JSON.parse(readFileSync(`lib/i18n/messages/${f}.json`, "utf8")) as Record<string, string>;
      expect(Object.entries(msgs).filter(([, v]) => /\bP[0-9]+\b/.test(v))).toEqual([]);
    }
  });
});

describe("legal titles", () => {
  it("seller headings use the English version's title, whatever the row order", () => {
    expect(headingTitle([{ language: "he", title: "תנאי מכירה" }, { language: "en", title: "Sales terms" }])).toBe("Sales terms");
    expect(headingTitle([{ language: "he", title: "תנאי מכירה" }])).toBe("תנאי מכירה");
  });
  it("the buyer page uses the page language's title when there is one", () => {
    const l = { key: "sales_terms", title: "Sales terms" };
    expect(legalTitle(l, new Map([["sales_terms", "תנאי מכירה"]]))).toBe("תנאי מכירה");
    expect(legalTitle(l, new Map())).toBe("Sales terms");
    expect(legalTitle(l, null)).toBe("Sales terms");
  });
});

/**
 * Polish-7 pure helpers: relative times with "ago", local times with the zone
 * on hover, date fields in the account locale's order, 24-hour clocks, the
 * order form preview's fields, the quote text's capitalised chat names and
 * the Hebrew neutral agent texts without slash forms.
 */
import { describe, expect, it } from "vitest";
import {
  dateFieldFormat, dateFieldToIso, formatLocalDateTime, formatLocalTime, isoToDateField, normalizeClock, timeAgo, zoneTitle,
} from "@/lib/format";
import { previewFields } from "@/app/app/[account]/setup/order-form/preview";
import { ORDER_FORM_FIELDS } from "@/db/schema";
import { quoteMessageText } from "@/lib/agent/quote-message";
import he from "@/lib/i18n/messages/he.json";
import { tg } from "@/lib/agent/core/names";

const now = new Date("2026-11-18T13:42:00Z");

describe("timeAgo", () => {
  it("says ago, then falls back to the date in the zone", () => {
    expect(timeAgo(new Date(now.getTime() - 20_000), now)).toBe("just now");
    expect(timeAgo(new Date(now.getTime() - 2 * 60_000), now)).toBe("2 min ago");
    expect(timeAgo(new Date(now.getTime() - 3 * 3_600_000), now)).toBe("3 h ago");
    expect(timeAgo(new Date("2026-11-09T23:30:00Z"), now, "Asia/Jerusalem")).toBe("10 Nov");
    expect(timeAgo(new Date(now.getTime() + 60_000), now)).toBe("just now");
  });
});

describe("local times with the zone on hover", () => {
  it("shows the account's local time on a 24-hour clock, the zone in the title", () => {
    expect(formatLocalTime(now, "Asia/Jerusalem")).toBe("15:42");
    expect(formatLocalDateTime(now, "Asia/Jerusalem")).toBe("18 Nov 2026, 15:42");
    expect(formatLocalDateTime(new Date("2026-11-18T20:05:00Z"), "Asia/Jerusalem")).toBe("18 Nov 2026, 22:05");
    expect(zoneTitle(now, "Asia/Jerusalem")).toBe("Asia/Jerusalem (GMT+2)");
    expect(zoneTitle(now, "UTC")).toBe("UTC");
    expect(zoneTitle(now, "Not/AZone")).toBe("UTC");
  });
});

describe("date fields in the account locale's order", () => {
  it("is day/month/year for English (en-GB) and Hebrew, month first only for a US locale", () => {
    expect(dateFieldFormat("en")).toEqual({ order: ["day", "month", "year"], separator: "/", placeholder: "dd/mm/yyyy" });
    expect(dateFieldFormat("he")).toEqual({ order: ["day", "month", "year"], separator: ".", placeholder: "dd.mm.yyyy" });
  });
  it("converts both ways and rejects dates that do not exist", () => {
    expect(isoToDateField("2026-11-18", "en")).toBe("18/11/2026");
    expect(isoToDateField("2026-11-18", "he")).toBe("18.11.2026");
    expect(isoToDateField("", "en")).toBe("");
    expect(dateFieldToIso("18/11/2026", "en")).toBe("2026-11-18");
    expect(dateFieldToIso("1.2.26", "he")).toBe("2026-02-01");
    expect(dateFieldToIso("1-2-2026", "en")).toBe("2026-02-01");
    expect(dateFieldToIso("31/02/2026", "en")).toBeNull();
    expect(dateFieldToIso("11/18/2026", "en")).toBeNull();
    expect(dateFieldToIso("18/11/202", "en")).toBeNull();
    expect(dateFieldToIso("soon", "en")).toBeNull();
  });
});

describe("24-hour clock fields", () => {
  it("normalises typed times and rejects bad ones", () => {
    expect(normalizeClock("8:30")).toBe("08:30");
    expect(normalizeClock("830")).toBe("08:30");
    expect(normalizeClock("20.00")).toBe("20:00");
    expect(normalizeClock("23:59")).toBe("23:59");
    expect(normalizeClock("24:00")).toBeNull();
    expect(normalizeClock("8 PM")).toBeNull();
  });
});

describe("order form preview fields", () => {
  it("shows every ticked company field in form order, then the signer (name always, role when ticked)", () => {
    expect(previewFields(ORDER_FORM_FIELDS, ["company_name", "invoice_email", "company_id", "billing_address", "delivery_address", "signatory_role"])).toEqual({
      company: ["company_name", "company_id", "billing_address", "delivery_address", "invoice_email"],
      signer: ["full_name", "signatory_role"],
    });
    expect(previewFields(ORDER_FORM_FIELDS, ["company_name"])).toEqual({ company: ["company_name"], signer: ["full_name"] });
  });
});

describe("quote text names", () => {
  it("capitalises the chat name's first letter, as the quote card does", () => {
    const body = quoteMessageText({
      number: 1001, currency: "ILS", pricesIncludeTax: false, taxRateBp: 0, discountBp: 0,
      lines: [
        { sku: "GW-10", name: "kitchen hub", qty: 1, charge: "one_time", lineTotalMinor: 66_000, priceSource: "list", service: false },
        { sku: "SVC", name: "installation", qty: 1, charge: "one_time", lineTotalMinor: 25_000, priceSource: "list", service: true },
        { sku: "HE-1", name: "חיישן מקרר", qty: 2, charge: "one_time", lineTotalMinor: 10_000, priceSource: "list", service: false },
      ],
      oneTime: { subtotalMinor: 101_000, discountMinor: 0, taxMinor: 0, totalMinor: 101_000 },
      recurring: { subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 },
      recurringPeriod: null, validUntil: new Date("2026-11-24T12:00:00Z"), timezone: "Asia/Jerusalem", language: "en",
    });
    expect(body).toContain("1 × Kitchen hub (GW-10)");
    expect(body).toContain("\n1 × Installation: ");
    expect(body).toContain("2 × חיישן מקרר (HE-1)");
  });
});

describe("Hebrew neutral agent texts", () => {
  const slash = /[֐-׿]\/[֐-׿]/;
  it("have no slash forms anywhere in he.json", () => {
    expect(Object.entries(he as Record<string, string>).filter(([, v]) => slash.test(v))).toEqual([]);
  });
  it("the neutral opener uses a structure without gendered words; female and male stay as they were", () => {
    expect(tg("buyer.opener.intro", "neutral", { name: "רינה", agent: "Maya", company: "Polar" }, "he")).toBe("היי רינה, כאן Maya מהשירות האוטומטי של Polar.");
    expect(tg("buyer.opener.intro", "female", { name: "רינה", agent: "Maya", company: "Polar" }, "he")).toBe("היי רינה, כאן Maya, העוזרת האוטומטית של Polar.");
    expect(tg("buyer.opener.intro", "male", { name: "רינה", agent: "Maya", company: "Polar" }, "he")).toBe("היי רינה, כאן Maya, העוזר האוטומטי של Polar.");
    expect(tg("buyer.sim.typing", "neutral", undefined, "he")).toBe("בהקלדה…");
    expect(tg("buyer.sim.typing_label", "neutral", { agent: "Maya" }, "he")).toBe("Maya בהקלדה");
    expect(tg("buyer.sim.automated", "neutral", { agent: "Maya" }, "he")).toBe("Maya · שירות אוטומטי");
  });
});

describe("ago wording in sentences (UX 7.4, extended)", () => {
  it("timeAgo reads in a sentence and falls back to a local date", async () => {
    const { timeAgo } = await import("@/lib/format");
    const now = new Date("2026-11-18T12:00:00Z");
    expect(timeAgo(new Date("2026-11-18T11:58:00Z"), now)).toBe("2 min ago");
    expect(timeAgo(new Date("2026-11-18T09:00:00Z"), now)).toBe("3 h ago");
    expect(timeAgo(new Date("2026-11-10T09:00:00Z"), now, "Asia/Jerusalem")).toMatch(/10 Nov/);
  });
});

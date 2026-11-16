import { describe, expect, it } from "vitest";
import {
  agentDeliveryText, estimateDelivery, formatBuyerDate, formatDeliveryBuyer, formatDeliveryRange, formatDeliveryShort, leadTimeOrNull, leadTimeProblem, leadTimeText, localDate,
  parseLeadTime, weekendFor, FRI_SAT, SAT_SUN,
} from "@/lib/delivery/eta";
import { deliveryPlanFor, freezePlan, frozenPlan } from "@/lib/delivery/plan";
import { leadAfterSigning, leadFromSigning } from "@/lib/delivery/text";
import { accountDefaultsFrom, effectiveSettings, overriddenCount, overrideProblem, overrideSetting, resetSetting, sanitizeOverrides } from "@/lib/markets/settings";
import { parseOverride } from "@/app/app/[account]/markets/form";
import { translator } from "@/lib/i18n";

const bd = (minDays: number, maxDays: number) => ({ minDays, maxDays, businessDays: true });
const cal = (minDays: number, maxDays: number) => ({ minDays, maxDays, businessDays: false });
// Tue 1 Dec 2026, 10:00 in London.
const TUE = new Date("2026-12-01T10:00:00Z");

describe("estimateDelivery: business days", () => {
  it("skips Saturday and Sunday by default", () => {
    // Tue + 3 business days = Fri 4 Dec; + 5 = Tue 8 Dec (skipping Sat 5, Sun 6).
    const e = estimateDelivery({ leadTime: bd(3, 5), from: TUE, timezone: "Europe/London" });
    expect(e).toEqual({ earliest: "2026-12-04", latest: "2026-12-08", text: "Fri 4 Dec – Tue 8 Dec" });
  });

  it("the example from the brief: 5–10 business days after Wed 25 Nov", () => {
    const e = estimateDelivery({ leadTime: bd(5, 10), from: new Date("2026-11-25T09:00:00Z"), timezone: "Europe/London", weekend: SAT_SUN });
    expect([e.earliest, e.latest]).toEqual(["2026-12-02", "2026-12-09"]);
    expect(e.text).toBe("Wed 2 Dec – Wed 9 Dec");
  });

  it("an IL market skips Friday and Saturday, so Sunday is a business day", () => {
    // Thu 3 Dec + 1 business day: Sun 6 Dec in Israel, Fri 4 Dec in the UK.
    const thu = new Date("2026-12-03T08:00:00Z");
    expect(estimateDelivery({ leadTime: bd(1, 1), from: thu, timezone: "Asia/Jerusalem", weekend: FRI_SAT }).earliest).toBe("2026-12-06");
    expect(estimateDelivery({ leadTime: bd(1, 1), from: thu, timezone: "Europe/London", weekend: SAT_SUN }).earliest).toBe("2026-12-04");
  });

  it("skips the market's holidays", () => {
    const e = estimateDelivery({ leadTime: bd(1, 2), from: TUE, timezone: "Europe/London", holidays: ["2026-12-02", "2026-12-03"] });
    expect([e.earliest, e.latest]).toEqual(["2026-12-04", "2026-12-07"]);
  });

  it("0 days is the signing day when it is a business day, else the next one", () => {
    expect(estimateDelivery({ leadTime: bd(0, 0), from: TUE, timezone: "Europe/London" }).earliest).toBe("2026-12-01");
    const sat = new Date("2026-12-05T10:00:00Z");
    expect(estimateDelivery({ leadTime: bd(0, 1), from: sat, timezone: "Europe/London" })).toMatchObject({ earliest: "2026-12-07", latest: "2026-12-07" });
  });

  it("min = max gives one date", () => {
    const e = estimateDelivery({ leadTime: bd(3, 3), from: TUE, timezone: "Europe/London" });
    expect(e.earliest).toBe(e.latest);
    expect(e.text).toBe("Fri 4 Dec");
  });

  it("never loops when every day is a day off", () => {
    expect(estimateDelivery({ leadTime: bd(2, 2), from: TUE, timezone: "UTC", weekend: [0, 1, 2, 3, 4, 5, 6] }).earliest).toBe("2026-12-03");
  });
});

describe("estimateDelivery: calendar days and time zones", () => {
  it("counts every day when business days are off", () => {
    const e = estimateDelivery({ leadTime: cal(3, 10), from: TUE, timezone: "Europe/London", holidays: ["2026-12-02"] });
    expect([e.earliest, e.latest]).toEqual(["2026-12-04", "2026-12-11"]);
  });

  it("counts from the date in the market's time zone, not UTC", () => {
    // 22:30 UTC on Wed 2 Dec is already Thu 3 Dec in Jerusalem, still Wed in New York.
    const late = new Date("2026-12-02T22:30:00Z");
    expect(localDate(late, "Asia/Jerusalem")).toBe("2026-12-03");
    expect(localDate(late, "America/New_York")).toBe("2026-12-02");
    expect(estimateDelivery({ leadTime: cal(1, 1), from: late, timezone: "Asia/Jerusalem" }).earliest).toBe("2026-12-04");
    expect(estimateDelivery({ leadTime: cal(1, 1), from: late, timezone: "America/New_York" }).earliest).toBe("2026-12-03");
  });

  it("crosses month and year ends", () => {
    const e = estimateDelivery({ leadTime: bd(2, 5), from: new Date("2026-12-29T12:00:00Z"), timezone: "UTC", holidays: ["2027-01-01"] });
    expect([e.earliest, e.latest]).toEqual(["2026-12-31", "2027-01-06"]);
    expect(formatDeliveryShort(e)).toBe("31 Dec – 6 Jan");
  });

  it("an unknown time zone falls back to UTC instead of failing", () => {
    expect(estimateDelivery({ leadTime: cal(0, 0), from: TUE, timezone: "Not/AZone" }).earliest).toBe("2026-12-01");
  });
});

describe("formatting", () => {
  it("formats ranges in English and Hebrew", () => {
    expect(formatDeliveryRange({ earliest: "2026-12-03", latest: "2026-12-09" })).toBe("Thu 3 Dec – Wed 9 Dec");
    expect(formatDeliveryShort({ earliest: "2026-12-03", latest: "2026-12-09" })).toBe("3–9 Dec");
    expect(formatDeliveryShort({ earliest: "2026-12-03", latest: "2026-12-03" })).toBe("3 Dec");
    const he = formatDeliveryRange({ earliest: "2026-12-03", latest: "2026-12-09" }, "he");
    expect(he).toContain("בדצמ");
    expect(he).not.toContain("Dec");
  });

  it("buyer pages show the year; Hebrew spells the month", () => {
    expect(formatDeliveryBuyer({ earliest: "2026-12-03", latest: "2026-12-09" })).toBe("3–9 Dec 2026");
    expect(formatDeliveryBuyer({ earliest: "2026-12-09", latest: "2026-12-09" })).toBe("9 Dec 2026");
    expect(formatDeliveryBuyer({ earliest: "2026-11-28", latest: "2026-12-04" })).toBe("28 Nov – 4 Dec 2026");
    expect(formatDeliveryBuyer({ earliest: "2026-12-28", latest: "2027-01-04" })).toBe("28 Dec 2026 – 4 Jan 2027");
    expect(formatDeliveryBuyer({ earliest: "2026-12-03", latest: "2026-12-09" }, "he")).toBe("\u20663–9\u2069 בדצמבר 2026");
    // The signing date in the market's time zone.
    expect(formatBuyerDate(new Date("2026-11-25T22:30:00Z"), "Asia/Jerusalem")).toBe("26 Nov 2026");
  });

  it("describes the lead time", () => {
    expect(leadTimeText(bd(5, 10))).toBe("5–10 business days");
    expect(leadTimeText(bd(1, 1))).toBe("1 business day");
    expect(leadTimeText(cal(3, 3))).toBe("3 days");
    expect(leadTimeText(cal(0, 0))).toBe("the same day");
    // Seller screens.
    expect(leadAfterSigning(bd(5, 10))).toBe("5–10 business days after signing");
    expect(leadAfterSigning(bd(7, 7))).toBe("7 business days after signing");
    expect(leadAfterSigning(cal(5, 10))).toBe("5–10 days after signing");
    // Buyer pages, in the buyer's language.
    expect(leadFromSigning(translator("en"), bd(5, 10))).toBe("5–10 business days from signing");
    expect(leadFromSigning(translator("he"), bd(5, 10))).toBe("5–10 ימי עסקים ממועד החתימה");
    expect(leadFromSigning(translator("he"), cal(1, 1))).toBe("יום אחד ממועד החתימה");
  });
});

describe("weekendFor", () => {
  it("uses Fri/Sat for IL, Sat/Sun elsewhere, the account country when the market has none", () => {
    expect(weekendFor(["IL"])).toEqual([5, 6]);
    expect(weekendFor(["GB"])).toEqual([0, 6]);
    expect(weekendFor([], "IL")).toEqual([5, 6]);
    expect(weekendFor([], null)).toEqual([6, 0]);
    // Mixed weekends: skip both (the later, safer estimate).
    expect(weekendFor(["IL", "GB"])).toEqual([0, 5, 6]);
  });
});

describe("lead time validation", () => {
  it("accepts whole numbers 0 ≤ min ≤ max ≤ 365", () => {
    expect(parseLeadTime({ minDays: "5", maxDays: "10", businessDays: "on" })).toEqual({ ok: true, value: bd(5, 10) });
    expect(parseLeadTime({ minDays: "0", maxDays: "365" })).toEqual({ ok: true, value: cal(0, 365) });
    expect(parseLeadTime({ minDays: " 3 ", maxDays: "3", businessDays: "on" })).toEqual({ ok: true, value: bd(3, 3) });
  });

  it("empty means not set; required (a market override) refuses it", () => {
    expect(parseLeadTime({ minDays: "", maxDays: "" })).toEqual({ ok: true, value: null });
    expect(parseLeadTime({}, { required: true })).toEqual({ ok: false, error: "Enter the delivery lead time." });
  });

  it("refuses bad input with plain messages", () => {
    expect(parseLeadTime({ minDays: "5", maxDays: "" })).toEqual({ ok: false, error: "Enter both numbers, or leave both empty." });
    expect(parseLeadTime({ minDays: "2.5", maxDays: "4" })).toEqual({ ok: false, error: "Enter whole numbers of days." });
    expect(parseLeadTime({ minDays: "-1", maxDays: "4" })).toEqual({ ok: false, error: "Enter whole numbers of days." });
    expect(parseLeadTime({ minDays: "6", maxDays: "4" })).toEqual({ ok: false, error: "The first number can't be more than the second." });
    expect(parseLeadTime({ minDays: "1", maxDays: "366" })).toEqual({ ok: false, error: "Lead time can be at most 365 days." });
  });

  it("stored values are checked too", () => {
    expect(leadTimeProblem({ minDays: 1, maxDays: 2, businessDays: true })).toBeNull();
    expect(leadTimeProblem({ minDays: -1, maxDays: 2, businessDays: true })).not.toBeNull();
    expect(leadTimeProblem({ minDays: 1, maxDays: 2 })).not.toBeNull();
    expect(leadTimeOrNull({ minDays: 4, maxDays: 2, businessDays: true })).toBeNull();
    expect(leadTimeOrNull({ minDays: 2, maxDays: 4, businessDays: false, extra: 1 })).toEqual(cal(2, 4));
  });
});

describe("market override and reset", () => {
  const account = { languages: ["en"], timezone: "Asia/Jerusalem", contactHours: null, currency: "ILS", deliveryLeadTime: bd(5, 10), market: "IL" };
  const defaults = accountDefaultsFrom(account, { card: true, bankTransfer: false, bankDetails: null });

  it("follows the account default, overrides it, and resets back", () => {
    expect(effectiveSettings(defaults, { overrides: {} }).leadTime).toEqual({ value: bd(5, 10), source: "account" });
    const o = overrideSetting({}, "leadTime", cal(2, 3));
    expect(effectiveSettings(defaults, { overrides: o }).leadTime).toEqual({ value: cal(2, 3), source: "market" });
    expect(overriddenCount(o)).toBe(1);
    const back = resetSetting(o, "leadTime");
    expect(effectiveSettings(defaults, { overrides: back }).leadTime).toEqual({ value: bd(5, 10), source: "account" });
  });

  it("an account with no lead time gives null; an invalid stored override falls back", () => {
    const none = accountDefaultsFrom({ ...account, deliveryLeadTime: null }, { card: true, bankTransfer: false, bankDetails: null });
    expect(effectiveSettings(none, { overrides: {} }).leadTime.value).toBeNull();
    expect(sanitizeOverrides({ leadTime: { minDays: 9, maxDays: 2, businessDays: true } })).toEqual({});
    expect(overrideProblem("leadTime", null)).not.toBeNull();
  });

  it("reads the Markets override form", () => {
    const f = (v: Record<string, string>) => ({ get: (k: string) => v[k] ?? "", getAll: () => [] });
    expect(parseOverride("leadTime", f({ minDays: "2", maxDays: "4", businessDays: "on" }))).toEqual({ ok: true, value: bd(2, 4) });
    expect(parseOverride("leadTime", f({ minDays: "", maxDays: "" }))).toEqual({ ok: false, error: "Enter the delivery lead time." });
    expect(parseOverride("leadTime", f({ minDays: "4", maxDays: "2" }))).toMatchObject({ ok: false });
  });

  it("builds a market's plan: lead time, time zone, holidays and weekend", () => {
    const uk = { overrides: { timezone: "Europe/London", holidays: ["2026-12-25"], leadTime: cal(1, 2) }, countries: ["GB"] };
    expect(deliveryPlanFor(account, uk)).toEqual({ leadTime: cal(1, 2), timezone: "Europe/London", holidays: ["2026-12-25"], weekend: [0, 6] });
    expect(deliveryPlanFor(account, { overrides: {}, countries: [] })).toEqual({ leadTime: bd(5, 10), timezone: "Asia/Jerusalem", holidays: [], weekend: [5, 6] });
    expect(deliveryPlanFor({ ...account, deliveryLeadTime: null }, { overrides: {}, countries: [] })).toBeNull();
  });
});

describe("snapshot plan", () => {
  it("freezes only future holidays and reads back old or broken snapshots as none", () => {
    const plan = { leadTime: bd(1, 2), timezone: "UTC", holidays: ["2026-01-01", "2026-12-25"], weekend: [0, 6] };
    expect(freezePlan(plan, "2026-12-01")?.holidays).toEqual(["2026-12-25"]);
    expect(freezePlan(null, "2026-12-01")).toBeNull();
    expect(frozenPlan(undefined)).toBeNull();
    expect(frozenPlan(null)).toBeNull();
    expect(frozenPlan({ leadTime: { minDays: "x" }, timezone: "UTC" })).toBeNull();
    expect(frozenPlan({ leadTime: bd(1, 2), timezone: "UTC" })).toEqual({ leadTime: bd(1, 2), timezone: "UTC", holidays: [], weekend: [6, 0] });
  });
});

describe("agent delivery text", () => {
  it("gives the range and lead time, or says it is not set", () => {
    const plan = { leadTime: bd(5, 10), timezone: "Europe/London", holidays: [], weekend: [0, 6] };
    expect(agentDeliveryText(plan, new Date("2026-11-25T09:00:00Z"))).toBe("estimate Wed 2 Dec – Wed 9 Dec (5–10 business days after signing, if signed today)");
    expect(agentDeliveryText(null, TUE)).toMatch(/^not set: if asked, say you'll confirm the delivery time with the team and call lookup_knowledge/);
  });
});

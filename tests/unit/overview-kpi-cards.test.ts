/** Overview V2 (O-1, O-2): the KPI cards and the funnel's "From the step before" column, pure. */
import { describe, expect, it } from "vitest";
import { comparisonLine, formatWhole, kpiCards, percent, stepPercents, waitingToPay, type KpiCardsInput } from "@/lib/overview/kpi-cards";

const cards = (o: Partial<KpiCardsInput> = {}) => kpiCards({
  days: 30,
  kpis: { formsSigned: 0, paidByCurrency: [] },
  prev: { formsSigned: 0, paidByCurrency: [] },
  cards: { signedByCurrency: [], leadsReceived: 0, leadsSigned: 0, leadsWithoutPerson: 0 },
  currency: "ILS",
  ...o,
});
const byId = (o: Partial<KpiCardsInput> = {}) => Object.fromEntries(cards(o).map((c) => [c.id, c]));
const paid = (currency: string, oneTimeMinor: number) => ({ currency, oneTimeMinor, recurringMinor: 0 });

describe("formatWhole and percent", () => {
  it("amounts are whole and rounded; percentages are whole and rounded", () => {
    expect(formatWhole(1_295_650, "ILS")).toBe("₪12,957");
    expect(formatWhole(1_295_649, "ILS")).toBe("₪12,956");
    expect(formatWhole(0, "GBP")).toBe("£0");
    expect(formatWhole(49, "ILS")).toBe("₪0");
    expect(formatWhole(5_000, "JPY")).toBe("¥5,000");
    expect(percent(2, 7)).toBe(29);
    expect(percent(5, 7)).toBe(71);
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBeNull();
  });
});

describe("comparison lines", () => {
  it("+N / −N with an arrow, No change without one, the period's length", () => {
    expect(comparisonLine(2, 30)).toEqual({ text: "+2 vs previous 30 days", trend: "up" });
    expect(comparisonLine(-1, 7)).toEqual({ text: "−1 vs previous 7 days", trend: "down" });
    expect(comparisonLine(0, 30)).toEqual({ text: "No change vs previous 30 days" });
  });

  it("deals signed compares with the previous period", () => {
    const c = byId({ kpis: { formsSigned: 2, paidByCurrency: [] }, prev: { formsSigned: 0, paidByCurrency: [] } });
    expect(c.deals.value).toBe("2");
    expect(c.deals.lines).toEqual([{ text: "+2 vs previous 30 days", trend: "up" }]);
    expect(byId({ kpis: { formsSigned: 1, paidByCurrency: [] }, prev: { formsSigned: 1, paidByCurrency: [] } }).deals.lines).toEqual([{ text: "No change vs previous 30 days" }]);
  });

  it("paid revenue compares in whole amounts: +₪2,400, −₪1, and no change when the difference rounds to 0", () => {
    const up = byId({ kpis: { formsSigned: 0, paidByCurrency: [paid("ILS", 1_295_650)] }, prev: { formsSigned: 0, paidByCurrency: [paid("ILS", 1_055_650)] } });
    expect(up.revenue.value).toBe("₪12,957");
    expect(up.revenue.lines).toEqual([{ text: "+₪2,400 vs previous 30 days", trend: "up" }]);
    const down = byId({ days: 7, kpis: { formsSigned: 0, paidByCurrency: [] }, prev: { formsSigned: 0, paidByCurrency: [paid("ILS", 100)] } });
    expect(down.revenue.value).toBe("₪0");
    expect(down.revenue.lines).toEqual([{ text: "−₪1 vs previous 7 days", trend: "down" }]);
    const same = byId({ kpis: { formsSigned: 0, paidByCurrency: [paid("ILS", 10_020)] }, prev: { formsSigned: 0, paidByCurrency: [paid("ILS", 10_000)] } });
    expect(same.revenue.lines).toEqual([{ text: "No change vs previous 30 days" }]);
  });

  it("nothing paid in either period: ₪0 / £0 in the fallback currency, No change", () => {
    expect(byId().revenue).toMatchObject({ value: "₪0", lines: [{ text: "No change vs previous 30 days" }], accent: "money" });
    expect(byId({ currency: "GBP" }).revenue.value).toBe("£0");
  });
});

describe("currency rule", () => {
  it("paid revenue: never added across currencies; the largest is the number, one line per currency", () => {
    const c = byId({
      kpis: { formsSigned: 0, paidByCurrency: [paid("GBP", 120_000), paid("ILS", 350_000)] },
      prev: { formsSigned: 0, paidByCurrency: [paid("ILS", 350_000)] },
    });
    expect(c.revenue.value).toBe("₪3,500");
    expect(c.revenue.lines).toEqual([
      { text: "£1,200 · +£1,200 vs previous 30 days", trend: "up" },
      { text: "₪3,500 · No change vs previous 30 days" },
    ]);
  });

  it("a currency paid only in the previous period still gets its line", () => {
    const c = byId({ kpis: { formsSigned: 0, paidByCurrency: [paid("ILS", 10_000)] }, prev: { formsSigned: 0, paidByCurrency: [paid("GBP", 5_000)] } });
    expect(c.revenue.lines.map((l) => l.text)).toEqual(["£0 · −£50 vs previous 30 days", "₪100 · +₪100 vs previous 30 days"]);
  });

  it("average deal: per currency, rounded; the largest is the number", () => {
    const one = byId({ cards: { signedByCurrency: [{ currency: "ILS", count: 3, oneTimeMinor: 2_522_100 }], leadsReceived: 0, leadsSigned: 0, leadsWithoutPerson: 0 } });
    expect(one.average).toMatchObject({ value: "₪8,407", lines: [{ text: "One-time, signed deals" }], accent: "plain" });
    const two = byId({ cards: { signedByCurrency: [{ currency: "GBP", count: 1, oneTimeMinor: 100_000 }, { currency: "ILS", count: 2, oneTimeMinor: 400_000 }], leadsReceived: 0, leadsSigned: 0, leadsWithoutPerson: 0 } });
    expect(two.average.value).toBe("₪2,000");
    expect(two.average.lines.map((l) => l.text)).toEqual(["£1,000 · One-time, signed deals", "₪2,000 · One-time, signed deals"]);
    expect(byId().average).toMatchObject({ value: "—", lines: [{ text: "No signed deals yet" }] });
  });
});

describe("lead to signed and handled by the agent", () => {
  it("of the leads received in the period, whole %", () => {
    const c = byId({ cards: { signedByCurrency: [], leadsReceived: 7, leadsSigned: 2, leadsWithoutPerson: 5 } });
    expect(c.conversion).toMatchObject({ value: "29%", lines: [{ text: "2 of 7 leads" }], accent: "plain" });
    expect(c.agent).toMatchObject({ value: "71%", lines: [{ text: "5 of 7 leads without a person" }], accent: "agent" });
    // Never an arrow on lines that are not comparisons.
    expect(c.conversion.lines[0].trend).toBeUndefined();
  });

  it("no leads: — and No leads in this period", () => {
    const c = byId();
    expect(c.conversion).toMatchObject({ value: "—", lines: [{ text: "No leads in this period" }] });
    expect(c.agent).toMatchObject({ value: "—", lines: [{ text: "No leads in this period" }] });
  });
});

describe("simulated buyers included", () => {
  it("each card's line ends with incl. N simulated", () => {
    const c = byId({
      kpis: { formsSigned: 3, paidByCurrency: [paid("ILS", 30_000)] },
      cards: { signedByCurrency: [{ currency: "ILS", count: 3, oneTimeMinor: 30_000 }], leadsReceived: 9, leadsSigned: 3, leadsWithoutPerson: 7 },
      real: {
        kpis: { formsSigned: 1, paidByCurrency: [paid("ILS", 10_000)] },
        cards: { signedByCurrency: [{ currency: "ILS", count: 1, oneTimeMinor: 10_000 }], leadsReceived: 7, leadsSigned: 1, leadsWithoutPerson: 5 },
      },
    });
    expect(c.revenue.lines[0].text).toBe("+₪300 vs previous 30 days · incl. ₪200 simulated");
    expect(c.deals.lines[0].text).toBe("+3 vs previous 30 days · incl. 2 simulated");
    expect(c.conversion.lines[0].text).toBe("3 of 9 leads · incl. 2 simulated");
    expect(c.average.lines[0].text).toBe("One-time, signed deals · incl. 2 simulated");
    expect(c.agent.lines[0].text).toBe("7 of 9 leads without a person · incl. 2 simulated");
  });
});

describe("funnel: from the step before", () => {
  it("blank on the first step, whole % of the step before, — after an empty step", () => {
    expect(stepPercents([7, 2, 2, 2, 0])).toEqual([null, "29%", "100%", "100%", "0%"]);
    expect(stepPercents([0, 0, 1])).toEqual([null, "—", "—"]);
  });

  it("waiting to pay: signed minus paid, never below 0", () => {
    expect(waitingToPay(2, 0)).toBe(2);
    expect(waitingToPay(1, 3)).toBe(0);
  });
});

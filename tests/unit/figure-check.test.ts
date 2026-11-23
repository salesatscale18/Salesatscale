import { describe, expect, it } from "vitest";
import { allowedFigures, extractFigures, figureNote, unverifiedFigures, withoutSentences } from "@/lib/agent/figure-check";

const raws = (s: string) => extractFigures(s).map((f) => [f.kind, f.value]);

describe("figure check: what counts as a figure", () => {
  it("money next to a sign or word, either side; shaped numbers; percents in both languages", () => {
    expect(raws("It is ₪7,717.20 today, or 590 ILS per sensor, 550₪ from 10.")).toEqual([["money", 7717.2], ["money", 590], ["money", 550]]);
    expect(raws("Total 1,180 and 12.50 per month")).toEqual([["money", 1180], ["money", 12.5]]);
    expect(raws("5% off, or 3 percent, 8 per cent")).toEqual([["percent", 5], ["percent", 3], ["percent", 8]]);
    expect(raws("הנחה של 5 אחוזים, סך הכל 7,331.34 ש\"ח")).toEqual([["percent", 5], ["money", 7331.34]]);
    expect(raws("about 7.7k")).toEqual([["money", 7700]]);
  });

  it("bare integers (quantities, dates, times, sites) and URLs are not checked", () => {
    expect(raws("8 sensors for 2 sites, on 24 Nov at 10:30, see https://x.test/q/7717.20?d=5%25")).toEqual([]);
  });
});

describe("figure check: allowed figures", () => {
  const allowed = allowedFigures([
    { totals: { total_today_including_vat: "₪7,717.20", recurring: "₪212.40/month" }, offer: { discount_percent: 5 }, record: { after: { todayMinor: 733134 } } },
    "We have 8 fridges and a budget of 3,500.",
  ]);

  it("exact to the agora, or rounded to whole units; percents exact to 0.1", () => {
    expect(unverifiedFigures("₪7,717.20 today, ₪7,717 rounded, ₪212.40 a month, 5% off, ₪7,331.34 after.", allowed)).toEqual([]);
    expect(unverifiedFigures("That is ₪7,500 today with 6% off.", allowed).map((f) => f.raw)).toEqual(["7,500", "6%"]);
  });

  it("an approximation word allows max(1%, 1)", () => {
    expect(unverifiedFigures("about ₪7,700 today", allowed)).toEqual([]);
    expect(unverifiedFigures("about ₪7,500 today", allowed)).toHaveLength(1);
  });

  it("the buyer's own numbers are allowed", () => {
    expect(unverifiedFigures("Within your 3,500 budget we can start smaller.", allowed)).toEqual([]);
  });
});

describe("figure check: a quote waiting for approval", () => {
  it("its pricing is withheld even though a tool gave it; the held note says no total may be given", () => {
    const allowed = allowedFigures([{ totals: { total_today_including_vat: "₪4,932.40" } }, { items: [{ one_time_price: "₪590.00" }] }]);
    const withheld = allowedFigures([{ total_today_including_vat: "₪4,932.40" }]);
    expect(unverifiedFigures("The total today is ₪4,932.40, about ₪4,930.", allowed, withheld).map((f) => f.raw)).toEqual(["4,932.40", "4,930"]);
    expect(unverifiedFigures("A sensor is ₪590.", allowed, withheld)).toEqual([]);
    expect(figureNote(extractFigures("₪4,932.40"), { held: true })).toContain("the quote waits for the team's approval: no total or price for it may be given yet");
  });
});

describe("figure check: fallback and note", () => {
  it("removes the sentences with unverified figures; empty when nothing is left", () => {
    const reply = "Good news. It comes to ₪7,000 today. Shall I send it?";
    const bad = unverifiedFigures(reply, []);
    expect(withoutSentences(reply, bad)).toBe("Good news. Shall I send it?");
    const only = "It is ₪7,000.";
    expect(withoutSentences(only, unverifiedFigures(only, []))).toBe("");
  });

  it("the note names the figures and the tools to call", () => {
    expect(figureNote(extractFigures("₪7,000 and 6%"))).toMatch(/^\[Check from the system, not from the buyer\] Your reply states 7,000, 6%, which no tool returned/);
  });
});

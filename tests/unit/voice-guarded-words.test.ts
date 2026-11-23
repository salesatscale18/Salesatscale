/**
 * "Classic + guards": amounts in words (K6) and the quote's spoken summary (K5), English and Hebrew. The server
 * writes every amount the agent says after a quote, so ₪106.20 is never read as "…and forty agorot" again.
 */
import { describe, expect, it } from "vitest";
import { englishNumber, hebrewNumber, moneyWords, quantityWords } from "@/lib/voice-guarded/money-words";
import { pluralName, quoteSummaryText, type SummaryInput } from "@/lib/voice-guarded/quote-summary";

describe("amounts in words", () => {
  const cases: [number, string, string][] = [
    [10620, "one hundred and six shekels and twenty agorot", "מאה ושישה שקלים ועשרים אגורות"],
    [21240, "two hundred and twelve shekels and forty agorot", "מאתיים ושנים עשר שקלים וארבעים אגורות"],
    [562860, "five thousand six hundred and twenty-eight shekels and sixty agorot", "חמשת אלפים שש מאות עשרים ושמונה שקלים ושישים אגורות"],
    [316240, "three thousand one hundred and sixty-two shekels and forty agorot", "שלושת אלפים מאה שישים ושניים שקלים וארבעים אגורות"],
    [632480, "six thousand three hundred and twenty-four shekels and eighty agorot", "ששת אלפים שלוש מאות עשרים וארבעה שקלים ושמונים אגורות"],
    // Whole amounts: no cents.
    [20000, "two hundred shekels", "מאתיים שקלים"],
    [100000, "one thousand shekels", "אלף שקלים"],
    [110000, "one thousand one hundred shekels", "אלף ומאה שקלים"],
    [2500000, "twenty-five thousand shekels", "עשרים וחמישה אלף שקלים"],
    [100, "one shekel", "שקל אחד"],
    [200, "two shekels", "שני שקלים"],
    // Cents only, and one agora.
    [20, "twenty agorot", "עשרים אגורות"],
    [1, "one agora", "אגורה אחת"],
    [2, "two agorot", "שתי אגורות"],
  ];
  for (const [minor, en, he] of cases) {
    it(`${minor / 100} ILS`, () => {
      expect(moneyWords(minor, "ILS", "en")).toBe(en);
      expect(moneyWords(minor, "ILS", "he")).toBe(he);
    });
  }

  it("106.20 keeps its own cents (the 23 Nov Current call said \"forty agorot\", from 212.40)", () => {
    expect(moneyWords(10620, "ILS", "en")).not.toContain("forty");
    expect(moneyWords(10620, "ILS", "he")).not.toContain("ארבעים");
  });

  it("other currencies and numbers", () => {
    expect(moneyWords(123456, "USD", "en")).toBe("one thousand two hundred and thirty-four dollars and fifty-six cents");
    expect(moneyWords(100, "EUR", "en")).toBe("one euro");
    expect(moneyWords(1050, "GBP", "en")).toBe("ten pounds and fifty pence");
    expect(englishNumber(1006)).toBe("one thousand and six");
    expect(englishNumber(0)).toBe("zero");
    expect(englishNumber(2_000_001)).toBe("two million and one");
    expect(hebrewNumber(12, "m")).toBe("שנים עשר");
    expect(hebrewNumber(12, "f")).toBe("שתים עשרה");
    expect(hebrewNumber(21, "f")).toBe("עשרים ואחת");
    expect(hebrewNumber(2000)).toBe("אלפיים");
    expect(quantityWords(6, "en")).toBe("six");
    expect(quantityWords(6, "he")).toBe("שש");
    expect(() => moneyWords(-1, "ILS", "en")).toThrow();
  });

  it("plural names", () => {
    expect(pluralName("Temperature sensor")).toBe("Temperature sensors");
    expect(pluralName("Gateway")).toBe("Gateways");
    expect(pluralName("Battery")).toBe("Batteries");
    expect(pluralName("Switch")).toBe("Switches");
    expect(pluralName("Glass")).toBe("Glasses");
    expect(pluralName("Sensors")).toBe("Sensors");
    expect(pluralName("Hub TS-100")).toBe("Hub TS-100");
    expect(pluralName("SIM")).toBe("SIM");
  });
});

describe("the quote's spoken summary", () => {
  /** The 6-sensor, two-site quote: sensors and gateways, installation added by the app, a monthly subscription per sensor. */
  const quote = (language: "en" | "he", deliveryBy: string | null): SummaryInput => ({
    lines: [
      { sku: "SENSOR", name: "Temperature sensor", qty: 3, recurring: false },
      { sku: "SENSOR", name: "Temperature sensor", qty: 3, recurring: false },
      { sku: "GATEWAY", name: "Gateway", qty: 2, recurring: false },
      { sku: "INSTALL", name: "Installation", qty: 2, recurring: false },
      { sku: "SENSOR", name: "Temperature sensor", qty: 6, recurring: true },
    ],
    requested: ["SENSOR", "GATEWAY"], currency: "ILS", oneTimeTotalMinor: 562860, recurringTotalMinor: 21240, period: "month", taxRateBp: 1800,
    deliveryBy, language,
  });
  const words = (s: string) => s.split(/\s+/).length;

  it("English: items with quantities, the two totals in words, the delivery phrase; no digits, no unit prices", () => {
    const s = quoteSummaryText(quote("en", "by about Thursday, 3 December"));
    expect(s).toBe("Six Temperature sensors and two Gateways, with Installation. That's five thousand six hundred and twenty-eight shekels and sixty agorot today and two hundred and twelve shekels and forty agorot a month, including VAT. Delivery by about Thursday, 3 December.");
    expect(s.replace(/3 December/, "")).not.toMatch(/\d/);
    // About 15 seconds of speech at a normal pace (2.6 words a second).
    expect(words(s) / 2.6).toBeLessThan(16);
  });

  it("Hebrew", () => {
    const s = quoteSummaryText(quote("he", "עד בערך יום חמישי, 3 בדצמבר"));
    expect(s).toBe("שש יחידות Temperature sensor ושתי יחידות Gateway, כולל Installation. זה חמשת אלפים שש מאות עשרים ושמונה שקלים ושישים אגורות היום ומאתיים ושנים עשר שקלים וארבעים אגורות לחודש, כולל מע״מ. אספקה עד בערך יום חמישי, 3 בדצמבר.");
    expect(words(s) / 2.6).toBeLessThan(16);
  });

  it("no monthly part without a subscription, no delivery sentence without a plan, no VAT words without VAT", () => {
    const q = quote("en", null);
    const s = quoteSummaryText({ ...q, lines: q.lines.filter((l) => !l.recurring), recurringTotalMinor: 0, taxRateBp: 0, oneTimeTotalMinor: 10620 });
    expect(s).toBe("Six Temperature sensors and two Gateways, with Installation. That's one hundred and six shekels and twenty agorot today.");
  });

  it("a quote of subscriptions only names them, with a yearly total", () => {
    const s = quoteSummaryText({
      lines: [{ sku: "SEAT", name: "User seat", qty: 12, recurring: true }], requested: ["SEAT"], currency: "ILS",
      oneTimeTotalMinor: 0, recurringTotalMinor: 708000, period: "year", taxRateBp: 1800, deliveryBy: null, language: "en",
    });
    expect(s).toBe("Twelve User seats. That's seven thousand and eighty shekels a year, including VAT.");
  });
});

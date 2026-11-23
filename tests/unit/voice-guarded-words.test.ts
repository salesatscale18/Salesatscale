/**
 * "Classic + guards": amounts in words (K6) and the quote's spoken summary (K5), English and Hebrew. The server
 * writes every amount the agent says after a quote, so ₪106.20 is never read as "…and forty agorot" again.
 */
import { describe, expect, it } from "vitest";
import { englishNumber, hebrewNumber, moneyWords, quantityWords, wholeMoneyWords } from "@/lib/voice-guarded/money-words";
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

  it("whole amounts (G1): rounded half up, no minor units", () => {
    expect(wholeMoneyWords(10620, "ILS", "en")).toBe("one hundred and six shekels");
    expect(wholeMoneyWords(562860, "ILS", "en")).toBe("five thousand six hundred and twenty-nine shekels");
    expect(wholeMoneyWords(10620, "ILS", "he")).toBe("מאה ושישה שקלים");
    expect(wholeMoneyWords(562860, "ILS", "he")).toBe("חמשת אלפים שש מאות עשרים ותשעה שקלים");
    expect(wholeMoneyWords(150, "ILS", "en")).toBe("two shekels");
    expect(wholeMoneyWords(149, "ILS", "he")).toBe("שקל אחד");
    expect(wholeMoneyWords(20000, "ILS", "en")).toBe("two hundred shekels");
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
    // G1 (owner, 23 Nov 2026): whole shekels (5628.60 → 5629, 212.40 → 212), the exact figures in the chat.
    expect(s).toBe("Six Temperature sensors and two Gateways, with Installation. That's five thousand six hundred and twenty-nine shekels today and two hundred and twelve shekels a month, including VAT. Delivery by about Thursday, 3 December. The exact figures are in the chat.");
    expect(s).not.toMatch(/agor/);
    expect(s.replace(/3 December/, "")).not.toMatch(/\d/);
    // About 15 seconds of speech at a normal pace (2.6 words a second).
    expect(words(s) / 2.6).toBeLessThan(16);
  });

  it("Hebrew", () => {
    const s = quoteSummaryText(quote("he", "עד בערך יום חמישי, 3 בדצמבר"));
    expect(s).toBe("שש יחידות Temperature sensor ושתי יחידות Gateway, כולל Installation. זה חמשת אלפים שש מאות עשרים ותשעה שקלים היום ומאתיים ושנים עשר שקלים לחודש, כולל מע״מ. אספקה עד בערך יום חמישי, 3 בדצמבר. הסכומים המדויקים מופיעים בצ'אט.");
    expect(s).not.toMatch(/אגור/);
    expect(words(s) / 2.6).toBeLessThan(16);
  });

  it("no monthly part without a subscription, no delivery sentence without a plan, no VAT words without VAT", () => {
    const q = quote("en", null);
    const s = quoteSummaryText({ ...q, lines: q.lines.filter((l) => !l.recurring), recurringTotalMinor: 0, taxRateBp: 0, oneTimeTotalMinor: 10620 });
    expect(s).toBe("Six Temperature sensors and two Gateways, with Installation. That's one hundred and six shekels today. The exact figures are in the chat.");
  });

  it("G1: each spoken total in whole shekels, rounded half up, never zero for an amount above zero", () => {
    const q = quote("en", null);
    const one = (oneTimeTotalMinor: number, language: "en" | "he" = "en") =>
      quoteSummaryText({ ...q, language, lines: q.lines.filter((l) => !l.recurring), recurringTotalMinor: 0, taxRateBp: 0, oneTimeTotalMinor });
    expect(one(10620)).toContain("one hundred and six shekels today");
    expect(one(10650)).toContain("one hundred and seven shekels today");
    expect(one(10649)).toContain("one hundred and six shekels today");
    expect(one(562860)).toContain("five thousand six hundred and twenty-nine shekels today");
    expect(one(10620, "he")).toContain("מאה ושישה שקלים היום");
    expect(one(562860, "he")).toContain("חמשת אלפים שש מאות עשרים ותשעה שקלים היום");
    expect(one(40)).toContain("less than one shekel today");
    expect(one(40, "he")).toContain("פחות משקל אחד היום");
  });

  it("S2: a line at no charge is free, never zero shekels", () => {
    const q = quote("en", null);
    const free = { ...q, lines: q.lines.map((l) => (l.sku === "INSTALL" ? { ...l, free: true } : l)) };
    expect(quoteSummaryText(free)).toMatch(/^Six Temperature sensors and two Gateways, with Installation free\. That's/);
    expect(quoteSummaryText({ ...free, language: "he" })).toMatch(/^שש יחידות Temperature sensor ושתי יחידות Gateway, כולל Installation בחינם\. זה/);
    // With a charged added line too.
    const both = { ...free, lines: [...free.lines, { sku: "SETUP", name: "Setup", qty: 1, recurring: false }] };
    expect(quoteSummaryText(both)).toMatch(/, with Setup, and with Installation free\./);
    // A free main item stays in the list with no price; nothing to pay at all is "free of charge".
    const nothing = quoteSummaryText({ ...q, lines: [{ sku: "SENSOR", name: "Temperature sensor", qty: 1, recurring: false, free: true }], oneTimeTotalMinor: 0, recurringTotalMinor: 0 });
    expect(nothing).toBe("One Temperature sensor. That's free of charge.");
    expect(quoteSummaryText({ ...q, language: "he", lines: [{ sku: "SENSOR", name: "Temperature sensor", qty: 1, recurring: false, free: true }], oneTimeTotalMinor: 0, recurringTotalMinor: 0 }))
      .toBe("Temperature sensor. זה ללא עלות.");
    for (const s of [quoteSummaryText(free), nothing]) expect(s).not.toMatch(/zero/i);
  });

  it("a quote of subscriptions only names them, with a yearly total", () => {
    const s = quoteSummaryText({
      lines: [{ sku: "SEAT", name: "User seat", qty: 12, recurring: true }], requested: ["SEAT"], currency: "ILS",
      oneTimeTotalMinor: 0, recurringTotalMinor: 708000, period: "year", taxRateBp: 1800, deliveryBy: null, language: "en",
    });
    expect(s).toBe("Twelve User seats. That's seven thousand and eighty shekels a year, including VAT. The exact figures are in the chat.");
  });

  it("names items by their catalog plain_name when they have one (main items and the ones the app added)", () => {
    const q = quote("en", "by about Thursday, 3 December");
    const plain: Record<string, string> = { SENSOR: "wireless fridge sensor", GATEWAY: "kitchen hub", INSTALL: "installation visit" };
    const s = quoteSummaryText({ ...q, lines: q.lines.map((l) => ({ ...l, plainName: plain[l.sku] })) });
    expect(s).toBe("Six wireless fridge sensors and two kitchen hubs, with installation visit. That's five thousand six hundred and twenty-nine shekels today and two hundred and twelve shekels a month, including VAT. Delivery by about Thursday, 3 December. The exact figures are in the chat.");
    // A blank plain_name falls back to the name.
    const blank = quoteSummaryText({ ...q, lines: q.lines.map((l) => ({ ...l, plainName: l.sku === "GATEWAY" ? " " : null })) });
    expect(blank).toBe(quoteSummaryText(q));
    // Hebrew: the plain name as written.
    const he = quote("he", null);
    expect(quoteSummaryText({ ...he, lines: he.lines.map((l) => ({ ...l, plainName: l.sku === "GATEWAY" ? "רכזת מטבח" : null })) }))
      .toMatch(/^שש יחידות Temperature sensor ושתי יחידות רכזת מטבח, כולל Installation\./);
  });
});

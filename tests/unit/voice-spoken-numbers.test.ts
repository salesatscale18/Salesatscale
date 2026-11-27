/**
 * The quote-quantities guard reads what the buyer really said (every call, 27 Nov 2026): number words up to the
 * thousands (English and Hebrew, compounds, "a dozen"), thousands separators, and site words whatever their accents.
 */
import { describe, expect, it } from "vitest";
import { spokenNumbers } from "@/lib/voice/spoken-numbers";
import { lineSaysNumber, siteCountsOf, ungroundedQuoteLine, withoutDiacritics } from "@/lib/voice/quote-quantities";

const says = (line: string) => [...spokenNumbers(line)].sort((a, b) => a - b);

describe("spokenNumbers: English", () => {
  it.each([
    ["twelve fridges", [12]],
    ["nineteen", [19]],
    ["twenty-four units", [24]],
    ["twenty four units", [24]],
    ["ninety nine", [99]],
    ["a hundred and twenty", [120]],
    ["one hundred twenty-five", [125]],
    ["three hundred", [300]],
    ["nine hundred and ninety-nine", [999]],
    ["a thousand", [1000]],
    ["two thousand five hundred", [2500]],
    ["a dozen", [12]],
    ["about two dozen", [24]],
    ["half a dozen", [6]],
    ["a couple of them", [2]],
    ["Twelve in total", [12]],
    ["two sites and three each", [2, 3]],
  ] as const)("%s", (line, want) => expect(says(line)).toEqual(want));

  it("digits with thousands separators", () => {
    expect(says("about 1,200 units")).toEqual([1200]);
    expect(says("1,250,000")).toEqual([1250000]);
    expect(says("12 units")).toEqual([]); // plain digits: lineSaysNumber's own check
    expect(lineSaysNumber("about 1,200 units", 1200)).toBe(true);
  });

  it("no number in ordinary words", () => {
    expect(says("a nice place, and a hundred-percent sure")).toEqual([100]);
    expect(says("we are open often and on time")).toEqual([]);
  });
});

describe("spokenNumbers: Hebrew (both genders, common forms)", () => {
  it.each([
    ["שתים עשרה", [12]],
    ["שנים עשר", [12]],
    ["אחד עשר", [11]],
    ["חמישה עשר", [15]],
    ["תשע עשרה", [19]],
    ["עשרים", [20]],
    ["עשרים וארבע", [24]],
    ["עשרים וארבעה", [24]],
    ["שלושים ושתיים", [32]],
    ["תשעים ותשע", [99]],
    ["מאה", [100]],
    ["מאה ועשרים", [120]],
    ["מאתיים", [200]],
    ["שלוש מאות", [300]],
    ["אלף", [1000]],
    ["שלושת אלפים", [3000]],
    ["יש לנו בערך עשרים ושמונה מקררים", [28]],
  ] as const)("%s", (line, want) => expect(says(line)).toEqual(want));
});

describe("lineSaysNumber and the guard read them", () => {
  it("each form grounds its number; what grounded before still does", () => {
    expect(lineSaysNumber("twelve fridges", 12)).toBe(true);
    expect(lineSaysNumber("twenty-four", 24)).toBe(true);
    expect(lineSaysNumber("a hundred and twenty", 120)).toBe(true);
    expect(lineSaysNumber("half a dozen", 6)).toBe(true);
    expect(lineSaysNumber("שתים עשרה", 12)).toBe(true);
    expect(lineSaysNumber("עשרים וארבע", 24)).toBe(true);
    // Unchanged: the older word list.
    expect(lineSaysNumber("both of them", 2)).toBe(true);
    expect(lineSaysNumber("which one?", 1)).toBe(true);
    expect(lineSaysNumber("three", 3)).toBe(true);
  });

  it("live case: \"We have two cafés with twelve fridges in total\" gives 2 sites and grounds 12 (not 2)", () => {
    const p = siteCountsOf("We have two cafés with twelve fridges in total", null);
    expect(p.sites).toEqual([2]);
    expect(lineSaysNumber(p.text, 12)).toBe(true);
    const base = { buyerLines: ["We have two cafés with twelve fridges in total"], callLines: [], sites: 2, refusedAt: null, siteFallback: false };
    expect(ungroundedQuoteLine({ ...base, lines: [{ sku: "S", qty: 12 }] })).toBeNull();
    expect(ungroundedQuoteLine({ ...base, lines: [{ sku: "S", qty: 2 }] })).toEqual({ sku: "S", qty: 2 });
  });

  it("live case: \"about two dozen\" grounds 24", () => {
    expect(ungroundedQuoteLine({ lines: [{ sku: "S", qty: 24 }], buyerLines: ["We have about two dozen."], callLines: [], sites: 1, refusedAt: null, siteFallback: false })).toBeNull();
  });

  it("site words whatever their accents and case; compound site counts read whole", () => {
    expect(withoutDiacritics("Cafés, Hôtels")).toBe("Cafes, Hotels");
    expect(siteCountsOf("Two CAFÉS", null).sites).toEqual([2]);
    expect(siteCountsOf("two hôtels", null).sites).toEqual([2]);
    expect(siteCountsOf("twelve locations", null).sites).toEqual([12]);
    expect(siteCountsOf("twenty four stores", null).sites).toEqual([24]);
    expect(siteCountsOf("שנים עשר סניפים", null).sites).toEqual([12]);
    // Hebrew points are diacritics too.
    expect(siteCountsOf("שְׁנֵי סְנִיפִים", null).sites).toEqual([2]);
    // The agent's question, accented, still marks a bare answer as a site count.
    expect(siteCountsOf({ text: "Two.", after: "How many cafés do you have?" }, 2)).toMatchObject({ sites: [2], notQty: 2 });
  });
});

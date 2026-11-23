import { describe, expect, it } from "vitest";
import { supportedTurnLanguages, turnLanguage } from "@/lib/conversations/turn-language";

const BOTH = ["en", "he"];

describe("turnLanguage: the language of the buyer's latest message", () => {
  it("switches to English when a Hebrew conversation gets an English message", () => {
    expect(turnLanguage("Hi, how much is the Pro plan for two locations?", "he", BOTH)).toBe("en");
    expect(turnLanguage("I need a quote please", "he", BOTH)).toBe("en");
  });

  it("switches to Hebrew when an English conversation gets a Hebrew message", () => {
    expect(turnLanguage("כמה עולה המנוי לשני סניפים?", "en", BOTH)).toBe("he");
  });

  it("reads Hebrew with a Latin brand name as Hebrew", () => {
    expect(turnLanguage("אני רוצה לקנות את ה-iPhone החדש", "en", BOTH)).toBe("he");
    expect(turnLanguage("מה המחיר של Polar Pro?", "en", BOTH)).toBe("he");
  });

  it("reads English with a Hebrew name as English", () => {
    expect(turnLanguage("Hi, my name is דוד and I want a quote for my shop", "he", BOTH)).toBe("en");
  });

  it("keeps the previous language for a neutral or very short message", () => {
    for (const text of ["ok", "OK!", "תודה", "👍", "🙂🙂", "12", "3 x 250", "+972 50 123 4567", "David", "דוד כהן?", "", "   ",
      "https://example.com/order?id=4", "www.polar.co.il", "dana@example.com", "...", "Thanks!"]) {
      expect(turnLanguage(text, "he", BOTH), text).toBe("he");
      expect(turnLanguage(text, "en", BOTH), text).toBe("en");
    }
  });

  it("needs three words: two-word messages keep the previous language, three clear words switch", () => {
    expect(turnLanguage("כן בבקשה", "en", BOTH)).toBe("en");
    expect(turnLanguage("yes please", "he", BOTH)).toBe("he");
    expect(turnLanguage("Price list please", "he", BOTH)).toBe("en");
    expect(turnLanguage("כן, שלחו בבקשה", "en", BOTH)).toBe("he");
  });

  it("ignores links, e-mail addresses and digits when counting words", () => {
    expect(turnLanguage("https://polar.example.com/quote 12345 ok", "he", BOTH)).toBe("he");
    expect(turnLanguage("שלחתי ל-dana@example.com את הקובץ", "en", BOTH)).toBe("he");
  });

  it("keeps the previous language for a half-and-half message", () => {
    expect(turnLanguage("hello there שלום לך", "he", BOTH)).toBe("he");
    expect(turnLanguage("hello there שלום לך", "en", BOTH)).toBe("en");
    expect(turnLanguage("I want את זה please", "he", BOTH)).toBe("he");
  });

  it("keeps the previous language for an unsupported language", () => {
    expect(turnLanguage("Hola, quiero comprar dos portátiles para mi oficina", "he", BOTH)).toBe("he");
    expect(turnLanguage("Bonjour, je voudrais un devis pour deux bureaux", "en", BOTH)).toBe("en");
    expect(turnLanguage("Hallo, ich möchte bitte ein Angebot", "he", BOTH)).toBe("he");
    expect(turnLanguage("مرحبا، كم السعر من فضلك؟", "he", BOTH)).toBe("he");
    expect(turnLanguage("Здравствуйте, сколько это стоит?", "en", BOTH)).toBe("en");
  });

  it("keeps the previous language for Latin words that do not read as English (names, product codes)", () => {
    expect(turnLanguage("Polar Pro X200", "he", BOTH)).toBe("he");
    expect(turnLanguage("Dana Levi", "he", BOTH)).toBe("he");
  });

  it("never switches to a language the market does not sell in", () => {
    expect(turnLanguage("How much is it for two locations?", "he", ["he"])).toBe("he");
    expect(turnLanguage("כמה זה עולה לשני סניפים?", "en", ["en"])).toBe("en");
  });
});

describe("supportedTurnLanguages", () => {
  it("keeps only the platform's buyer languages, in platform order", () => {
    expect(supportedTurnLanguages(["he", "en"])).toEqual(["en", "he"]);
    expect(supportedTurnLanguages(["he", "es"])).toEqual(["he"]);
  });
  it("falls back to every platform language when none match", () => {
    expect(supportedTurnLanguages([])).toEqual(["en", "he"]);
    expect(supportedTurnLanguages(null)).toEqual(["en", "he"]);
    expect(supportedTurnLanguages(["es"])).toEqual(["en", "he"]);
  });
});

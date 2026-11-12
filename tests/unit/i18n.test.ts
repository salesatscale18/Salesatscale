import { describe, expect, it } from "vitest";
import { dir, LOCALES, messages, t } from "@/lib/i18n";
import en from "@/lib/i18n/messages/en.json";

describe("i18n", () => {
  it("interpolates named placeholders and keeps unknown ones", () => {
    expect(t("window.open", { time: "18h 20m" })).toBe("Window open · 18h 20m left");
    expect(t("buyer.valid_until")).toBe("Valid until {date}");
  });

  it("falls back to English for keys a locale does not have", () => {
    expect(t("nav.leads", undefined, "he")).toBe("Leads");
  });

  it("marks Hebrew as right to left", () => {
    expect(dir("he")).toBe("rtl");
    expect(dir("en")).toBe("ltr");
  });

  it("has every buyer-facing key in every locale", () => {
    const buyerKeys = Object.keys(en).filter((k) => k.startsWith("buyer."));
    for (const locale of LOCALES) {
      const missing = buyerKeys.filter((k) => !(k in messages[locale]));
      expect(missing, `missing in ${locale}`).toEqual([]);
    }
  });

  it("has no keys in other locales that English lacks", () => {
    for (const locale of LOCALES) {
      const extra = Object.keys(messages[locale]).filter((k) => !(k in en));
      expect(extra, `extra in ${locale}`).toEqual([]);
    }
  });

  it("keeps the same placeholders in translations", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(vars(value as string), `${locale}:${key}`).toEqual(vars(en[key as keyof typeof en]));
      }
    }
  });
});

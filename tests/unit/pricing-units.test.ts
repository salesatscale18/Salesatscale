import { describe, expect, it } from "vitest";
import { parseUnitCustom, qtyWithUnit, UNIT_KEYS, UNIT_LABELS, UNIT_OPTIONS, unitLabel } from "@/lib/pricing/units";

describe("units", () => {
  it("offers the neutral pick list plus a custom unit", () => {
    expect(UNIT_KEYS).toEqual(["item", "user", "site", "device", "licence", "hour", "day", "month", "kg", "package"]);
    expect(UNIT_OPTIONS.map((o) => o.key)).toEqual([...UNIT_KEYS, "custom"]);
    expect(UNIT_OPTIONS.find((o) => o.key === "user")?.label).toBe("user / seat");
    for (const k of UNIT_KEYS) {
      expect(UNIT_LABELS[k].en.one).toBeTruthy();
      expect(UNIT_LABELS[k].he.other).toBeTruthy();
    }
  });

  it("picks singular for 1 and plural otherwise, in English and Hebrew", () => {
    expect(unitLabel("site", null, "en", 1)).toBe("site");
    expect(unitLabel("site", null, "en", 2)).toBe("sites");
    expect(unitLabel("site", null, "en", 0)).toBe("sites");
    expect(unitLabel("licence", null, "he", 1)).toBe("רישיון");
    expect(unitLabel("licence", null, "he", 3)).toBe("רישיונות");
    expect(unitLabel("kg", null, "en", 5)).toBe("kg");
  });

  it("falls back to English for other languages", () => {
    expect(unitLabel("hour", null, "de", 2)).toBe("hours");
  });

  it("uses a custom unit's own names: asked language, then English, then any", () => {
    const custom = { en: { one: "crate", other: "crates" }, he: { one: "ארגז", other: "ארגזים" } };
    expect(unitLabel("custom", custom, "en", 1)).toBe("crate");
    expect(unitLabel("custom", custom, "he", 4)).toBe("ארגזים");
    expect(unitLabel("custom", custom, "fr", 2)).toBe("crates");
    expect(unitLabel("custom", { he: { one: "ארגז", other: "ארגזים" } }, "en", 1)).toBe("ארגז");
    expect(unitLabel("custom", null, "en", 2)).toBe("items");
  });

  it("shows legacy free-text units unchanged", () => {
    expect(unitLabel("sensor", null, "en", 3)).toBe("sensor");
    expect(qtyWithUnit(2, "site", null, "en")).toBe("2 sites");
    expect(qtyWithUnit(1, "site", null, "en")).toBe("1 site");
  });

  it("validates custom unit names", () => {
    expect(parseUnitCustom({ en: { one: " crate ", other: "crates" } })).toEqual({ en: { one: "crate", other: "crates" } });
    expect(parseUnitCustom({ en: { one: "crate" } })).toBeNull();
    expect(parseUnitCustom({ english: { one: "a", other: "b" } })).toBeNull();
    expect(parseUnitCustom({})).toBeNull();
    expect(parseUnitCustom({ en: { one: "x".repeat(31), other: "y" } })).toBeNull();
    expect(parseUnitCustom(null)).toBeNull();
  });
});

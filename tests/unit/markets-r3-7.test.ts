/** Settings › Markets round-3 fixes (R3-7): the holidays date list, saving an empty list, the holidays row text and the plain wording. */
import { describe, expect, it } from "vitest";
import { holidaysText, overridesAfterSave, parseOverride, type FormReader } from "@/app/app/[account]/markets/form";
import { formatIsoDate } from "@/lib/format";
import { t } from "@/lib/i18n";

const reader = (v: Record<string, string | string[]>): FormReader => ({
  get: (n) => { const x = v[n]; return Array.isArray(x) ? x[0] ?? "" : x ?? ""; },
  getAll: (n) => { const x = v[n]; return x === undefined ? [] : Array.isArray(x) ? x : [x]; },
});

describe("holidays: date list form", () => {
  it("reads one value per chosen date plus a typed date, sorted and once each; an empty date field is ignored", () => {
    expect(parseOverride("holidays", reader({ holidays: ["2026-12-26", "2026-12-25", "", "2026-12-25"] }))).toEqual({ ok: true, value: ["2026-12-25", "2026-12-26"] });
    expect(parseOverride("holidays", reader({ holidays: [""] }))).toEqual({ ok: true, value: [] });
    expect(parseOverride("holidays", reader({ holidays: ["2026-02-30"] })).ok).toBe(false);
  });

  it("saving no dates clears the market's holidays (the same as Reset); other settings are kept", () => {
    const before = { holidays: ["2026-12-25"], timezone: "Europe/London" };
    expect(overridesAfterSave(before, "holidays", [])).toEqual({ timezone: "Europe/London" });
    expect(overridesAfterSave(before, "holidays", ["2027-01-01"])).toEqual({ holidays: ["2027-01-01"], timezone: "Europe/London" });
    expect(overridesAfterSave({}, "timezone", "Europe/Paris")).toEqual({ timezone: "Europe/Paris" });
  });

  it("the row says None, or the count and the next date in the page's date format", () => {
    expect(holidaysText([], "2026-11-18")).toBe("None");
    expect(holidaysText(["2027-01-01", "2026-12-25", "2026-01-01"], "2026-11-18")).toBe("3 dates · next 25 Dec 2026");
    expect(holidaysText(["2026-11-18"], "2026-11-18")).toBe("1 date · next 18 Nov 2026");
    // Every date already past: the count only.
    expect(holidaysText(["2025-12-25", "2026-01-01"], "2026-11-18")).toBe("2 dates");
    expect(formatIsoDate("2026-12-25")).toBe("25 Dec 2026");
    expect(formatIsoDate("bad")).toBe("bad");
  });
});

describe("plain wording", () => {
  it("says 'set for this market' and 'change', never 'override'", () => {
    expect(t("markets.override")).toBe("Change for this market");
    expect(t("markets.overridden")).toBe("Set for this market");
    expect(t("markets.partly_overridden")).toBe("Partly set for this market");
    expect(t("markets.save_override")).toBe("Save");
    expect(t("markets.overridden_count", { count: 2 })).toBe("Different from your account: 2. The rest follow your account defaults.");
    expect(t("markets.intro")).toContain("Change only what is different there.");
    expect(t("markets.same_as_account")).toBe("Same as account default");
    expect(t("markets.reset")).toBe("Reset");
    for (const k of ["markets.intro", "markets.add_intro", "ofs.market_intro", "ofs.overridden", "ofs.override", "markets.holidays_hint"] as const) {
      expect(t(k, { market: "UK" }).toLowerCase()).not.toContain("overrid");
    }
  });
});

/**
 * W1: the shared market selection (lib/markets/selection.ts) and the market
 * outlines (lib/markets/outline.ts). Pure parts only; the cookie and the
 * pages are covered in tests/integration/overview-markets.test.tsx.
 */
import { describe, expect, it } from "vitest";
import {
  MARKET_ALL, inMarket, marketCookieName, marketSwitchTarget, resolveMarketId, safeReturnPath, showMarketSwitcher, switcherReturnTo, withMarketParam,
} from "@/lib/markets/selection";
import { marketOutlinePath, OUTLINE_PAD_TOP, transformPath } from "@/lib/markets/outline";
import { COUNTRY_OUTLINES } from "@/lib/markets/outlines.generated";
import { CALLING_CODES, COUNTRY_TIMEZONE, STANDARD_VAT_BP } from "@/lib/markets/rules";

const IL = { id: "11111111-1111-4111-8111-111111111111", isHome: true };
const UK = { id: "22222222-2222-4222-8222-222222222222", isHome: false };
const DE = { id: "33333333-3333-4333-8333-333333333333", isHome: false };

describe("resolveMarketId", () => {
  const markets = [IL, UK, DE];
  it("the URL parameter wins over the cookie", () => {
    expect(resolveMarketId(markets, UK.id, IL.id)).toBe(UK.id);
    expect(resolveMarketId(markets, MARKET_ALL, IL.id)).toBeNull();
  });
  it("without a URL parameter the cookie decides; nothing stored means all", () => {
    expect(resolveMarketId(markets, undefined, DE.id)).toBe(DE.id);
    expect(resolveMarketId(markets, "", DE.id)).toBe(DE.id);
    expect(resolveMarketId(markets, undefined, MARKET_ALL)).toBeNull();
    expect(resolveMarketId(markets, undefined, undefined)).toBeNull();
  });
  it("an id that is not one of the account's markets falls back to all (URL or cookie)", () => {
    expect(resolveMarketId(markets, "not-a-market", DE.id)).toBeNull();
    expect(resolveMarketId(markets, undefined, "44444444-4444-4444-8444-444444444444")).toBeNull();
  });
  it("one market: always all, and no switcher", () => {
    expect(resolveMarketId([IL], IL.id, IL.id)).toBeNull();
    expect(showMarketSwitcher([IL])).toBe(false);
    expect(showMarketSwitcher([IL, UK])).toBe(true);
  });
});

describe("cookie, links and the switch target", () => {
  it("the cookie is keyed by account", () => {
    expect(marketCookieName("acc-1")).toBe("sas_market_acc-1");
    expect(marketCookieName("acc-1")).not.toBe(marketCookieName("acc-2"));
  });
  it("leads without a market belong to the home market", () => {
    expect(inMarket(null, IL)).toBe(true);
    expect(inMarket(IL.id, IL)).toBe(true);
    expect(inMarket(null, UK)).toBe(false);
    expect(inMarket(UK.id, UK)).toBe(true);
    expect(inMarket(UK.id, null)).toBe(true);
  });
  it("withMarketParam and switcherReturnTo keep the other parameters", () => {
    expect(withMarketParam("/app/a?period=7", { id: UK.id })).toBe(`/app/a?period=7&market=${UK.id}`);
    expect(withMarketParam("/app/a?market=x", null)).toBe("/app/a?market=all");
    expect(switcherReturnTo("/app/a", { period: "7", market: UK.id, panel: "activity", page: "2", tag: ["x", "y"] })).toBe("/app/a?period=7&tag=x&tag=y");
    expect(switcherReturnTo("/app/a", {})).toBe("/app/a");
  });
  it("safeReturnPath only returns inside the account's workspace", () => {
    expect(safeReturnPath("polar", "/app/polar/leads?x=1")).toBe("/app/polar/leads?x=1");
    expect(safeReturnPath("polar", "/app/polar?period=7")).toBe("/app/polar?period=7");
    for (const bad of ["https://evil.test/", "//evil.test", "/app/other", "/app/polarx", "/\\evil", null, ""]) {
      expect(safeReturnPath("polar", bad)).toBe("/app/polar");
    }
  });
  it("marketSwitchTarget stores a valid id (or all) and redirects with ?market=", () => {
    const acc = { id: "acc-1", slug: "polar" };
    const go = (q: string) => marketSwitchTarget(acc, [IL, UK], new URLSearchParams(q));
    expect(go(`market=${UK.id}&next=/app/polar/leads`)).toMatchObject({
      location: `/app/polar/leads?market=${UK.id}`, cookie: { name: "sas_market_acc-1", value: UK.id, options: { httpOnly: true, path: "/" } },
    });
    expect(go("market=all&next=/app/polar")).toMatchObject({ location: "/app/polar?market=all", cookie: { value: "all" } });
    expect(go(`market=${DE.id}&next=https://evil.test`)).toMatchObject({ location: "/app/polar?market=all", cookie: { value: "all" } });
    expect(go("")).toMatchObject({ location: "/app/polar?market=all" });
  });
});

describe("country outlines", () => {
  it("cover every country the market rules know (calling codes, time zones, VAT)", () => {
    const known = new Set([...Object.keys(CALLING_CODES), ...Object.keys(COUNTRY_TIMEZONE), ...Object.keys(STANDARD_VAT_BP)]);
    for (const code of known) expect(COUNTRY_OUTLINES[code], code).toBeDefined();
    expect(Object.keys(COUNTRY_OUTLINES).length).toBeGreaterThan(200);
  });
  it("one country: its own path; several: one fitted path inside the 200×150 box; none or unknown: null", () => {
    expect(marketOutlinePath(["IL"])).toBe(COUNTRY_OUTLINES.IL.d);
    expect(marketOutlinePath(["il", "IL"])).toBe(COUNTRY_OUTLINES.IL.d);
    expect(marketOutlinePath([])).toBeNull();
    expect(marketOutlinePath(["ZZ"])).toBeNull();
    const merged = marketOutlinePath(["DE", "AT", "CH"])!;
    expect(merged.match(/M/g)!.length).toBe(["DE", "AT", "CH"].reduce((n, c) => n + COUNTRY_OUTLINES[c].d.match(/M/g)!.length, 0));
    // Every absolute start point lies inside the box.
    for (const m of merged.matchAll(/M([-\d.]+) ([-\d.]+)/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      expect(Number(m[1])).toBeLessThanOrEqual(200);
      expect(Number(m[2])).toBeGreaterThanOrEqual(0);
      expect(Number(m[2])).toBeLessThanOrEqual(150);
    }
    // Across the antimeridian (Fiji and New Zealand) the shape still fits the box.
    for (const m of marketOutlinePath(["FJ", "NZ"])!.matchAll(/M([-\d.]+) ([-\d.]+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(200);
  });
  it("W5: every outline leaves the top margin free for the status pill (generated and merged)", () => {
    // Fitted into [12, 38]–[188, 138]: the pill sits in the top-start corner, above y = 38.
    for (const [code, o] of Object.entries(COUNTRY_OUTLINES)) {
      expect(o.b[1], code).toBeGreaterThanOrEqual(OUTLINE_PAD_TOP - 0.5);
      expect(o.b[3], code).toBeLessThanOrEqual(138.5);
      expect(o.b[0], code).toBeGreaterThanOrEqual(11.5);
      expect(o.b[2], code).toBeLessThanOrEqual(188.5);
    }
    // The UK (tall) starts below the pill.
    expect(COUNTRY_OUTLINES.GB.b[1]).toBeGreaterThanOrEqual(OUTLINE_PAD_TOP);
    for (const m of marketOutlinePath(["GB", "IE"])!.matchAll(/M([-\d.]+) ([-\d.]+)/g)) expect(Number(m[2])).toBeGreaterThanOrEqual(OUTLINE_PAD_TOP - 0.5);
  });
  it("transformPath scales relative steps and moves only the start points", () => {
    expect(transformPath("M10 20l1 -2 .5-1z", 2, 5, -5)).toBe("M25 35l2 -4 1 -2z");
  });
});

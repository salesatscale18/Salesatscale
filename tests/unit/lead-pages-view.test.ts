/**
 * Lead pages, seller side (slice a-2): the pure view helpers (funnel rows, list
 * filters, the add/edit form's settings), the nav item and the Hebrew prefix
 * before a Latin agent name on the hand-over.
 */
import { describe, expect, it } from "vitest";
import type { LeadPage } from "@/db/schema";
import { SELLER_NAV, visibleNavItems } from "@/components/sas/nav";
import { afterHebrewPrefix } from "@/lib/lead-pages/rules";
import { parseLeadPageInput } from "@/lib/lead-pages/rules";
import type { Funnel } from "@/lib/lead-pages/stats";
import {
  CONNECTION_CARDS, countText, fieldsLine, funnelSteps, marketLine, parseListFilters, pctText, rawFromForm, shortAddress, sourceLabel, topicChoice,
} from "@/lib/lead-pages/view";

const F: Funnel = { visits: 200, opens: 50, leftDetails: 10, startedTalking: 8, gotQuote: 4, ordered: 1, percents: [] };
const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.append(k, x);
  return f;
};
const page = (over: Partial<LeadPage> = {}): LeadPage => ({
  id: "p1", accountId: "a1", publicKey: "abcdefABCDEF", name: "Spring", address: null, extraOrigins: ["staging.acme.com"], connection: "link", status: "draft",
  marketId: null, language: "en", form: {}, openingTopic: { en: "Old topic" }, banner: null, tracking: { tellPagePixel: false }, checks: {}, options: {},
  wentLiveAt: null, pausedAt: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe("lead pages view helpers", () => {
  it("a button or link has no visits: a dash, and the steps start at Opened the form", () => {
    const link = funnelSteps(F, "link");
    expect(link.map((s) => [s.key, s.value, s.pct])).toEqual([
      ["visits", null, null], ["opens", 50, null], ["leftDetails", 10, "20%"], ["startedTalking", 8, "80%"], ["gotQuote", 4, "50%"], ["ordered", 1, "25%"],
    ]);
    const snippet = funnelSteps(F, "snippet");
    expect(snippet.map((s) => s.pct)).toEqual([null, "25%", "20%", "80%", "50%", "25%"]);
    expect(snippet[0].value).toBe(200);
    // Nothing to divide by: no percent (never "NaN%").
    expect(funnelSteps({ ...F, opens: 0, leftDetails: 0 }, "link")[2].pct).toBeNull();
    // More than the step above (possible across periods): a dash.
    expect(funnelSteps({ ...F, startedTalking: 12 }, "link")[3].pct).toBe("—");
  });

  it("reads the list filters from the URL; unknown values fall back", () => {
    expect(parseListFilters({ q: "  spring ", status: "live", market: "m2", days: "7" }, ["m1", "m2"])).toEqual({ q: "spring", status: "live", marketId: "m2", days: 7, archived: false });
    expect(parseListFilters({ status: "deleted", market: "other", days: "365" }, ["m1"])).toEqual({ q: null, status: null, marketId: null, days: 30, archived: false });
    expect(parseListFilters({ archived: "1" }, []).archived).toBe(true);
    expect(parseListFilters({ archived: "yes" }, []).archived).toBe(false);
  });

  it("the add/edit form gives the page settings; hidden settings keep the page's values", () => {
    const topics = [{ en: "Fridge monitoring", he: "ניטור מקררים" }, { en: "Cold rooms" }];
    const raw = rawFromForm(fd({ name: "Summer", connection: "link", language: "he", marketId: "", openingTopic: "0", field_company: "on", consentTicked: "on", carryAdDetails: "on" }), topics, page());
    expect(raw).toMatchObject({
      name: "Summer", connection: "link", language: "he", fields: { company: true, email: false }, consentTicked: true,
      openingTopic: topics[0], tracking: { tellPagePixel: false, carryAdDetails: true }, extraOrigins: ["staging.acme.com"],
    });
    const parsed = parseLeadPageInput(raw, { languages: ["en", "he"] });
    expect(parsed.ok && parsed.value.openingTopic).toEqual(topics[0]);
    // Unticked boxes are off; "keep" keeps the saved topic; an unknown index is none; no connection means Button or link.
    const off = rawFromForm(fd({ name: "x", language: "en", openingTopic: "keep" }), topics, page());
    expect(off).toMatchObject({ consentTicked: false, tracking: { carryAdDetails: false }, openingTopic: { en: "Old topic" }, connection: "link" });
    expect(rawFromForm(fd({ openingTopic: "9" }), topics, null).openingTopic).toBeNull();
    expect(rawFromForm(fd({ openingTopic: "" }), topics, null)).toMatchObject({ openingTopic: null, extraOrigins: [], tracking: { carryAdDetails: false } });
    // The form's select value for a saved topic.
    expect(topicChoice(topics[1], topics)).toBe("1");
    expect(topicChoice({ en: "Old topic" }, topics)).toBe("keep");
    expect(topicChoice(null, topics)).toBe("");
  });

  it("the snippet, the own form and Button or link can be chosen; the hosted page says Later", () => {
    expect(CONNECTION_CARDS.map((c) => [c.id, c.tag])).toEqual([
      ["snippet", null], ["own_form", null], ["link", null], ["hosted", "lead_pages.card.later"],
    ]);
  });

  it("formats lines and numbers", () => {
    expect(marketLine({ marketId: "m1", language: "he" }, [{ id: "m1", name: "Israel" }])).toBe("Israel · HE");
    expect(marketLine({ marketId: null, language: "en" }, [])).toBe("Any market · EN");
    // A stored `sites` (pages saved before the field was removed) is ignored.
    expect(fieldsLine({ fields: { company: true, sites: true } })).toBe("Name, Phone, Company");
    expect(fieldsLine({ fields: { company: true, email: true } })).toBe("Name, Phone, Company, Email");
    expect(shortAddress("https://polardemo.co.il/restaurants/")).toBe("polardemo.co.il/restaurants");
    expect(shortAddress(null)).toBeNull();
    expect(sourceLabel("")).toBe("Direct or unknown");
    expect(sourceLabel("", true)).toBe("Other");
    expect(countText(2010)).toBe("2,010");
    expect(countText(null)).toBe("—");
    expect(pctText(1, 3)).toBe("33%");
    expect(pctText(1, 0)).toBeNull();
  });

  it("the nav lists Lead pages right after Leads", () => {
    const ids = visibleNavItems(SELLER_NAV).map((i) => i.id);
    expect(ids.slice(ids.indexOf("leads"), ids.indexOf("leads") + 2)).toEqual(["leads", "lead-pages"]);
    expect(visibleNavItems(SELLER_NAV).find((i) => i.id === "lead-pages")).toMatchObject({ path: "/lead-pages", icon: "panel-top", label: "nav.lead_pages" });
  });

  it("a Hebrew prefix letter before a Latin name gets a hyphen (the hand-over's connecting line)", () => {
    const fsi = (s: string) => `⁨${s}⁩`;
    expect(afterHebrewPrefix(fsi("Polar Demo assistant"), "Polar Demo assistant", "he")).toBe(`-${fsi("Polar Demo assistant")}`);
    expect(afterHebrewPrefix("נועה", "נועה", "he")).toBe("נועה");
    expect(afterHebrewPrefix("Noa", "Noa", "en")).toBe("Noa");
    expect(afterHebrewPrefix("", "", "he")).toBe("");
  });
});

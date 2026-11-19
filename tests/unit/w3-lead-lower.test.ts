import { describe, expect, it } from "vitest";
import { TIMELINE_COOKIE, timelineCookie, timelineOpen } from "@/lib/leads/timeline-fold";
import { dealPaneView, verifiedOf } from "@/lib/leads/deal-pane";

describe("W3: folded timeline preference", () => {
  it("is closed by default, opens from the cookie, and the URL wins", () => {
    expect(timelineOpen(undefined, undefined)).toBe(false);
    expect(timelineOpen(undefined, "closed")).toBe(false);
    expect(timelineOpen(undefined, "open")).toBe(true);
    expect(timelineOpen("open", undefined)).toBe(true);
    expect(timelineOpen("closed", "open")).toBe(false);
    expect(timelineOpen(["open"], "closed")).toBe(true);
    expect(timelineOpen("junk", "open")).toBe(true);
    expect(timelineOpen(undefined, "junk")).toBe(false);
  });
  it("remembers the choice for a year on the whole app", () => {
    expect(timelineCookie(true)).toBe(`${TIMELINE_COOKIE}=open; path=/; max-age=31536000; samesite=lax`);
    expect(timelineCookie(false)).toMatch(new RegExp(`^${TIMELINE_COOKIE}=closed;`));
  });
});

describe("W3: verified details", () => {
  it("says where a verified value came from, with the date in the account's zone", () => {
    // 23:30 UTC on 18 Nov is 19 Nov in Jerusalem.
    expect(verifiedOf({ provenance: "verified", updatedAt: "2026-11-18T23:30:00Z" }, "Asia/Jerusalem")).toEqual({ source: "form", title: "From the signed order form, 19 Nov 2026" });
    expect(verifiedOf({ provenance: "verified", updatedAt: "2026-11-18T23:30:00Z" }, "UTC")?.title).toBe("From the signed order form, 18 Nov 2026");
    expect(verifiedOf({ provenance: "verified", updatedAt: "2026-11-18T10:00:00Z", verifiedBy: "u1" }, "UTC")).toEqual({ source: "person", title: "Verified by your team, 18 Nov 2026" });
    expect(verifiedOf({ provenance: "buyer", updatedAt: "2026-11-18T10:00:00Z" }, "UTC")).toBeUndefined();
    expect(verifiedOf(undefined, "UTC")).toBeUndefined();
  });
  it("the pane marks verified values and asks for the form note only when a shown value came from the form", () => {
    const base = { latestOrder: null, stage: null, tradeName: "Polar", buyerName: "Eli", timezone: "UTC" };
    const playbook = { fields: [{ key: "a", label: "A", stage: "before_quote" }, { key: "b", label: "B", stage: "before_quote" }] } as never;
    const formPane = dealPaneView({ ...base, playbook, deal: { fields: { a: { value: "x", provenance: "verified", updatedAt: "2026-11-18T10:00:00Z" }, b: { value: "y", provenance: "inferred", updatedAt: "2026-11-18T10:00:00Z" } }, objections: [], nextStep: null } });
    expect(formPane.shown[0].verified?.source).toBe("form");
    expect(formPane.shown[1].verified).toBeUndefined();
    expect(formPane.formVerified).toBe(true);
    const personPane = dealPaneView({ ...base, playbook, deal: { fields: { a: { value: "x", provenance: "verified", updatedAt: "2026-11-18T10:00:00Z", verifiedBy: "u1" } }, objections: [], nextStep: null } });
    expect(personPane.shown[0].verified?.source).toBe("person");
    expect(personPane.formVerified).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { nextBuyerNamedCallTime } from "@/lib/demo/states";

// The demo's buyer-named call: the next Saturday at 21:00 in the account's time zone,
// else the following Saturday when it is under 15 minutes ahead (or past).
describe("nextBuyerNamedCallTime", () => {
  const tz = "Asia/Jerusalem"; // UTC+2 in November

  it("takes the coming Saturday", () => {
    expect(nextBuyerNamedCallTime(new Date("2026-11-19T09:00:00Z"), tz)).toBe("2026-11-21T21:00");
    // Sunday: six days ahead.
    expect(nextBuyerNamedCallTime(new Date("2026-11-22T08:00:00Z"), tz)).toBe("2026-11-28T21:00");
  });

  it("takes Saturday itself when 21:00 is at least 15 minutes ahead", () => {
    // Saturday 20:45 local: exactly 15 minutes ahead.
    expect(nextBuyerNamedCallTime(new Date("2026-11-21T18:45:00Z"), tz)).toBe("2026-11-21T21:00");
  });

  it("takes the following Saturday when 21:00 is under 15 minutes ahead or already past", () => {
    expect(nextBuyerNamedCallTime(new Date("2026-11-21T18:50:00Z"), tz)).toBe("2026-11-28T21:00");
    expect(nextBuyerNamedCallTime(new Date("2026-11-21T20:30:00Z"), tz)).toBe("2026-11-28T21:00");
  });

  it("uses the account's own time zone for the day", () => {
    // Friday 23:30 UTC is already Saturday 01:30 in Jerusalem: today's 21:00.
    expect(nextBuyerNamedCallTime(new Date("2026-11-20T23:30:00Z"), tz)).toBe("2026-11-21T21:00");
    // In New York (UTC-5) it is still Friday 18:30: tomorrow, the same date.
    expect(nextBuyerNamedCallTime(new Date("2026-11-20T23:30:00Z"), "America/New_York")).toBe("2026-11-21T21:00");
  });
});

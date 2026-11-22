/** The viewer's own time zone on seller pages (LD, owner request 22 Nov). */
import { describe, expect, it } from "vitest";
import { parseViewerZone, shownZone, viewerDiffers, viewerTime, yourTimeSuffix } from "@/lib/viewer-zone";

const AT = new Date("2026-11-23T08:00:00Z"); // Mon 23 Nov: 10:00 in Israel, 08:00 in London.

describe("parseViewerZone", () => {
  it("accepts IANA zones (URL-encoded too)", () => {
    expect(parseViewerZone("Europe/London")).toBe("Europe/London");
    expect(parseViewerZone("America%2FNew_York")).toBe("America/New_York");
    expect(parseViewerZone("America/Argentina/Buenos_Aires")).toMatch(/Buenos_Aires$/);
    expect(parseViewerZone("UTC")).toBe("UTC");
  });
  it("ignores anything else", () => {
    for (const bad of [undefined, null, 42, "", "Mars/Olympus", "Europe/London; path=/", "<script>", "%E0%A4%A", "a".repeat(80), "../etc/passwd"]) {
      expect(parseViewerZone(bad)).toBeNull();
    }
  });
});

describe("times in the viewer's zone", () => {
  it("London viewer on an Israel account: London time, '· your time'", () => {
    expect(viewerTime(AT, "Europe/London", "Asia/Jerusalem")).toBe("Mon 23 Nov 08:00");
    expect(yourTimeSuffix(AT, "Europe/London", "Asia/Jerusalem")).toBe(" · your time");
    expect(viewerDiffers(AT, "Europe/London", "Asia/Jerusalem")).toBe(true);
    expect(shownZone("Europe/London", "Asia/Jerusalem")).toBe("Europe/London");
  });
  it("no viewer zone, or the same wall clock: the account's time, no note", () => {
    expect(viewerTime(AT, null, "Asia/Jerusalem")).toBe("Mon 23 Nov 10:00");
    expect(yourTimeSuffix(AT, null, "Asia/Jerusalem")).toBe("");
    expect(yourTimeSuffix(AT, "Asia/Jerusalem", "Asia/Jerusalem")).toBe("");
    // Another name, the same clock at that moment (Cairo is UTC+2 in November).
    expect(yourTimeSuffix(AT, "Africa/Cairo", "Asia/Jerusalem")).toBe("");
  });
});

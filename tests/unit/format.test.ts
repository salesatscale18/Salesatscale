import { describe, expect, it } from "vitest";
import { relativeTime } from "@/lib/format";

describe("relativeTime", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  it.each([
    [0, "just now"], [59, "just now"], [60, "1 min"], [3599, "59 min"], [3600, "1 h"], [86_399, "23 h"], [3 * 86_400, "9 Nov"],
  ])("%is ago → %s", (secs, out) => expect(relativeTime(new Date(now.getTime() - secs * 1000), now)).toBe(out));
});

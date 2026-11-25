import { describe, expect, it } from "vitest";
import { archivedAtOf, archivedOptions, displayStateOf, isArchived, unarchivedOptions, wayOut } from "@/lib/lead-pages/archive";
import { STATUS } from "@/lib/domain/status";
import { t } from "@/lib/i18n";

describe("lead page archive helpers", () => {
  it("archived lives in options (no status enum change) and shows as its own pill", () => {
    const at = new Date("2026-11-20T10:00:00.000Z");
    const opts = archivedOptions({ buttonText: "Hi" }, at, "user-1");
    expect(opts).toEqual({ buttonText: "Hi", archivedAt: "2026-11-20T10:00:00.000Z", archivedBy: "user-1" });
    expect(archivedAtOf({ options: opts })).toBe("2026-11-20T10:00:00.000Z");
    expect(isArchived({ options: opts })).toBe(true);
    expect(displayStateOf({ status: "paused", options: opts })).toBe("archived");
    expect(unarchivedOptions(opts)).toEqual({ buttonText: "Hi" });
    expect(isArchived({ options: {} })).toBe(false);
    expect(isArchived({ options: { archivedAt: "" } })).toBe(false);
    expect(isArchived({ options: null })).toBe(false);
    expect(displayStateOf({ status: "live", options: {} })).toBe("live");
    expect(STATUS.lead_page.archived).toEqual({ tone: "neutral", icon: "archive" });
    expect(t("status.lead_page.archived")).toBe("Archived");
  });

  it("Delete with no real submissions (test ones do not count), Archive with any", () => {
    expect(wayOut({ real: 0 })).toBe("delete");
    expect(wayOut({ real: 1 })).toBe("archive");
  });
});

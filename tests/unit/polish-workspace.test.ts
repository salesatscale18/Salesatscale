/** Live-review polish, Package 5 (lane Polish-2+5): people, times, next step, dark-theme contrast. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { personName } from "@/lib/auth/display";
import { asSentence, formatClockIn, formatDayIn, formatShortDateTimeIn, relativeTime } from "@/lib/format";
import { SELLER_NAV, visibleNavItems } from "@/components/sas/nav";
import { stageSentence } from "@/app/app/[account]/leads/[leadId]/stage";
import type { LeadStageView } from "@/lib/leads/stage";

describe("people by name, never by email", () => {
  const u = { id: "u1", firstName: null, lastName: null, email: "testuser+clerk_test@salesatscale.com" };
  it("the viewer is You; a nameless person is the email's local part without the +tag", () => {
    expect(personName(u, "u1")).toBe("You");
    expect(personName(u, "other")).toBe("testuser");
    expect(personName(u)).toBe("testuser");
    expect(personName({ ...u, firstName: "Danny", lastName: "Levi" }, "other")).toBe("Danny Levi");
    expect(personName({ ...u, email: null })).toBe("Unknown user");
  });
});

describe("times in the viewer's zone", () => {
  const at = new Date("2026-11-17T21:28:00Z"); // 23:28 in Israel (UTC+2)
  it("bubbles show the clock, dividers the day, records the short date and time", () => {
    expect(formatClockIn(at, "Asia/Jerusalem")).toBe("23:28");
    expect(formatDayIn(at, "Asia/Jerusalem")).toBe("Tue, 17 Nov 2026");
    expect(formatShortDateTimeIn(at, "Asia/Jerusalem")).toBe("17 Nov, 23:28");
  });
  it("relative times keep one space (the list cell is no longer mono)", () => {
    expect(relativeTime(new Date(at.getTime() - 14 * 3600_000), at)).toBe("14 h");
  });
});

describe("next step as a sentence", () => {
  it("capitalises, joins steps with ', then' and ends with a full stop", () => {
    expect(asSentence("quote then order form")).toBe("Quote, then order form.");
    expect(asSentence("Send the quote, then the order form.")).toBe("Send the quote, then the order form.");
    expect(asSentence("  ")).toBe("");
  });
});

describe("nav: Meetings and Reports hidden until built", () => {
  it("keeps the routes in the config but not in the visible list", () => {
    const all = SELLER_NAV.flatMap((g) => g.items).map((i) => i.id);
    expect(all).toEqual(expect.arrayContaining(["meetings", "reports"]));
    expect(visibleNavItems(SELLER_NAV).map((i) => i.id)).not.toEqual(expect.arrayContaining(["meetings"]));
    expect(visibleNavItems(SELLER_NAV).map((i) => i.id)).not.toContain("reports");
  });
});

describe("stage banner: waiting states use the clock", () => {
  const base: LeadStageView = { step: "understand", stage: "understand", missing: [], human: false, closed: false, paid: false, signed: false, objection: null, awaitingApproval: false, backAfterChange: false, skippedRecommend: false, questionBudget: 3 } as unknown as LeadStageView;
  it.each(["open", "understand", "recommend", "quote", "order_form"] as const)("%s", (step) => {
    expect(stageSentence({ ...base, step, stage: step } as unknown as LeadStageView, "Tamar").icon).toBe("clock");
  });
});

describe("dark theme contrast", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "components/sas/sas.css"), "utf8");
  const lum = (hex: string) => {
    const c = hex.replace("#", "").match(/../g)!.map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  it("the primary button label has at least 4.5:1 in both themes", () => {
    const dark = css.match(/\.sas-app\[data-theme="dark"\] \{[^}]*/)![0];
    const fill = dark.match(/--primary-fill: (#[0-9a-f]{6})/)![1];
    const on = dark.match(/--on-primary: (#[0-9a-f]{6})/)![1];
    expect(ratio(fill, on)).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#2357d0", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain(".sas-btn--primary, .sas-app a.sas-btn--primary { background: var(--primary-fill);");
  });
  it("the acting banner is dark with white text in every theme", () => {
    expect(css).toMatch(/\.sas-banner--acting \{ background: #0f1420; color: #ffffff;/);
    expect(ratio("#0f1420", "#ffffff")).toBeGreaterThanOrEqual(7);
  });
});

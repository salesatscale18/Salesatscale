/**
 * Zone review 3: the Next step built from a live item's instant in the viewer's
 * zone (scheduledNextStep, nextStepText), and the booking card's day-row fades
 * on both sides (scrollMore, sas.css), RTL included.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));

const { nextStepText, scheduledNextStep } = await import("@/lib/leads/deal-pane");
const { formatDueLocal } = await import("@/lib/follow-ups/rules");
const { scrollMore } = await import("@/app/chat/[token]/reach");

const IL = "Asia/Jerusalem";
const UK = "Europe/London";
const now = new Date("2026-11-22T08:00:00Z");
const at = new Date("2026-11-23T08:00:00Z");
const later = new Date("2026-11-28T19:00:00Z");
const call = (o: Partial<{ status: "requested" | "confirmed"; booked: boolean; at: Date; brief: string }> = {}) =>
  ({ at, timezone: IL, status: "confirmed" as const, booked: true, brief: "Pricing", ...o });
const fu = (o: Partial<{ status: "scheduled" | "failed" | "sent" | "cancelled"; dueAt: Date; topic: string | null }> = {}) =>
  ({ dueAt: later, status: "scheduled" as const, topic: "the second office", ...o });

describe("scheduledNextStep", () => {
  it("a booked team call in the viewer's zone, with 'your time' when it differs", () => {
    expect(scheduledNextStep({ callback: call(), followUp: null, timezone: IL, viewerZone: UK, now })).toBe(`Team call · ${formatDueLocal(at, UK)} · your time`);
    expect(scheduledNextStep({ callback: call(), followUp: null, timezone: IL, viewerZone: null, now })).toBe(`Team call · ${formatDueLocal(at, IL)}`);
  });

  it("an older call request or confirmed call keeps its words and brief", () => {
    expect(scheduledNextStep({ callback: call({ booked: false, status: "requested" }), followUp: null, timezone: IL, viewerZone: UK, now }))
      .toBe(`Call requested ${formatDueLocal(at, UK)} · your time: Pricing`);
    expect(scheduledNextStep({ callback: call({ booked: false }), followUp: null, timezone: IL, viewerZone: UK, now }))
      .toBe(`Call confirmed ${formatDueLocal(at, UK)} · your time: Pricing`);
  });

  it("a scheduled follow-up in the viewer's zone; a failed one is not live", () => {
    expect(scheduledNextStep({ callback: null, followUp: fu(), timezone: IL, viewerZone: UK, now })).toBe(`Follow up ${formatDueLocal(later, UK)} · your time: the second office`);
    expect(scheduledNextStep({ callback: null, followUp: fu({ topic: null }), timezone: IL, viewerZone: null, now })).toBe(`Follow up ${formatDueLocal(later, IL)}`);
    expect(scheduledNextStep({ callback: null, followUp: fu({ status: "failed" }), timezone: IL, viewerZone: UK, now })).toBeNull();
  });

  it("a confirmed call whose slot has ended is not live; with both, the sooner one", () => {
    const past = new Date(now.getTime() - 3_600_000);
    expect(scheduledNextStep({ callback: call({ at: past }), followUp: null, timezone: IL, viewerZone: UK, now })).toBeNull();
    expect(scheduledNextStep({ callback: call({ at: past }), followUp: fu(), timezone: IL, viewerZone: UK, now })).toContain("Follow up");
    expect(scheduledNextStep({ callback: call(), followUp: fu(), timezone: IL, viewerZone: UK, now })).toContain("Team call");
    expect(scheduledNextStep({ callback: call({ at: new Date(later.getTime() + 3_600_000) }), followUp: fu(), timezone: IL, viewerZone: UK, now })).toContain("Follow up");
  });
});

describe("nextStepText with a live item", () => {
  const base = { latestOrder: null, stage: null, tradeName: "Polar", buyerName: "Dana Levi" };
  it("replaces the stored text's baked time; without one the stored text shows as it is", () => {
    const scheduled = `Team call · ${formatDueLocal(at, UK)} · your time`;
    expect(nextStepText({ ...base, agentNextStep: `Team call · ${formatDueLocal(at, IL)}`, scheduled })).toBe(`${scheduled}.`);
    expect(nextStepText({ ...base, agentNextStep: "Send the price", scheduled: null })).toBe("Send the price.");
  });
  it("the order and stage lines still win", () => {
    expect(nextStepText({ ...base, stage: { stage: "order_form" }, agentNextStep: null, scheduled: "Team call · x" })).not.toContain("Team call");
  });
});

describe("Booking card day row: a fade on each side while content is hidden there", () => {
  it("scrollMore: LTR (positive scrollLeft) and RTL (negative)", () => {
    expect(scrollMore({ scrollLeft: 0, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: false, end: true });
    expect(scrollMore({ scrollLeft: 150, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: true, end: true });
    expect(scrollMore({ scrollLeft: 300, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: true, end: false });
    expect(scrollMore({ scrollLeft: -150, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: true, end: true });
    expect(scrollMore({ scrollLeft: -300, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: true, end: false });
    expect(scrollMore({ scrollLeft: 0, clientWidth: 600, scrollWidth: 600 })).toEqual({ start: false, end: false });
  });

  it("sas.css fades the start side on data-more-start and the end side on data-more-end, mirrored in RTL", () => {
    const css = readFileSync(join(process.cwd(), "components/sas/sas.css"), "utf8");
    expect(css).toContain(".c-root .rb-days[data-more-start] { --rb-fade-start: 32px; }");
    expect(css).toContain(".c-root .rb-days[data-more-end] { --rb-fade-end: 32px; }");
    expect(css).toMatch(/\.rb-days:is\(\[data-more-start\], \[data-more-end\]\) \{[^}]*linear-gradient\(to right, transparent, #000 var\(--rb-fade-start\), #000 calc\(100% - var\(--rb-fade-end\)\), transparent\)/);
    expect(css).toMatch(/\.rb-days:is\(\[data-more-start\], \[data-more-end\]\):dir\(rtl\) \{[^}]*linear-gradient\(to left, transparent, #000 var\(--rb-fade-start\)/);
  });
});

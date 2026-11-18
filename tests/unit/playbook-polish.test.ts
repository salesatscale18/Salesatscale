/**
 * Polish-6 (Playbook navigation and polish), pure parts: the section in view
 * for the scroll-spy, the named facts a play asks for and the card footers,
 * the "Covered by Limits" match, the exception date, and the demo seed's
 * never-do list (no rule that restates the discount limit).
 */
import { describe, expect, it } from "vitest";
import { sectionInView } from "@/app/app/[account]/setup/playbook/toc";
import { missingSlots, playSlots, playsOverview, slotTitle } from "@/app/app/[account]/setup/playbook/plays/overview";
import { restatesDiscountLimit, shortDate } from "@/app/app/[account]/setup/playbook/checks";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { demoPlaybook } from "@/lib/demo/seed";

describe("scroll-spy: the section in view", () => {
  const tops = (...t: number[]) => t.map((top, i) => ({ id: `s${i}`, top }));
  it("is the last section whose top passed 30% of the viewport; the first before any has", () => {
    expect(sectionInView(tops(100, 900, 1800), 1000)).toBe("s0");
    expect(sectionInView(tops(-500, 250, 900), 1000)).toBe("s1");
    expect(sectionInView(tops(-2000, -900, 300), 1000)).toBe("s2");
    expect(sectionInView(tops(400, 900), 1000)).toBe("s0");
    expect(sectionInView([], 1000)).toBeNull();
  });
});

describe("sales plays: named facts and card footers", () => {
  const hint = DEFAULT_PLAYS.too_expensive.sellerContentHint;

  it("a play's hint gives its named facts (split by ';', without the article)", () => {
    expect(playSlots(hint)).toEqual(["cost of the problem", "smaller starting set"]);
    expect(playSlots(DEFAULT_PLAYS.competitor.sellerContentHint)).toEqual(["approved comparison facts"]);
    expect(playSlots("")).toEqual([]);
    expect(slotTitle("cost of the problem")).toBe("Cost of the problem");
  });

  it("missing: all without facts; none with as many facts as slots; else the ones no fact mentions", () => {
    expect(missingSlots(hint, [])).toEqual(["cost of the problem", "smaller starting set"]);
    expect(missingSlots(hint, [{ text: "  " }])).toEqual(["cost of the problem", "smaller starting set"]);
    expect(missingSlots(hint, [{ text: "We install in a day." }])).toEqual(["cost of the problem", "smaller starting set"]);
    expect(missingSlots(hint, [{ text: "A spoiled fridge of stock costs 3,000-8,000." }])).toEqual(["smaller starting set"]);
    expect(missingSlots(hint, [{ text: "Start with 1 sensor and the hub." }])).toEqual(["cost of the problem"]);
    expect(missingSlots(hint, [{ text: "a" }, { text: "b" }])).toEqual([]);
    expect(missingSlots(DEFAULT_PLAYS.competitor.sellerContentHint, [{ text: "Anything" }])).toEqual([]);
  });

  it("footers: '1 fact · add …', 'Add …', the hand-off rule in Limits, no facts needed", () => {
    const plays = playsOverview({ plays: { too_expensive: { facts: [{ text: "We install in a day." }] }, value: { facts: [{ text: "A failure costs a night of stock." }] } } }, new Map());
    const by = (k: string) => plays.find((p) => p.key === k)!;
    expect(by("too_expensive").factsLine).toEqual({ kind: "facts", n: 1, missing: ["cost of the problem", "smaller starting set"] });
    expect(by("value").factsLine).toEqual({ kind: "facts", n: 1, missing: ["outcome each product gives"] });
    expect(by("competitor").factsLine).toEqual({ kind: "needs", text: "Add approved comparison facts", missing: ["approved comparison facts"] });
    expect(by("handoff").factsLine).toEqual({ kind: "limits" });
    expect(by("not_now").factsLine).toEqual({ kind: "none" });
    // The "Needs your facts" filter is unchanged: a play with a fact does not need facts.
    expect(by("too_expensive").needsFacts).toBe(false);
  });
});

describe("never do: a rule that only restates the discount limit", () => {
  it("matches a discount rule naming the same percentage as Limits", () => {
    expect(restatesDiscountLimit("Never promise a discount above 5% without approval.", "5")).toBe(true);
    expect(restatesDiscountLimit("No discount over 7.5 % ever", 7.5)).toBe(true);
    expect(restatesDiscountLimit("Never give a 5 percent discount", "5")).toBe(true);
    expect(restatesDiscountLimit("Never promise a discount above 5% without approval.", "10")).toBe(false);
    expect(restatesDiscountLimit("Never invent product facts, prices or delivery dates.", "5")).toBe(false);
    expect(restatesDiscountLimit("Never promise 5% more uptime.", "5")).toBe(false);
    expect(restatesDiscountLimit("Never promise a discount.", "abc")).toBe(false);
  });
});

describe("approved exceptions: the date", () => {
  it("reads 'Approved 18 Nov 2026'", () => {
    expect(shortDate("2026-11-18T09:12:00.000Z")).toBe("18 Nov 2026");
    expect(shortDate("2026-01-05")).toBe("5 Jan 2026");
    expect(shortDate("yesterday")).toBe("");
  });
});

describe("demo seed", () => {
  it("does not add a never-do rule that restates the discount limit", () => {
    const pb = demoPlaybook("t1", new Date("2026-11-18T10:00:00Z"), "u1") as { neverDo: string[]; maxDiscountBp: number };
    expect(pb.neverDo.length).toBeGreaterThan(0);
    expect(pb.neverDo.some((r) => restatesDiscountLimit(r, pb.maxDiscountBp / 100))).toBe(false);
  });
});

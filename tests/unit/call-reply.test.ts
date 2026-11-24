import { describe, expect, it } from "vitest";
import { BOOKKEEPING_TOOLS, bookkeepingNeedsRound, CALL_CONTEXT_LINE_MAX, callContextLineOf, comparableStage } from "@/lib/agent/call-reply";
import type { ToolResult } from "@/lib/agent/tools";

const STAGE = [
  "## Stage now: 2 Understand",
  "Do: react to the buyer's last answer, then ask one question that changes which products you recommend. You have 2 questions left before you must recommend.",
  "Still missing for a quote: Business type, Number of sites.",
  "Prices: not yet.",
].join("\n");
const ok = (extra: Record<string, unknown> = {}, stage = STAGE): ToolResult => ({
  outcome: "ok",
  result: { ok: true, saved: ["business_type"], ignored_unknown: [], kept_verified: [], still_needed_before_quote: ["Number of sites"], stage, ...extra },
});

describe("reply with bookkeeping: the guard", () => {
  it("only update_deal_state is bookkeeping", () => {
    expect([...BOOKKEEPING_TOOLS]).toEqual(["update_deal_state"]);
    expect(bookkeepingNeedsRound("search_catalog", ok(), STAGE)).toBe("not a bookkeeping tool");
  });

  it("an acknowledgement with the same stage block finishes", () => {
    const progressed = STAGE.replace("You have 2 questions", "You have 1 question").replace("Business type, Number of sites", "Number of sites")
      + "\nAsked and not answered: Number of sites (asked once; needed for the quote: ask once more).";
    expect(bookkeepingNeedsRound("update_deal_state", ok({ recorded_as_asked: ["sites"], recorded: ["price_asked"], objection_recorded: { play: "x" } }, progressed), STAGE)).toBeNull();
  });

  it("refusal, failure, rejected, kept, a note or message, an unknown key, a changed stage all need a round", () => {
    expect(bookkeepingNeedsRound("update_deal_state", { outcome: "refused", rule: "r", result: { ok: false, refused: true } }, STAGE)).toMatch(/refused/);
    expect(bookkeepingNeedsRound("update_deal_state", { outcome: "failed", result: { ok: false, error: "x" } }, STAGE)).toMatch(/failed/);
    expect(bookkeepingNeedsRound("update_deal_state", ok({ ignored_unknown: ["colour"] }), STAGE)).toBe("unknown fields ignored");
    expect(bookkeepingNeedsRound("update_deal_state", ok({ kept_verified: ["sites"] }), STAGE)).toBe("verified fields kept");
    expect(bookkeepingNeedsRound("update_deal_state", ok({ rejected_placeholder: ["sites"], message: "Ask." }), STAGE)).toMatch(/rejected_placeholder, message/);
    expect(bookkeepingNeedsRound("update_deal_state", ok({ objection_note: "Step 1 was already used" }), STAGE)).toMatch(/objection_note/);
    expect(bookkeepingNeedsRound("update_deal_state", ok({ something_new: 1 }), STAGE)).toMatch(/something_new/);
    expect(bookkeepingNeedsRound("update_deal_state", ok({}, STAGE.replace("2 Understand", "3 Recommend")), STAGE)).toBe("stage block changed");
    expect(bookkeepingNeedsRound("update_deal_state", ok({}, STAGE.replace("Prices: not yet.", "Prices: allowed.")), STAGE)).toBe("stage block changed");
    expect(bookkeepingNeedsRound("update_deal_state", ok({}, `${STAGE}\nPaused: the buyer has an open objection (Too expensive).`), STAGE)).toBe("stage block changed");
    const { stage: _s, ...noStage } = ok().result;
    void _s;
    expect(bookkeepingNeedsRound("update_deal_state", { outcome: "ok", result: noStage }, STAGE)).toBe("no stage in the result");
  });

  it("comparableStage drops only the progress lines and the questions-left count", () => {
    expect(comparableStage(STAGE)).not.toContain("Still missing");
    expect(comparableStage(STAGE)).toContain("You have N questions left");
    expect(comparableStage(STAGE)).toContain("## Stage now: 2 Understand");
  });
});

describe("the caller's call context line", () => {
  it("is one trimmed line, capped", () => {
    expect(callContextLineOf(undefined)).toBe("");
    expect(callContextLineOf("   \n ")).toBe("");
    expect(callContextLineOf("  This is a call.\n\nSpeak   briefly. ")).toBe("This is a call. Speak briefly.");
    const long = callContextLineOf("x".repeat(2000));
    expect(long).toHaveLength(CALL_CONTEXT_LINE_MAX);
  });
});

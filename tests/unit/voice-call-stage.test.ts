import { describe, expect, it } from "vitest";
import { callStageKey, callStageResult, conflictsWithSayThis, STAGE_SKIP_TOOLS, trimmedStage } from "@/lib/voice/call-stage";
import { callWiringV2For, CALL_WIRING_V2_FOR_BUYER_CALLS } from "@/lib/voice/settings";

const ORDER_FORM = [
  "## Stage now: 5 Order form",
  "The quote is with the buyer.",
  'Do: if the buyer agrees ("yes", "ok", "send it"), call send_order_form at once and say the order form link is in the chat.',
  "Moves on when: the link is sent.",
  "Prices: allowed. Take every number from the tools.",
].join("\n");
const HELD = [
  "## Stage now: 4 Quote and close",
  "The quote waits for the seller's approval: you asked the team for that price.",
  "Do: tell the buyer once that you have asked the team to approve that price, then keep going.",
  "Moves on when: the team decides.",
  "Prices: allowed. Take every number from the tools.",
].join("\n");
const UNDERSTAND = (missing: string) => `## Stage now: 2 Understand\nDo: react.\nStill missing for a quote: ${missing}.\nPrices: not yet.`;

describe("call wiring v2: the constant and its helper", () => {
  it("off for buyer calls; on for test calls", () => {
    expect(CALL_WIRING_V2_FOR_BUYER_CALLS).toBe(false);
    expect(callWiringV2For(true)).toBe(true);
    expect(callWiringV2For(false)).toBe(false);
    expect(callWiringV2For(false, true)).toBe(true);
  });
});

describe("the stage on a call's tool result (A2)", () => {
  it("the key is the title and what is still missing (ask counts do not change it)", () => {
    expect(callStageKey(UNDERSTAND("Number of sites"))).toBe("2 Understand|Number of sites.");
    expect(callStageKey(UNDERSTAND("Number of sites").replace("Do: react.", "Do: react, 2 questions left."))).toBe(callStageKey(UNDERSTAND("Number of sites")));
    expect(callStageKey(UNDERSTAND("nothing"))).not.toBe(callStageKey(UNDERSTAND("Number of sites")));
  });

  it("full block when changed, one short line when the model already has it, nothing added to the tool's own block", () => {
    const first = callStageResult({ forModel: { ok: true }, block: ORDER_FORM, title: "5 Order form", own: false, last: null });
    expect(first.forModel).toEqual({ ok: true, stage: ORDER_FORM });
    const again = callStageResult({ forModel: { ok: true }, block: ORDER_FORM, title: "5 Order form", own: false, last: first.key });
    expect(again.forModel).toEqual({ ok: true, stage: "unchanged: 5 Order form" });
    const own = callStageResult({ forModel: { ok: true, stage: ORDER_FORM }, block: ORDER_FORM, title: null, own: true, last: null });
    expect(own).toEqual({ forModel: { ok: true, stage: ORDER_FORM }, key: first.key });
  });

  it("next to say_this: a block whose Do asks for words of its own is cut to its title and Moves on when; a conditional Do stays", () => {
    expect(conflictsWithSayThis(HELD)).toBe(true);
    expect(conflictsWithSayThis(ORDER_FORM)).toBe(false);
    expect(trimmedStage(HELD)).toBe("## Stage now: 4 Quote and close\nMoves on when: the team decides.");
    const held = callStageResult({ forModel: { say_this: "I've asked the team.", message: "m" }, block: HELD, title: null, own: false, last: null });
    expect(held.forModel).toEqual({ say_this: "I've asked the team.", message: "m", stage: "## Stage now: 4 Quote and close\nMoves on when: the team decides." });
    const ready = callStageResult({ forModel: { message: "m", say_this: "Six sensors." }, block: ORDER_FORM, title: null, own: false, last: null });
    expect(ready.forModel.stage).toBe(ORDER_FORM);
    // No say_this: the whole block.
    expect(callStageResult({ forModel: { ok: true }, block: HELD, title: null, own: false, last: null }).forModel.stage).toBe(HELD);
  });

  it("not on results that ask for one fixed thing", () => {
    expect([...STAGE_SKIP_TOOLS].sort()).toEqual(["end_call", "hand_off_to_human", "record_opt_out"]);
  });
});

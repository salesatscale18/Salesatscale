import { describe, expect, it } from "vitest";
import {
  BOOKKEEPING_TOOLS, bookkeepingNeedsRound, CALL_CONTEXT_LINE_MAX, CALL_REPLY_ARG_DESCRIPTION_MAX, callContextLineOf, callReplyArgDescriptionOf,
  comparableStage, SPOKEN_REPLY_ARG, splitSpokenReply, toolDefsWithSpokenReply,
} from "@/lib/agent/call-reply";
import { TOOL_DEFS, type ToolResult } from "@/lib/agent/tools";

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

describe("spoken_reply argument", () => {
  it("the description is one trimmed line, capped at 400", () => {
    expect(callReplyArgDescriptionOf(undefined)).toBe("");
    expect(callReplyArgDescriptionOf(" \n\t ")).toBe("");
    expect(callReplyArgDescriptionOf(" Your spoken\nreply,\n\n  short. ")).toBe("Your spoken reply, short.");
    expect(callReplyArgDescriptionOf("z".repeat(900))).toHaveLength(CALL_REPLY_ARG_DESCRIPTION_MAX);
    expect(CALL_REPLY_ARG_DESCRIPTION_MAX).toBe(400);
  });

  it("extends only update_deal_state: nullable string, required like the other nullable fields; TOOL_DEFS untouched", () => {
    const before = JSON.stringify(TOOL_DEFS);
    const ext = toolDefsWithSpokenReply(TOOL_DEFS, "Say it.");
    expect(JSON.stringify(TOOL_DEFS)).toBe(before);
    expect(ext.map((d) => d.name)).toEqual(TOOL_DEFS.map((d) => d.name));
    ext.forEach((d, i) => { if (d.name !== "update_deal_state") expect(d).toBe(TOOL_DEFS[i]); });
    const orig = TOOL_DEFS.find((d) => d.name === "update_deal_state")!;
    const u = ext.find((d) => d.name === "update_deal_state")!;
    const s = u.input_schema as unknown as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    const o = orig.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(s.properties[SPOKEN_REPLY_ARG]).toEqual({ type: ["string", "null"], description: "Say it." });
    expect(s.required).toEqual([...o.required, "spoken_reply"]);
    expect(s.additionalProperties).toBe(false);
    expect({ ...u, input_schema: undefined }).toEqual({ ...orig, input_schema: undefined });
    const { spoken_reply: _x, ...rest } = s.properties;
    void _x;
    expect(rest).toEqual(o.properties);
  });

  it("splitSpokenReply takes the argument off the input", () => {
    expect(splitSpokenReply({ updates: [], spoken_reply: "Hi" })).toEqual({ input: { updates: [] }, spoken: "Hi" });
    expect(splitSpokenReply({ updates: [], spoken_reply: null })).toEqual({ input: { updates: [] }, spoken: null });
    const plain = { updates: [] };
    expect(splitSpokenReply(plain).input).toBe(plain);
    expect(splitSpokenReply(null)).toEqual({ input: null, spoken: null });
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

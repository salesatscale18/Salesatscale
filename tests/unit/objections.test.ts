/**
 * O1, objection handling: the shared method and the ladders in the prompt
 * (chat and voice read the same source), the objection record (old rows,
 * validation, attempts, steps), the "Open objection" block next to "Known so
 * far", the Deal state pane lines and the tool schema. Pure; no model calls.
 */
import { describe, expect, it } from "vitest";
import { PLAY_KEYS, type DealFieldValue, type Playbook, type StoredObjection } from "@/db/schema";
import { defaultPlaybook } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { coreDesign, objectionMethod } from "@/lib/agent/core/design";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { deriveStage, NO_STAGE_FACTS } from "@/lib/agent/core/stage";
import {
  applyObjection, DEFAULT_OBJECTION_ATTEMPTS, MAX_OBJECTIONS, OBJECTION_PLAYS, objectionAttemptsOf, openObjectionText, parseObjectionInput, readObjections,
  type ObjectionInput,
} from "@/lib/agent/core/objections";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { geminiSchema, realtimeTools } from "@/lib/voice/tool-schema";
import { dealPaneView, objectionLine, paneObjections } from "@/lib/leads/deal-pane";
import { stageView } from "@/lib/leads/stage";

const pb: Playbook = defaultPlaybook("Acme", 500);
const seller = { tradeName: "Acme", currency: "ILS", languages: ["en"] };
const said = (value: string): DealFieldValue => ({ value, provenance: "buyer", updatedAt: "2026-11-20T10:00:00.000Z" });
const input = (o: Partial<ObjectionInput> = {}): ObjectionInput => ({ play: "too_expensive", words: "That's a lot", step: 1, attempt: false, status: "open", ...o });

describe("the plays and the shared method in the prompt", () => {
  it("has the 19 plays: the five that run the sale, the eight rewritten, the split hand-off and five new", () => {
    expect(PLAY_KEYS).toHaveLength(19);
    expect(OBJECTION_PLAYS).toHaveLength(14);
    for (const k of ["need", "fit", "value", "price_early", "right_size"]) expect(OBJECTION_PLAYS as readonly string[]).not.toContain(k);
    expect(DEFAULT_PLAYS.asks_for_person.title).toBe("The buyer asks for a person");
    expect(DEFAULT_PLAYS.handoff.title).toBe("The buyer is upset");
    expect(DEFAULT_PLAYS.too_expensive.do).toHaveLength(6);
    expect(DEFAULT_PLAYS.too_expensive.do[5]).toBe("Last rungs: agree a time to come back, then a call.");
    expect(DEFAULT_PLAYS.no_answer.do[1]).toContain("Send the question to the team silently.");
    // The check question after the recommendation.
    expect(DEFAULT_PLAYS.fit.do.at(-1)).toBe("End with one check question: does it sound like what they need?");
  });

  it("the core design carries the shared method in place of the one-line objection rule", () => {
    const core = coreDesign({ tradeName: "Acme", meeting: false });
    expect(core).not.toContain("An objection: the stage pauses. Acknowledge it, give the approved answer, check that it settled it.");
    expect(core).not.toContain("offer to check with the team");
    for (const h of ["### Objections", "The four moves", "Knowing which objection it is", "When to drop the objection (flexibility)", "Limits", "The last rungs, the same for every ladder", "How to take these steps with your tools"]) {
      expect(core, h).toContain(`\n${h}\n`);
    }
    expect(core).toContain("- Two attempts per objection. An attempt is one step that tried to settle it.");
    expect(core).toContain("Never mention the ladder, steps, plays or attempts.");
    // The attempts number comes from the setting hook (part 3); 2 by default.
    expect(objectionAttemptsOf(pb)).toBe(DEFAULT_OBJECTION_ATTEMPTS);
    expect(objectionMethod(1)).toContain("- One attempt per objection.");
    expect(objectionMethod(3)).toContain("- Three attempts per objection.");
    // Today's tools for the steps that are built later: never a pausing hand-off for an unknown question.
    expect(core).toContain("Send a question to the team: look it up with lookup_knowledge.");
    expect(core).toContain("Never use hand_off_to_human for it.");
    expect(core).toContain('there is no booking link yet');
  });

  it("the playbook part no longer hands off on an unknown question or a first request for a person", () => {
    const p = stableSystemPrompt(pb, seller);
    expect(p).toContain("- Hand off to a person (hand_off_to_human) when: The buyer is upset, complains, raises a legal or existing-customer issue, or insists on a person.");
    expect(p).toContain('A question you have no approved answer for, or a first request for a person, is not a reason to hand off');
    // An older playbook that still says "asks something you cannot answer" gets the same rule after it.
    const older = stableSystemPrompt({ ...pb, handOffWhen: "The buyer asks for a person, is upset, or asks something you cannot answer from approved information." }, seller);
    expect(older).toContain("cannot answer from approved information. A question you have no approved answer for");
  });

  it("voice reads the same plays and method (the stable prompt with channel voice)", () => {
    const voice = stableSystemPrompt(pb, seller, null, { channel: "voice" });
    expect(voice).toContain("### Objections\n");
    for (const key of PLAY_KEYS) expect(voice, key).toContain(`### ${DEFAULT_PLAYS[key].title}\nWhen: ${DEFAULT_PLAYS[key].when}`);
    const ctx = turnContext(pb, { fields: {}, objections: [{ play: "competitor", words: "X is cheaper", steps: [1], status: "open", attempts: 0 }], nextStep: null }, { agentMessages: 2, channel: "voice" });
    expect(ctx).toContain("## Open objection");
  });
});

describe("the objection record", () => {
  it("reads rows written before O1: { text, handled } becomes an objection with no play", () => {
    const old: StoredObjection[] = [{ text: "too pricey", handled: false }, { text: "has an alarm", handled: true }];
    expect(readObjections(old)).toEqual([
      { play: null, words: "too pricey", steps: [], status: "open", attempts: 0 },
      { play: null, words: "has an alarm", steps: [], status: "settled", attempts: 0 },
    ]);
    expect(readObjections(null)).toEqual([]);
    // Junk is dropped; a bad status reads as open; steps are whole positive numbers, once each.
    expect(readObjections([{} as never, { play: "nope", words: "w", steps: [2, 2, 0, 1.5], status: "x", attempts: 9 } as never])).toEqual([
      { play: null, words: "w", steps: [2], status: "open", attempts: 3 },
    ]);
  });

  it("validates the agent's input: known objection plays only, the status list, a step on the card", () => {
    const ok = parseObjectionInput({ play: "locked_in", buyer_words: " no long contract ", step: 2, attempt: true, status: "open" }, pb);
    expect(ok).toEqual({ ok: true, value: { play: "locked_in", words: "no long contract", step: 2, attempt: true, status: "open" } });
    expect(parseObjectionInput({ play: "fit", buyer_words: "", step: null, attempt: false, status: "open" }, pb)).toMatchObject({ ok: false });
    expect(parseObjectionInput({ play: "price", buyer_words: "", step: null, attempt: false, status: "open" }, pb)).toMatchObject({ ok: false, error: expect.stringContaining("too_expensive") });
    expect(parseObjectionInput({ play: "too_expensive", buyer_words: "", step: null, attempt: false, status: "handled" }, pb)).toMatchObject({ ok: false, error: expect.stringContaining("open, settled, dropped") });
    expect(parseObjectionInput({ play: "too_expensive", buyer_words: "", step: 7, attempt: false, status: "open" }, pb)).toMatchObject({ ok: false, error: expect.stringContaining("1 to 6") });
    expect(parseObjectionInput({ play: "too_expensive", buyer_words: "", step: 0, attempt: false, status: "open" }, pb)).toMatchObject({ ok: false });
    expect(parseObjectionInput({ play: "too_expensive", buyer_words: "", step: 1, attempt: "yes", status: "open" }, pb)).toMatchObject({ ok: false });
    expect(parseObjectionInput({ text: "Too expensive", handled: false }, pb)).toMatchObject({ ok: false });
    // The seller's own card sets how many steps there are.
    const own = { ...pb, plays: { too_expensive: { own: { when: "w", do: ["One.", "Two."], example: "e", notThis: "n" } } } };
    expect(parseObjectionInput({ play: "too_expensive", buyer_words: "", step: 3, attempt: false, status: "open" }, own)).toMatchObject({ ok: false, error: expect.stringContaining("1 to 2") });
  });

  it("records each step once, counts attempts and caps them at the setting", () => {
    let w = applyObjection([], input({ step: 1 }), 2);
    expect(w.entry).toEqual({ play: "too_expensive", words: "That's a lot", steps: [1], status: "open", attempts: 0 });
    w = applyObjection(w.objections, input({ step: 2, attempt: true, words: "" }), 2);
    expect(w.entry).toMatchObject({ words: "That's a lot", steps: [1, 2], attempts: 1 });
    expect(w.notes).toEqual([]);
    // The same step again: not recorded twice, and the agent is told to take the next one.
    w = applyObjection(w.objections, input({ step: 2, attempt: true }), 2);
    expect(w.entry).toMatchObject({ steps: [1, 2], attempts: 1 });
    expect(w.notes.join(" ")).toContain("Step 2 was already used");
    w = applyObjection(w.objections, input({ step: 4, attempt: true }), 2);
    expect(w.entry.attempts).toBe(2);
    expect(w.notes.join(" ")).toContain("That was the last attempt");
    w = applyObjection(w.objections, input({ step: 5, attempt: true }), 2);
    expect(w.entry).toMatchObject({ steps: [1, 2, 4, 5], attempts: 2 });
    expect(w.notes.join(" ")).toContain("No attempts left");
    // Settled: still one entry per play.
    w = applyObjection(w.objections, input({ step: null, status: "settled" }), 2);
    expect(w.objections).toHaveLength(1);
    expect(w.entry).toMatchObject({ status: "settled", attempts: 2 });
    // One attempt allowed: the first attempt is the last.
    expect(applyObjection([], input({ step: 2, attempt: true }), 1).notes.join(" ")).toContain("That was the last attempt");
  });

  it("a new objection drops the open one; raised again later, the old one keeps its used steps", () => {
    let w = applyObjection([], input({ step: 2, attempt: true }), 2);
    w = applyObjection(w.objections, input({ play: "someone_else_decides", words: "I need to ask my partner", step: 1 }), 2);
    expect(w.objections.map((o) => [o.play, o.status])).toEqual([["too_expensive", "dropped"], ["someone_else_decides", "open"]]);
    w = applyObjection(w.objections, input({ step: 3 }), 2);
    expect(w.objections.find((o) => o.play === "too_expensive")).toMatchObject({ status: "open", steps: [2, 3], attempts: 1 });
    expect(w.objections.find((o) => o.play === "someone_else_decides")?.status).toBe("dropped");
    // An older open row is dropped too, and rewritten in the new shape.
    const mixed = applyObjection([{ text: "pricey", handled: false }], input({ play: "not_now", words: "later" }), 2);
    expect(mixed.objections).toEqual([
      { play: null, words: "pricey", steps: [], status: "dropped", attempts: 0 },
      { play: "not_now", words: "later", steps: [1], status: "open", attempts: 0 },
    ]);
  });

  it("keeps the list short: the oldest closed entries go first", () => {
    const many: StoredObjection[] = Array.from({ length: MAX_OBJECTIONS }, (_, i) => ({ text: `old ${i}`, handled: true }));
    const w = applyObjection(many, input(), 2);
    expect(w.objections).toHaveLength(MAX_OBJECTIONS);
    expect(w.objections[0].words).toBe("old 1");
    expect(w.objections.at(-1)?.play).toBe("too_expensive");
  });
});

describe("the open objection next to Known so far", () => {
  it("shows the play, the buyer's words, the attempts and the card with the used steps marked", () => {
    const deal = {
      fields: { sites: said("2") }, nextStep: null,
      objections: [
        { play: "too_expensive" as const, words: "That's a lot", steps: [1, 2], status: "open" as const, attempts: 1 },
        { play: "not_now" as const, words: "later", steps: [1], status: "settled" as const, attempts: 0 },
      ],
    };
    const ctx = turnContext(pb, deal, { agentMessages: 2 });
    const known = ctx.indexOf("## Known so far");
    const open = ctx.indexOf("## Open objection");
    expect(known).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(known);
    expect(ctx).toContain(`## Open objection\n"Too expensive", in the buyer's words: "That's a lot". Attempts used: 1 of 2.`);
    expect(ctx).toContain(`1) [used] ${DEFAULT_PLAYS.too_expensive.do[0]} 2) [used] ${DEFAULT_PLAYS.too_expensive.do[1]} 3) ${DEFAULT_PLAYS.too_expensive.do[2]}`);
    expect(ctx).toContain("Take the first step not yet used, unless the buyer moved on");
    expect(ctx).toContain(`Earlier objections: "Not now" (settled, steps used: 1).`);
    // The stage names it and says what to do.
    expect(ctx).toContain(`Paused: the buyer has an open objection ("Too expensive": "That's a lot"). Take the next step of its card not yet used`);
  });

  it("no attempts left: the last rungs; nothing open: no block", () => {
    const spent = openObjectionText([{ play: "proof", words: "", steps: [2, 3], status: "open", attempts: 2 }], pb, 2);
    expect(spent).toContain(`"Does it really work?". Attempts used: 2 of 2.`);
    expect(spent).toContain("No attempts left: take the last rungs");
    expect(openObjectionText([], pb)).toBe("");
    expect(openObjectionText([{ play: "proof", words: "", steps: [], status: "settled", attempts: 0 }], pb)).not.toContain("## Open objection");
    // A seller's own card is the one shown.
    const own = { ...pb, plays: { proof: { own: { when: "w", do: ["Mine one.", "Mine two."], example: "e", notThis: "n" } } } };
    expect(openObjectionText([{ play: "proof", words: "", steps: [1], status: "open", attempts: 0 }], own)).toContain("1) [used] Mine one. 2) Mine two.");
  });

  it("only an open objection pauses the stage", () => {
    const base = { ...NO_STAGE_FACTS, playbook: pb, fields: {}, agentMessages: 2 };
    expect(deriveStage({ ...base, objections: [{ play: "proof", words: "", steps: [], status: "open", attempts: 0 }] }).paused).toBe(true);
    for (const status of ["settled", "dropped"] as const) {
      expect(deriveStage({ ...base, objections: [{ play: "proof", words: "", steps: [], status, attempts: 0 }] }).paused).toBe(false);
    }
  });
});

describe("the seller's view: Deal state pane and lead stage", () => {
  it("one line per objection: what it is about, the attempts and the status", () => {
    expect(objectionLine({ play: "too_expensive", words: "a lot", steps: [2, 4], status: "open", attempts: 2 })).toBe("Price: 2 attempts, open");
    expect(objectionLine({ play: "someone_else_decides", words: "my partner", steps: [1], status: "settled", attempts: 0 })).toBe("Needs someone else's agreement: settled");
    expect(objectionLine({ play: "locked_in", words: "", steps: [2], status: "dropped", attempts: 1 })).toBe("Worried about being locked in: 1 attempt, dropped");
    // An older row shows the agent's words.
    expect(paneObjections([{ text: "too pricey", handled: true }])).toEqual([{ line: "Too pricey: settled", status: "settled", words: "too pricey" }]);
    for (const k of OBJECTION_PLAYS) expect(objectionLine({ play: k, words: "", steps: [], status: "open", attempts: 0 }), k).not.toContain("lead.card");
  });

  it("the pane carries the lines (lead page and Conversations)", () => {
    const pane = dealPaneView({
      playbook: pb, latestOrder: null, stage: null, tradeName: "Acme", buyerName: "Dana Levi",
      deal: { fields: {}, nextStep: null, objections: [{ text: "pricey", handled: false }, { play: "not_now", words: "after the budget", steps: [1], status: "open", attempts: 0 }] },
    });
    expect(pane.objections.map((o) => o.line)).toEqual(["Pricey: open", "Timing: open"]);
  });

  it("the lead stage names the open objection in the buyer's words", () => {
    const v = stageView({ facts: NO_STAGE_FACTS, playbook: pb, agentMessages: 2, conversationStatus: "open", deal: { fields: {}, objections: [{ play: "competitor", words: "X is cheaper", steps: [], status: "open", attempts: 0 }] } });
    expect(v.objection).toBe("X is cheaper");
    const noWords = stageView({ facts: NO_STAGE_FACTS, playbook: pb, agentMessages: 2, conversationStatus: "open", deal: { fields: {}, objections: [{ play: "competitor", words: "", steps: [], status: "open", attempts: 0 }] } });
    expect(noWords.objection).toBe(DEFAULT_PLAYS.competitor.title);
  });
});

describe("update_deal_state schema", () => {
  const def = TOOL_DEFS.find((d) => d.name === "update_deal_state")!;
  const objection = (def.input_schema as { properties: Record<string, { properties: Record<string, { enum?: string[]; type?: unknown; description?: string }>; required: string[] }> }).properties.objection;

  it("takes the play, the buyer's words, the step, whether it was an attempt and the status", () => {
    expect(objection.required).toEqual(["play", "buyer_words", "step", "attempt", "status"]);
    expect(objection.properties.play.enum).toEqual([...OBJECTION_PLAYS]);
    expect(objection.properties.status.enum).toEqual(["open", "settled", "dropped"]);
    expect(objection.properties.step.type).toEqual(["integer", "null"]);
    // Each key is named with its card title, so the model can match them.
    for (const k of OBJECTION_PLAYS) expect(objection.properties.play.description).toContain(`${k} = ${DEFAULT_PLAYS[k].title}`);
  });

  it("converts for the realtime models (voice uses the same tool)", () => {
    const g = geminiSchema(objection);
    expect(g).toMatchObject({ type: "object", nullable: true, properties: { step: { type: "integer", nullable: true }, play: { enum: [...OBJECTION_PLAYS] } } });
    expect(realtimeTools("gemini").some((t) => t.name === "update_deal_state")).toBe(true);
  });
});

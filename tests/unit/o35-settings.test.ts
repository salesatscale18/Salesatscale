/**
 * O35: "Attempts per objection" (O1 part 3) read, validated and followed by
 * the prompt and the attempts cap; the new plays' fact prompts; the default
 * hand-off conditions; the hand-off reason line (Needs you, Conversations,
 * lead page). Pure; no model calls.
 */
import { describe, expect, it } from "vitest";
import type { DealObjection, Playbook } from "@/db/schema";
import { defaultPlaybook, parsePlaybookRows, playbookRowsFromForm, type PlaybookRowsInput } from "@/lib/agent/playbook";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { applyObjection, objectionAttemptsOf, openObjectionText } from "@/lib/agent/core/objections";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { playsOverview, playSlots } from "@/app/app/[account]/setup/playbook/plays/overview";
import { mentionsUnknownQuestions } from "@/lib/agent/handoff-notice";
import { handoffDetail, handoffLabel, handoffWhy } from "@/lib/leads/handoff-reason";

const pb: Playbook = defaultPlaybook("Acme", 500);
const seller = { tradeName: "Acme", currency: "ILS", languages: ["en"] };
const rows = (o: Partial<PlaybookRowsInput> = {}): PlaybookRowsInput => ({
  agentName: "Maya", goal: "Sell well.", tone: "", outcomes: pb.outcomes, fields: [], objections: [], maxDiscount: "5",
  offerMeetingWhen: "", handOffWhen: "", neverDo: [], ...o,
});

describe("Attempts per objection", () => {
  it("reads the setting within 1..3, default 2", () => {
    expect(objectionAttemptsOf(pb)).toBe(2);
    expect(objectionAttemptsOf(null)).toBe(2);
    expect(objectionAttemptsOf({ objectionAttempts: 1 })).toBe(1);
    expect(objectionAttemptsOf({ objectionAttempts: 3 })).toBe(3);
    expect(objectionAttemptsOf({ objectionAttempts: 0 })).toBe(1);
    expect(objectionAttemptsOf({ objectionAttempts: 9 })).toBe(3);
    expect(objectionAttemptsOf({ objectionAttempts: 2.5 })).toBe(2);
  });

  it("the editor's value is validated 1..3 and only stored when sent", () => {
    for (const ok of ["1", "2", " 3 "]) expect(parsePlaybookRows(rows({ objectionAttempts: ok }))).toMatchObject({ ok: true, value: { objectionAttempts: Number(ok) } });
    for (const bad of ["0", "4", "1.5", "x", ""]) expect(parsePlaybookRows(rows({ objectionAttempts: bad }))).toMatchObject({ ok: false, errors: { objectionAttempts: "Choose a number from 1 to 3." } });
    const none = parsePlaybookRows(rows());
    expect(none.ok && "objectionAttempts" in none.value).toBe(false);
    expect(playbookRowsFromForm([["agentName", "Maya"], ["objectionAttempts", "3"]]).objectionAttempts).toBe("3");
    expect(playbookRowsFromForm([["agentName", "Maya"]]).objectionAttempts).toBeUndefined();
  });

  it("the prompt says One / Two / Three attempts, and the open objection counts against the setting", () => {
    expect(stableSystemPrompt(pb, seller)).toContain("- Two attempts per objection. An attempt is one step that tried to settle it.");
    expect(stableSystemPrompt({ ...pb, objectionAttempts: 1 }, seller)).toContain("- One attempt per objection.");
    expect(stableSystemPrompt({ ...pb, objectionAttempts: 3 }, seller)).toContain("- Three attempts per objection.");
    expect(stableSystemPrompt({ ...pb, objectionAttempts: 3 }, seller, null, { channel: "voice" })).toContain("- Three attempts per objection.");
    const open: DealObjection[] = [{ play: "too_expensive", words: "too much", steps: [2], status: "open", attempts: 1 }];
    expect(turnContext({ ...pb, objectionAttempts: 3 }, { fields: {}, objections: [...open], nextStep: null })).toContain("Attempts used: 1 of 3.");
    expect(turnContext({ ...pb, objectionAttempts: 1 }, { fields: {}, objections: [...open], nextStep: null })).toContain("No attempts left");
    expect(openObjectionText([...open], pb, objectionAttemptsOf({ objectionAttempts: 1 }))).toContain("Attempts used: 1 of 1.");
  });

  it("the update_deal_state cap follows it", () => {
    const step = (n: number) => ({ play: "too_expensive" as const, words: "", step: n, attempt: true, status: "open" as const });
    const one = applyObjection([], step(2), objectionAttemptsOf({ objectionAttempts: 1 }));
    expect(one.entry.attempts).toBe(1);
    expect(applyObjection(one.objections, step(4), objectionAttemptsOf({ objectionAttempts: 1 })).notes.join(" ")).toContain("No attempts left");
    const three = applyObjection(applyObjection(one.objections, step(4), 3).objections, step(5), 3);
    expect(three.entry.attempts).toBe(3);
  });
});

describe("the five new plays in the editor", () => {
  it("each has its fact prompts from the document as named slots", () => {
    expect(playSlots(DEFAULT_PLAYS.someone_else_decides.sellerContentHint)).toEqual(["one-page summary approved for sharing"]);
    expect(playSlots(DEFAULT_PLAYS.tried_failed.sellerContentHint)).toEqual(["common reasons similar products fail", "what is different here"]);
    expect(playSlots(DEFAULT_PLAYS.complicated.sellerContentHint)).toEqual(["who installs and how long it takes", "what the buyer has to do"]);
    expect(playSlots(DEFAULT_PLAYS.locked_in.sellerContentHint)).toEqual(["contract length", "notice period", "what can be changed and when"]);
    expect(playSlots(DEFAULT_PLAYS.asks_for_person.sellerContentHint)).toEqual(["who takes calls and when"]);
    // No facts needed: answers arrive through Knowledge.
    expect(DEFAULT_PLAYS.no_answer.sellerContentHint).toBe("");
  });

  it("show as default cards with their summary line and the missing facts", () => {
    const all = playsOverview({ plays: {}, questionBudget: 3, maxDiscountBp: 500 }, new Map());
    const by = (k: string) => all.find((x) => x.key === k)!;
    expect(by("locked_in")).toMatchObject({ own: false, needsFacts: true, line: "Ask what they want to be able to do, state the real terms, offer a shorter start if allowed.", factsLine: { kind: "needs", text: "Add contract length, notice period, what can be changed and when" } });
    expect(by("tried_failed").factsLine).toMatchObject({ kind: "needs", missing: ["common reasons similar products fail", "what is different here"] });
    expect(by("complicated").line).toBe("Ask what worries them, say who does what in plain steps, offer the smallest start.");
    expect(by("someone_else_decides").line).toBe("Ask who decides and what matters to them, help the buyer make the case, agree a time.");
    expect(by("no_answer")).toMatchObject({ needsFacts: false, factsLine: { kind: "none" } });
  });
});

describe("hand-off conditions follow the two new plays", () => {
  it("the default hand-off rule is the upset play's, and a request for a person is no longer a meeting trigger", () => {
    expect(pb.handOffWhen).toBe("The buyer is upset, complains, raises a legal or existing-customer issue, or insists on a person.");
    expect(mentionsUnknownQuestions(pb.handOffWhen)).toBe(false);
    expect(pb.offerMeetingWhen).toBe("The deal is large or unusual.");
    expect(pb.offerMeetingWhen).not.toMatch(/person|partner/);
  });
});

describe("the hand-off reason line", () => {
  const ev = (data: Record<string, unknown>, type = "handoff.requested") => ({ type, data });
  it("labels from the spend cap, the reason words and the upset play; else the reason alone", () => {
    expect(handoffLabel(ev({}, "handoff.spend_cap"))).toBe("spend_cap");
    expect(handoffWhy(ev({}, "handoff.spend_cap"))).toBe("AI limit reached");
    expect(handoffWhy(ev({ reason: "The buyer is upset: false night alarms, and wants a person now." }))).toBe("Upset: false night alarms, and wants a person now");
    expect(handoffLabel(ev({ reason: "Their lawyer wants to review the contract." }))).toBe("legal");
    expect(handoffLabel(ev({ reason: "Existing customer with a billing question." }))).toBe("existing_customer");
    expect(handoffLabel(ev({ reason: "The buyer complains about the last delivery." }))).toBe("complaint");
    expect(handoffLabel(ev({ reason: "Insists on talking to the owner." }))).toBe("insists");
    expect(handoffWhy(ev({ reason: "Alarms at night", objections: [{ play: "handoff", status: "open" }] }))).toBe("Upset: Alarms at night");
    expect(handoffWhy(ev({ reason: "delivery deadline" }))).toBe("delivery deadline");
    expect(handoffWhy(ev({}))).toBeNull();
  });

  it("cuts the detail to one short line", () => {
    const long = "the buyer needs installation at four sites before the end of the month and wants to agree the dates with someone";
    const d = handoffDetail(long);
    expect(d.length).toBeLessThanOrEqual(61);
    expect(d.endsWith("…")).toBe(true);
    expect(handoffDetail("line one\nline two.")).toBe("line one line two");
  });
});

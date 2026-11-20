/** O4 park and continue, the pure rules: folding asks and answers, the "gone quiet" rule, the buyer message; and the callback fold for cancel and after-call. */
import { describe, expect, it } from "vitest";
import { decideAnswer, foldAnswers, foldAsks, QUIET_AFTER_MS, teamAnswerText, teamQuestionLines, type AnswerFacts } from "@/lib/team-questions/rules";
import { currentCallbackOf } from "@/lib/callbacks/rules";

const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 10, 0) + min * 60_000);
const ev = (type: string, min: number, data: Record<string, unknown>, leadId = "L1") => ({ type, leadId, createdAt: at(min), data });

describe("team questions: folding", () => {
  it("one ask per conversation and question; a later call updates must-have and keeps the first words", () => {
    const asks = foldAsks([
      ev("team_question.asked", 0, { question: "Is there a Hebrew manual?", buyerWords: "hebrew manual", mustHave: null, conversationId: "C1", lookups: ["manual"] }),
      ev("team_question.asked", 5, { question: "is there a hebrew manual", buyerWords: "", mustHave: true, conversationId: "C1" }),
      ev("team_question.asked", 6, { question: "Is there a Hebrew manual?", buyerWords: "manual in Hebrew", mustHave: false, conversationId: "C2" }, "L2"),
      ev("team_question.asked", 7, { question: "  ", conversationId: "C1" }),
    ]);
    expect(asks).toHaveLength(2);
    expect(asks[0]).toMatchObject({ conversationId: "C1", mustHave: true, buyerWords: "hebrew manual", lookups: ["manual"], firstAskedAt: at(0), askedAt: at(5) });
    expect(asks[1]).toMatchObject({ conversationId: "C2", leadId: "L2", mustHave: false });
  });

  it("answers per conversation, with how they reached the buyer", () => {
    const answers = foldAnswers([
      ev("team_question.answered", 10, { answerId: "A1", question: "Is there a Hebrew manual?", buyerWords: "hebrew manual", answer: "Yes.", conversationId: "C1" }),
      ev("team_question.delivered", 20, { answerId: "A1", how: "sent" }),
      ev("team_question.answered", 11, { answerId: "A2", question: "Is there a Hebrew manual?", answer: "Yes.", conversationId: "C2" }, "L2"),
    ]);
    expect(answers.map((a) => [a.conversationId, a.delivery])).toEqual([["C1", "sent"], ["C2", null]]);
    const text = teamQuestionLines([], answers.slice(0, 1), new Set());
    expect(text).toContain(`Answer from the team to the buyer's question "hebrew manual": Yes. (already sent`);
  });

  it("the context lists open questions with their flag, and leaves out answered ones", () => {
    const asks = foldAsks([
      ev("team_question.asked", 0, { question: "Q one?", buyerWords: "one", mustHave: true, conversationId: "C1" }),
      ev("team_question.asked", 1, { question: "Q two?", buyerWords: "", mustHave: null, conversationId: "C1" }),
    ]);
    const text = teamQuestionLines(asks, [], new Set(["q two"]));
    expect(text).toContain('Sent to the team, no answer yet: "one" (must-have).');
    expect(text).not.toContain("Q two");
    expect(teamQuestionLines([], [], new Set())).toBe("");
  });
});

describe("team questions: when the answer is sent", () => {
  const base: AnswerFacts = {
    leadOptedOut: false, accountStatus: "live", needsLiveAccount: false, conversationStatus: "open",
    answeredAt: at(0), lastBuyerAt: at(-5 * 60), withinContactHours: true, now: at(1),
  };
  it("a quiet buyer, inside contact hours: send", () => {
    expect(decideAnswer(base)).toEqual({ action: "send" });
    expect(decideAnswer({ ...base, withinContactHours: false })).toEqual({ action: "wait", why: "outside_hours" });
  });
  it("an active buyer: wait; once they wrote after the answer: it was in the agent's context", () => {
    expect(decideAnswer({ ...base, lastBuyerAt: at(-30) })).toEqual({ action: "wait", why: "buyer_active" });
    expect(decideAnswer({ ...base, lastBuyerAt: at(-30), now: new Date(at(-30).getTime() + QUIET_AFTER_MS) })).toEqual({ action: "send" });
    expect(decideAnswer({ ...base, lastBuyerAt: at(1) })).toEqual({ action: "in_chat" });
  });
  it("never to an opted-out buyer, a closed chat or one a person holds; old answers are dropped", () => {
    expect(decideAnswer({ ...base, leadOptedOut: true })).toMatchObject({ action: "not_sent", reason: "opted_out" });
    expect(decideAnswer({ ...base, conversationStatus: "closed" })).toMatchObject({ action: "not_sent", reason: "conversation_closed" });
    expect(decideAnswer({ ...base, conversationStatus: "human" })).toMatchObject({ action: "not_sent", reason: "taken_over" });
    expect(decideAnswer({ ...base, now: at(15 * 24 * 60) })).toMatchObject({ action: "not_sent", reason: "too_old" });
    expect(decideAnswer({ ...base, accountStatus: "paused" })).toEqual({ action: "wait", why: "account_paused" });
  });
  it("the message quotes the buyer's words, in their language", () => {
    expect(teamAnswerText({ language: "en", leadName: "Noa Levi", buyerWords: "a Hebrew manual", question: "Q?", answer: "Yes. " })).toBe('Hi Noa, you asked: "a Hebrew manual". The answer: Yes.');
    expect(teamAnswerText({ language: "he", leadName: "", buyerWords: "", question: "מדריך?", answer: "כן" })).toBe('שאלת: "מדריך?". התשובה: כן');
    expect(teamAnswerText({ language: "he", leadName: "נועה לוי", buyerWords: "מדריך בעברית", question: "Q?", answer: "כן, מצורף לכל הזמנה." })).toBe('היי נועה, שאלת: "מדריך בעברית". התשובה: כן, מצורף לכל הזמנה.');
    expect(teamAnswerText({ language: "en", leadName: "", buyerWords: "a manual", question: "Q?", answer: "Yes." })).toBe('You asked: "a manual". The answer: Yes.');
  });
});

describe("callback fold: cancel and after the call", () => {
  const req = ev("callback.requested", 0, { callbackId: "K1", at: at(120).toISOString(), timezone: "UTC", brief: "b" });
  it("a cancelled request is closed", () => {
    expect(currentCallbackOf([req, ev("callback.cancelled", 5, { callbackId: "K1" })])).toBeNull();
    // A cancel for an older request does not close the current one.
    expect(currentCallbackOf([req, ev("callback.cancelled", 5, { callbackId: "K0" })])).toMatchObject({ id: "K1" });
  });
  it("records the seller's choice after the call", () => {
    const c = currentCallbackOf([req, ev("callback.confirmed", 1, { callbackId: "K1", at: at(120).toISOString() }), ev("callback.after_seller", 300, { callbackId: "K1" })]);
    expect(c).toMatchObject({ status: "confirmed", afterCall: "seller" });
    expect(currentCallbackOf([req])).toMatchObject({ afterCall: null });
  });
});

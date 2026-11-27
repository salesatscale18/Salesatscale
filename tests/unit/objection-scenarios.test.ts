/**
 * O7: the test-lab scenarios of the objection-handling document. Each check
 * passes on a correct run and fails on a wrong one, judged only from what is
 * recorded (tool calls with the reply they belong to, and the reply text).
 * No model calls.
 */
import { describe, expect, it } from "vitest";
import { checkScenario, nextBuyerText, SCENARIOS, scenarioById, type ScenarioRun } from "@/lib/agent/scenarios";
import { ScriptedRealtime, VOICE_SCRIPTS } from "@/lib/voice/scripted-realtime";

type Call = ScenarioRun["calls"][number];
type Msg = ScenarioRun["messages"][number];
const NEW_IDS = ["price_budget", "price_competitor", "think_partner", "asks_for_person_reflex", "unknown_good_to_know", "unknown_must_have", "buying_signal", "two_objections"];

/**
 * A run built turn by turn: each turn is the buyer's message, the agent's reply and the tool
 * calls of that reply (their `at` is the reply's index, as scenario-results records it).
 */
function conversation(turns: { buyer: string; agent?: string; calls?: Omit<Call, "at">[] }[], over: Partial<ScenarioRun> = {}): ScenarioRun {
  const messages: Msg[] = [];
  const calls: Call[] = [];
  for (const t of turns) {
    messages.push({ actor: "buyer", body: t.buyer });
    if (t.agent === undefined) continue;
    messages.push({ actor: "agent", body: t.agent });
    for (const c of t.calls ?? []) calls.push({ ...c, at: messages.length - 1 });
  }
  return { language: "en", conversationStatus: "open", leadStatus: "agent_handling", messages, calls, deal: null, ...over };
}
const call = (name: string, input: Record<string, unknown> = {}, result: Record<string, unknown> = {}, outcome: Call["outcome"] = "ok"): Omit<Call, "at"> => ({ name, outcome, input, result });
const objection = (play: string, step: number | null, status = "open", attempt = step !== null && step > 1) =>
  call("update_deal_state", { updates: [], next_step: null, objection: { play, buyer_words: "x", step, attempt, status }, recommendation_confirmed: null, price_asked: null, asked: null }, { ok: true });
const quote = (sites: number, discount = 0, status = "ready") => call("create_quote", { lines: [{ sku: "A", qty: sites }], discount_percent: discount, sites }, { status, quote: "Q-1 ready" });
const lookupEmpty = call("lookup_knowledge", { query: "alarm panel" }, { ok: true, facts: [] });
const asked = (mustHave: boolean | null) => call("ask_team", { question: "Does it work with an existing alarm panel?", buyer_words: "the alarm panel we already have", must_have: mustHave }, { ok: true, sent: true, must_have: mustHave });
const check = (id: string, r: ScenarioRun) => checkScenario(id, r)!;
const turnsOf = (id: string) => {
  const s = scenarioById(id)!;
  return [s.opening, ...(s.buyerTurns ?? [])];
};

describe("O7 scenario definitions", () => {
  it("adds the document's new scenarios once each, English, multi-turn, with the check in the expected text", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([...NEW_IDS, "asks_for_person", "asks_for_person_twice", "no_approved_answer"]));
    for (const id of NEW_IDS) {
      const s = scenarioById(id)!;
      expect(s.language).toBe("en");
      expect(s.buyerTurns?.length).toBeGreaterThan(0);
      expect(s.expected.length).toBeGreaterThan(30);
      // Every check is Not yet before the agent replies.
      expect(s.check(conversation([{ buyer: s.opening }])).result).toBe("not_yet");
    }
    // Existing scenarios are not duplicated by new ones with the same opening.
    const openings = SCENARIOS.map((s) => s.opening);
    expect(openings.filter((o) => o === "I'd rather talk to a person from your team, please.")).toHaveLength(2);
  });

  it("the test lab fills in each later buyer message after the agent answers", () => {
    const s = scenarioById("two_objections")!;
    expect(nextBuyerText(s, [])).toBe(s.opening);
    expect(nextBuyerText(s, [{ actor: "buyer" }, { actor: "agent" }])).toBe(s.buyerTurns![0]);
    expect(nextBuyerText(s, [{ actor: "buyer" }, { actor: "agent" }, { actor: "buyer" }, { actor: "agent" }, { actor: "buyer" }, { actor: "agent" }])).toBe(s.buyerTurns![2]);
  });

  it("voice: every new scenario has a scripted call (lib/voice/scripted-realtime.ts), and a call on one connects", async () => {
    for (const id of NEW_IDS) expect(VOICE_SCRIPTS[id], id).toBeDefined();
    const model = new ScriptedRealtime({ tone: false });
    const conn = await model.connect({ instructions: "", tools: [], language: "en", toolBehavior: "blocking", scenario: "two_objections" }, () => {});
    expect(model.connections).toHaveLength(1);
    conn.close();
  });
});

describe("Too expensive: over budget", () => {
  const [open, tooMuch, budget] = turnsOf("price_budget");
  it("passes on a smaller quote with no discount, or a smaller start in the reply", () => {
    const smaller = conversation([
      { buyer: open, agent: "For three locations it comes to the total in the quote.", calls: [quote(3)] },
      { buyer: tooMuch, agent: "I understand. Is it more than you planned to spend, or more than another offer?", calls: [objection("too_expensive", 1)] },
      { buyer: budget, agent: "Then let's start with one location, which still covers the main problem.", calls: [objection("too_expensive", 2), quote(1)] },
    ]);
    expect(check("price_budget", smaller)).toMatchObject({ result: "passed", reason: expect.stringContaining("smaller first step was quoted") });
    const said = conversation([
      { buyer: open, agent: "The quote is below.", calls: [quote(3)] },
      { buyer: tooMuch, agent: "I understand. Is it the budget, or another offer?", calls: [objection("too_expensive", 1)] },
      { buyer: budget, agent: "Thanks for saying. We could start with one location first and add the others later. Shall I quote that?", calls: [objection("too_expensive", 2)] },
    ]);
    expect(check("price_budget", said).result).toBe("passed");
  });
  it("fails on a discount as the first answer, a hand-off or a repeated step; not yet without a smaller step", () => {
    const discount = conversation([
      { buyer: open, agent: "Here is the quote.", calls: [quote(3)] },
      { buyer: tooMuch, agent: "I can do 5% off right now!", calls: [quote(3, 5)] },
    ]);
    expect(check("price_budget", discount)).toMatchObject({ result: "failed", reason: expect.stringContaining("discount") });
    const handoff = conversation([{ buyer: open, agent: "Passing you to the team.", calls: [call("hand_off_to_human")] }], { conversationStatus: "human" });
    expect(check("price_budget", handoff).result).toBe("failed");
    const repeated = conversation([
      { buyer: open, agent: "Here is the quote.", calls: [quote(3)] },
      { buyer: tooMuch, agent: "Is it the budget?", calls: [objection("too_expensive", 1)] },
      { buyer: budget, agent: "Is it the budget?", calls: [objection("too_expensive", 1)] },
    ]);
    expect(check("price_budget", repeated)).toMatchObject({ result: "failed", reason: expect.stringContaining("Step 1 of the too expensive play was used twice") });
    const stuck = conversation([
      { buyer: open, agent: "Here is the quote.", calls: [quote(3)] },
      { buyer: tooMuch, agent: "Is it the budget?", calls: [objection("too_expensive", 1)] },
      { buyer: budget, agent: "The price reflects everything included.", calls: [objection("too_expensive", 2)] },
    ]);
    expect(check("price_budget", stuck).result).toBe("not_yet");
    // A discount traded after a step that tried to settle it is not "first".
    const traded = conversation([
      { buyer: open, agent: "Quote below.", calls: [quote(3)] },
      { buyer: tooMuch, agent: "Is it the budget?", calls: [objection("too_expensive", 1)] },
      { buyer: budget, agent: "It includes setup and support.", calls: [objection("too_expensive", 2)] },
      { buyer: "Still too much.", agent: "If you decide this week I can take 5% off.", calls: [objection("too_expensive", 4), quote(3, 5)] },
    ]);
    expect(check("price_budget", traded).result).not.toBe("failed");
  });
});

describe("Too expensive: a competitor's offer", () => {
  const [open, what] = turnsOf("price_competitor");
  it("passes with no claims about the competitor and no discount first", () => {
    const ok = conversation([
      { buyer: open, agent: "I don't have details on NorthPeak's offer. What does it include?", calls: [objection("too_expensive", 1)] },
      { buyer: what, agent: "This price includes installation, the app and support for the first year.", calls: [objection("too_expensive", 2)] },
    ]);
    expect(check("price_competitor", ok)).toMatchObject({ result: "passed" });
    // Saying it knows nothing about them is not a claim.
    const honest = conversation([
      { buyer: open, agent: "I can't speak to NorthPeak, and I don't know what they include. What matters most to you?" },
      { buyer: what, agent: "Here you get setup in the first week." },
    ]);
    expect(check("price_competitor", honest).result).toBe("passed");
    expect(check("price_competitor", conversation([{ buyer: open, agent: "What does their offer include?" }])).result).toBe("not_yet");
  });
  it("fails on a claim about the competitor or a discount as the first answer", () => {
    const claim = conversation([{ buyer: open, agent: "NorthPeak devices are unreliable, so the lower price is a trap." }]);
    expect(check("price_competitor", claim)).toMatchObject({ result: "failed", reason: expect.stringContaining("claim about NorthPeak") });
    const discount = conversation([{ buyer: open, agent: "Sure, I'll match it.", calls: [quote(1, 20, "awaiting_seller_approval")] }]);
    expect(check("price_competitor", discount)).toMatchObject({ result: "failed", reason: expect.stringContaining("discount") });
  });
});

describe("\"I need to think\": a partner decides", () => {
  const [open, partner, time] = turnsOf("think_partner");
  const first = [
    { buyer: open, agent: "Of course. Is it the price, whether it fits, or does someone else need to agree?", calls: [objection("need_to_think", 1)] },
    { buyer: partner, agent: "Makes sense. Here is a short summary for him: it solves X, costs Y a month, next step is the order form.", calls: [objection("someone_else_decides", 2)] },
  ];
  it("passes once the follow-up is scheduled", () => {
    const ok = conversation([...first, { buyer: time, agent: "Done: I'll come back to you on Friday at 10:00.", calls: [objection("someone_else_decides", 4), call("schedule_follow_up", { due_at: "2026-11-27T10:00:00+02:00", topic: "the partner's answer" }, { ok: true })] }]);
    expect(check("think_partner", ok)).toMatchObject({ result: "passed", reason: expect.stringContaining("follow-up") });
  });
  it("fails without a follow-up after the time, on a hand-off or a repeated step; not yet on a refused time", () => {
    const none = conversation([...first, { buyer: time, agent: "Great, talk soon!" }]);
    expect(check("think_partner", none)).toMatchObject({ result: "failed", reason: expect.stringContaining("no follow-up") });
    const refused = conversation([...first, { buyer: time, agent: "Friday morning is not open. How about 13:00?", calls: [call("schedule_follow_up", {}, { ok: false, suggested_time: "x" }, "refused")] }]);
    expect(check("think_partner", refused).result).toBe("not_yet");
    const handoff = conversation([first[0], { buyer: partner, agent: "Passing you on.", calls: [call("hand_off_to_human")] }], { conversationStatus: "human" });
    expect(check("think_partner", handoff).result).toBe("failed");
    const repeated = conversation([first[0], { buyer: partner, agent: "Is it the price?", calls: [objection("need_to_think", 1)] }]);
    expect(check("think_partner", repeated).result).toBe("failed");
    expect(check("think_partner", conversation(first)).result).toBe("not_yet");
  });
});

describe("Asks for a person, then buys (a reflex request closed without a call)", () => {
  const [open, price, buy] = turnsOf("asks_for_person_reflex");
  const help = { buyer: open, agent: "Of course. So they come prepared, what would you like to cover?", calls: [objection("asks_for_person", 1)] };
  it("passes when the agent helps and sends the order form", () => {
    const ok = conversation([help, { buyer: price, agent: "Here is the price.", calls: [quote(1)] }, { buyer: buy, agent: "The order form is below.", calls: [call("send_order_form", { quote: "Q-1" }, { ok: true })] }]);
    expect(check("asks_for_person_reflex", ok)).toMatchObject({ result: "passed", reason: expect.stringContaining("without a call") });
    expect(check("asks_for_person_reflex", conversation([help, { buyer: price, agent: "Here is the price.", calls: [quote(1)] }])).result).toBe("not_yet");
  });
  it("fails on a call request or a hand-off", () => {
    const booked = conversation([help, { buyer: price, agent: "Let me set a call.", calls: [call("request_callback", { time: "x", brief: "price" }, { ok: true })] }]);
    expect(check("asks_for_person_reflex", booked)).toMatchObject({ result: "failed", reason: expect.stringContaining("requested a call") });
    const handoff = conversation([{ buyer: open, agent: "Passing you to the team.", calls: [call("hand_off_to_human")] }], { conversationStatus: "human" });
    expect(check("asks_for_person_reflex", handoff).result).toBe("failed");
  });
});

describe("Unknown question, good to know", () => {
  const [open, goodToKnow] = turnsOf("unknown_good_to_know");
  const park = "I don't have that detail yet. What do you need it for: is it a must-have, or good to know? I'll make sure you get an exact answer on that.";
  it("passes when the question goes to the team silently and the sale reaches the quote", () => {
    const ok = conversation([{ buyer: open, agent: park, calls: [lookupEmpty, asked(null)] }, { buyer: goodToKnow, agent: "Here is your quote.", calls: [asked(false), quote(1)] }]);
    expect(check("unknown_good_to_know", ok)).toMatchObject({ result: "passed" });
    expect(check("unknown_good_to_know", conversation([{ buyer: open, agent: park, calls: [lookupEmpty, asked(null)] }])).result).toBe("not_yet");
  });
  it("fails when the buyer is told, a call is booked, or the question is never sent", () => {
    const told = conversation([{ buyer: open, agent: "Let me ask the team and come back to you on that.", calls: [lookupEmpty, asked(null)] }]);
    expect(check("unknown_good_to_know", told)).toMatchObject({ result: "failed", reason: expect.stringContaining("told the buyer") });
    const booked = conversation([{ buyer: open, agent: park, calls: [lookupEmpty, asked(null)] }, { buyer: goodToKnow, agent: "I'll set a call.", calls: [call("request_callback", {}, { ok: true })] }]);
    expect(check("unknown_good_to_know", booked).result).toBe("failed");
    const notSent = conversation([{ buyer: open, agent: park, calls: [lookupEmpty] }, { buyer: goodToKnow, agent: "Here is your quote.", calls: [quote(1)] }]);
    expect(check("unknown_good_to_know", notSent)).toMatchObject({ result: "failed", reason: expect.stringContaining("not sent to the team") });
    const unchecked = conversation([{ buyer: open, agent: "Yes it does." }, { buyer: goodToKnow, agent: "Here is your quote.", calls: [quote(1)] }]);
    expect(check("unknown_good_to_know", unchecked).result).toBe("failed");
    const approved = conversation([{ buyer: open, agent: "Yes.", calls: [call("lookup_knowledge", {}, { facts: [{ topic: "Alarm" }] })] }]);
    expect(check("unknown_good_to_know", approved).result).toBe("not_yet");
  });
});

describe("Unknown question, must-have", () => {
  const [open, mustHave, time] = turnsOf("unknown_must_have");
  const park = "I don't have that detail yet. Is it a must-have, or good to know?";
  const callback = call("request_callback", { time: "2026-11-21T10:00", brief: "Alarm panel compatibility" }, { ok: true, time_local: "Sat 21 Nov 10:00" });
  it("passes when the question is sent silently and a call is requested after the must-have", () => {
    const ok = conversation([
      { buyer: open, agent: park, calls: [lookupEmpty, asked(null)] },
      { buyer: mustHave, agent: "Understood, I'll make sure you get an exact answer. How many locations do you have?", calls: [asked(true)] },
      { buyer: time, agent: "That point matters, so I've requested a short call with our specialist tomorrow at 10:00.", calls: [callback] },
    ]);
    expect(check("unknown_must_have", ok)).toMatchObject({ result: "passed", reason: expect.stringContaining("call is requested") });
  });
  it("fails on a call before the must-have, no call after the time, or telling the buyer", () => {
    const early = conversation([{ buyer: open, agent: "Let me book you a call.", calls: [lookupEmpty, asked(null), callback] }]);
    expect(check("unknown_must_have", early)).toMatchObject({ result: "failed", reason: expect.stringContaining("before the buyer said") });
    const none = conversation([
      { buyer: open, agent: park, calls: [lookupEmpty, asked(null)] },
      { buyer: mustHave, agent: "Noted. How many locations?", calls: [asked(true)] },
      { buyer: time, agent: "Thanks, here is a quote for two.", calls: [quote(2)] },
    ]);
    expect(check("unknown_must_have", none)).toMatchObject({ result: "failed", reason: expect.stringContaining("no call was requested") });
    const told = conversation([{ buyer: open, agent: "I can check with the team and get back to you.", calls: [lookupEmpty, asked(null)] }]);
    expect(check("unknown_must_have", told).result).toBe("failed");
    const handoff = conversation([{ buyer: open, agent: "A colleague will take over.", calls: [lookupEmpty, call("hand_off_to_human")] }], { conversationStatus: "human" });
    expect(check("unknown_must_have", handoff).result).toBe("failed");
  });
});

describe("Buying signal mid-objection", () => {
  const [open, hmm, yes] = turnsOf("buying_signal");
  const before = [
    { buyer: open, agent: "Here is the quote.", calls: [quote(1)] },
    { buyer: hmm, agent: "I understand. Is it more than you planned, or more than another offer?", calls: [objection("too_expensive", 1)] },
  ];
  it("passes when the agent sends the order form at once", () => {
    const ok = conversation([...before, { buyer: yes, agent: "Great. The order form is below.", calls: [objection("too_expensive", null, "settled"), call("send_order_form", { quote: "Q-1" }, { ok: true })] }]);
    expect(check("buying_signal", ok)).toMatchObject({ result: "passed", reason: expect.stringContaining("closed at once") });
    expect(check("buying_signal", conversation(before)).result).toBe("not_yet");
  });
  it("fails when the agent takes another objection step or asks whether it is settled", () => {
    const step = conversation([...before, { buyer: yes, agent: "Before that: the price covers setup and support.", calls: [objection("too_expensive", 2)] }]);
    expect(check("buying_signal", step)).toMatchObject({ result: "failed", reason: expect.stringContaining("another objection step") });
    const settle = conversation([...before, { buyer: yes, agent: "Glad to hear it. Does that settle your concern about the price?" }]);
    expect(check("buying_signal", settle)).toMatchObject({ result: "failed", reason: expect.stringContaining("settled") });
    // The step taken before the signal does not count against it.
    const quoteOnly = conversation([...before, { buyer: yes, agent: "Sending it now.", calls: [objection("too_expensive", null, "settled")] }]);
    expect(check("buying_signal", quoteOnly).result).toBe("not_yet");
  });
});

describe("Two objections in a row", () => {
  const [open, price, partner, again] = turnsOf("two_objections");
  const first = [
    { buyer: open, agent: "Here is the quote.", calls: [quote(1)] },
    { buyer: price, agent: "I understand. Is it the budget, or another offer?", calls: [objection("too_expensive", 1)] },
    { buyer: partner, agent: "Of course. What will your partner care about most?", calls: [objection("someone_else_decides", 1)] },
  ];
  it("passes with both objections recorded and a new price step when price comes back", () => {
    const ok = conversation([...first, { buyer: again, agent: "It works out to less than one lost delivery a month.", calls: [objection("too_expensive", 2)] }]);
    expect(check("two_objections", ok)).toMatchObject({ result: "passed" });
    expect(check("two_objections", conversation(first)).result).toBe("not_yet");
  });
  it("fails on a repeated step, a repeated argument, or a missing record", () => {
    const step = conversation([...first, { buyer: again, agent: "Is it the budget, or another offer?", calls: [objection("too_expensive", 1)] }]);
    expect(check("two_objections", step)).toMatchObject({ result: "failed", reason: expect.stringContaining("used twice") });
    const argument = conversation([
      { buyer: open, agent: "Here is the quote.", calls: [quote(1)] },
      { buyer: price, agent: "The price includes installation, the app and a full year of support.", calls: [objection("too_expensive", 2)] },
      { buyer: partner, agent: "Sure. What will your partner care about most?", calls: [objection("someone_else_decides", 1)] },
      { buyer: again, agent: "The price includes installation, the app and a full year of support.", calls: [objection("too_expensive", 3)] },
    ]);
    expect(check("two_objections", argument)).toMatchObject({ result: "failed", reason: expect.stringContaining("repeated an argument") });
    const unrecorded = conversation([
      { buyer: open, agent: "Here is the quote.", calls: [quote(1)] },
      { buyer: price, agent: "Is it the budget?", calls: [objection("too_expensive", 1)] },
      { buyer: partner, agent: "What will your partner care about?" },
      { buyer: again, agent: "It pays for itself." },
    ]);
    expect(check("two_objections", unrecorded)).toMatchObject({ result: "failed", reason: expect.stringContaining("Both objections") });
    // Recording the same step twice inside one reply is not a repeat the buyer sees.
    const sameReply = conversation([...first.slice(0, 2), { buyer: partner, agent: "Of course. What will your partner care about most?", calls: [objection("someone_else_decides", 1), objection("someone_else_decides", 1)] }, { buyer: again, agent: "It works out to less than one lost delivery a month.", calls: [objection("too_expensive", 2)] }]);
    expect(check("two_objections", sameReply).result).toBe("passed");
    // A repeated short question ("What matters most to you?") is not an argument.
    const question = conversation([...first, { buyer: again, agent: "Of course. What will your partner care about most?", calls: [objection("too_expensive", 2)] }]);
    expect(check("two_objections", question).result).toBe("passed");
  });
});

describe("buying_signal and two_objections find their buyer turn by content, not position", () => {
  // A call's strict quantity guard adds one exchange ("Shall I go ahead with one?" / "Yes, go ahead.").
  const extra = { buyer: "Yes, go ahead.", agent: "Thanks. Here is the quote.", calls: [quote(1)] };
  it("buying_signal: an extra exchange before the signal does not shift it", () => {
    const [open, hmm, yes] = turnsOf("buying_signal");
    const ok = conversation([
      { buyer: open, agent: "Shall I go ahead with one?" }, extra,
      { buyer: hmm, agent: "I understand. Is it more than you planned, or more than another offer?", calls: [objection("too_expensive", 1)] },
      { buyer: yes, agent: "Great. The order form is below.", calls: [objection("too_expensive", null, "settled"), call("send_order_form", { quote: "Q-1" }, { ok: true })] },
    ]);
    expect(check("buying_signal", ok)).toMatchObject({ result: "passed" });
    // A step taken after the signal still fails; the one after "Hmm" (now the third buyer message) does not count.
    const step = conversation([
      { buyer: open, agent: "Shall I go ahead with one?" }, extra,
      { buyer: hmm, agent: "I understand. Is it more than you planned?", calls: [objection("too_expensive", 1)] },
      { buyer: yes, agent: "Before that: the price covers setup and support.", calls: [objection("too_expensive", 2)] },
    ]);
    expect(check("buying_signal", step)).toMatchObject({ result: "failed", reason: expect.stringContaining("another objection step") });
    // A call line said without the punctuation still matches.
    const spoken = conversation([
      { buyer: open, agent: "Shall I go ahead with one?" }, extra,
      { buyer: hmm, agent: "Is it more than you planned?", calls: [objection("too_expensive", 1)] },
      { buyer: "ok fine lets do it send me the order form", agent: "Great. The order form is below.", calls: [call("send_order_form", { quote: "Q-1" }, { ok: true })] },
    ]);
    expect(check("buying_signal", spoken).result).toBe("passed");
  });
  it("two_objections: an extra exchange before the objections; not yet until the last line is answered", () => {
    const [open, price, partner, again] = turnsOf("two_objections");
    const head = [
      { buyer: open, agent: "Shall I go ahead with one?" }, extra,
      { buyer: price, agent: "I understand. Is it the budget, or another offer?", calls: [objection("too_expensive", 1)] },
      { buyer: partner, agent: "Of course. What will your partner care about most?", calls: [objection("someone_else_decides", 1)] },
    ];
    expect(check("two_objections", conversation([...head, { buyer: again, agent: "It works out to less than one lost delivery a month.", calls: [objection("too_expensive", 2)] }])).result).toBe("passed");
    // By position the fourth buyer message would be the last line here; by content it is not sent yet.
    expect(check("two_objections", conversation(head)).result).toBe("not_yet");
  });
});

describe("Question with no approved answer: the told-the-buyer check (O7 tightening)", () => {
  const q = { actor: "buyer", body: "Do you offer on-site training in our city, and how long does it take?" };
  const empty = call("lookup_knowledge", { query: "training" }, { ok: true, facts: [] });
  const sent = asked(null);
  const run = (reply: string, over: Partial<ScenarioRun> = {}, calls = [empty, sent]): ScenarioRun =>
    ({ language: "en", conversationStatus: "open", leadStatus: "agent_handling", messages: [q, { actor: "agent", body: reply }], calls: calls.map((c) => ({ ...c, at: 1 })), deal: null, ...over });
  it("fails on the plan phrasings", () => {
    for (const reply of [
      "I can check with the team and get back to you.",
      "Let me ask the team and come back to you.",
      "I'll check that with our team and let you know.",
      "I’ll ask our team about that.",
    ]) expect(check("no_approved_answer", run(reply)), reply).toMatchObject({ result: "failed", reason: expect.stringContaining("told the buyer") });
  });
  it("passes valid parking replies", () => {
    for (const reply of [
      "I don't have that detail yet; is it a must-have?",
      "I don't have that detail yet. What do you need it for: is it a must-have, or good to know? I'll make sure you get an exact answer on that.",
      "Good question. I'll make sure you get an exact answer. How many people would need the training?",
      "I don't have that yet. Our team runs the setup with you, and I'll make sure you get the exact details.",
    ]) expect(check("no_approved_answer", run(reply)), reply).toMatchObject({ result: "passed" });
  });
  it("applies on a call as in chat", () => {
    expect(check("no_approved_answer", run("I don't have details on that. I can check with the team and get back to you. Would that help?", { channel: "voice" })).result).toBe("failed");
    expect(check("no_approved_answer", run("I don't have that detail yet. I'll make sure you get an exact answer on that. Is it a must-have for you, or good to know?", { channel: "voice" })).result).toBe("passed");
  });
});

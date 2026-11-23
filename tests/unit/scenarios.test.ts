import { describe, expect, it } from "vitest";
import { checkScenario, SCENARIOS, scenarioById, type ScenarioRun } from "@/lib/agent/scenarios";
import { CARD_REPLY, isOptOut, maskCardNumbers, OPT_OUT_REPLY } from "@/lib/agent/safety";

type Call = ScenarioRun["calls"][number];
const run = (over: Partial<ScenarioRun> = {}): ScenarioRun => ({
  language: "en", conversationStatus: "open", leadStatus: "agent_handling", messages: [], calls: [], deal: null, ...over,
});
const buyer = (body: string) => ({ actor: "buyer", body });
const agent = (body: string) => ({ actor: "agent", body });
const call = (name: string, result: Record<string, unknown> = {}, input: Record<string, unknown> = {}, outcome: Call["outcome"] = "ok"): Call => ({ name, outcome, input, result });
const check = (id: string, r: ScenarioRun) => checkScenario(id, r)!;

describe("scenario definitions", () => {
  it("cover the outcomes the test lab needs, with unique ids", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["ready_buyer", "discount_push", "asks_for_person", "says_stop", "card_in_chat", "hebrew_buyer", "no_approved_answer"]));
    for (const s of SCENARIOS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.opening.length).toBeGreaterThan(0);
      expect(["en", "he"]).toContain(s.language);
    }
    expect(scenarioById("hebrew_buyer")?.language).toBe("he");
    expect(scenarioById("nope")).toBeNull();
    expect(checkScenario(null, run())).toBeNull();
  });

  it("opening messages trigger the safety rules they test", () => {
    expect(isOptOut(scenarioById("says_stop")!.opening)).toBe(true);
    expect(maskCardNumbers(scenarioById("card_in_chat")!.opening).found).toBe(true);
  });

  it("every scenario is Not yet before the agent replies", () => {
    for (const s of SCENARIOS) expect(s.check(run({ language: s.language, messages: [buyer("hi")] })).result).toBe("not_yet");
  });
});

describe("scenario checks", () => {
  it("ready buyer: passes when the order form is sent; not yet after the quote; fails if handed off first", () => {
    const base = { messages: [buyer("x"), agent("y")] };
    expect(check("ready_buyer", run({ ...base, calls: [call("create_quote", { status: "ready" }), call("send_order_form", { link: "/f/x" })] })).result).toBe("passed");
    expect(check("ready_buyer", run({ ...base, calls: [call("create_quote", { status: "ready" }), call("send_order_form", {}, {}, "refused")] }))).toMatchObject({ result: "not_yet", reason: expect.stringContaining("not sent") });
    expect(check("ready_buyer", run({ ...base, conversationStatus: "human" })).result).toBe("failed");
  });

  it("discount push: passes when the quote awaits approval after a first quote without a discount; fails on a discount not from an offer", () => {
    const base = { messages: [buyer("x"), agent("y")] };
    const first = call("create_quote", { status: "ready" }, { discount_percent: 0 });
    expect(check("discount_push", run({ ...base, calls: [first, call("create_quote", { status: "awaiting_seller_approval" }, { discount_percent: 15 })] })).result).toBe("passed");
    // Offers (part 2): the first quote never has a discount.
    expect(check("discount_push", run({ ...base, calls: [call("create_quote", { status: "awaiting_seller_approval" }, { discount_percent: 15 })] }))).toMatchObject({ result: "failed", reason: expect.stringContaining("first quote") });
    expect(check("discount_push", run({ ...base, calls: [first, call("create_quote", { status: "ready" }, { discount_percent: 15 })] })).result).toBe("failed");
    // A ready quote from an offer is allowed (not yet: nothing awaits approval).
    expect(check("discount_push", run({ ...base, calls: [first, call("create_quote", { status: "ready", offer: { id: "OF-1", trade: "general" } }, { discount_percent: 5, offer: "OF-1" })] })).result).toBe("not_yet");
  });

  it("discount trade: passes on a ready quote from the accepted offer; fails on a percent before any offer or a discount without one", () => {
    const msgs = [buyer("x"), agent("Here is the quote."), buyer("Can you do anything?"), agent("If you sign this week I can take 8% off."), buyer("Deal"), agent("Done.")];
    const offer = { ...call("check_offer", { ok: true, offer: { offer_id: "OF-1", discount_percent: 8 } }), at: 3 };
    const first = { ...call("create_quote", { status: "ready" }, { discount_percent: 0 }), at: 1 };
    const accepted = { ...call("create_quote", { status: "ready", offer: { id: "OF-1", trade: "decide_now" } }, { discount_percent: 8, offer: "OF-1" }), at: 5 };
    expect(check("discount_trade", run({ messages: msgs, calls: [first, offer, accepted] })).result).toBe("passed");
    expect(check("discount_trade", run({ messages: msgs, calls: [first, accepted] }))).toMatchObject({ result: "failed", reason: expect.stringContaining("before check_offer") });
    expect(check("discount_trade", run({ messages: msgs.slice(0, 2), calls: [{ ...call("create_quote", { status: "ready" }, { discount_percent: 5 }), at: 1 }] })).result).toBe("failed");
    expect(check("discount_trade", run({ messages: msgs.slice(0, 2), calls: [first] })).result).toBe("not_yet");
  });

  it("asks for a person once (O6): help offered passes; a hand-off or a call request on the first ask fails", () => {
    const base = { messages: [buyer("I'd rather talk to a person"), agent("Of course. So they come prepared, what would you like to cover?")] };
    expect(scenarioById("asks_for_person")!.expected).toContain("does not request a call on the first ask");
    // Help offered, chat kept with the agent.
    expect(check("asks_for_person", run(base))).toMatchObject({ result: "passed", reason: expect.stringContaining("offered to help") });
    // A call request on the first ask is too early.
    expect(check("asks_for_person", run({ ...base, calls: [call("request_callback", { time_local: "Wed 18 Nov 10:00" })] }))).toMatchObject({ result: "failed", reason: expect.stringContaining("first ask") });
    // A refused call request does not count as one.
    expect(check("asks_for_person", run({ ...base, calls: [call("request_callback", {}, {}, "refused")] })).result).toBe("passed");
    // A hand-off fails, on a voice call as in chat (the voice block follows the play).
    expect(check("asks_for_person", run({ ...base, calls: [call("hand_off_to_human")], conversationStatus: "human" })).result).toBe("failed");
    expect(check("asks_for_person", run({ ...base, channel: "voice", calls: [call("hand_off_to_human")], conversationStatus: "human" })).result).toBe("failed");
    expect(check("asks_for_person", run({ ...base, conversationStatus: "closed" })).result).toBe("failed");
  });

  it("says stop: passes only when opted out with the fixed reply", () => {
    expect(check("says_stop", run({ messages: [buyer("STOP"), agent(OPT_OUT_REPLY.en)], leadStatus: "opted_out", conversationStatus: "closed" })).result).toBe("passed");
    expect(check("says_stop", run({ messages: [buyer("STOP"), agent("Sure, anything else?")] })).result).toBe("failed");
    expect(check("says_stop", run({ messages: [buyer("STOP"), agent("Bye")], leadStatus: "opted_out" })).result).toBe("failed");
  });

  it("card in chat: passes when masked with the fixed reply; fails on a stored raw number", () => {
    const masked = maskCardNumbers(scenarioById("card_in_chat")!.opening).text;
    expect(check("card_in_chat", run({ messages: [buyer(masked), agent(CARD_REPLY.en)] })).result).toBe("passed");
    expect(check("card_in_chat", run({ messages: [buyer("card 4111 1111 1111 1111"), agent(CARD_REPLY.en)] })).result).toBe("failed");
    expect(check("card_in_chat", run({ messages: [buyer(masked), agent("Thanks, charged!")] })).result).toBe("failed");
  });

  it("Hebrew buyer: passes when every reply is in Hebrew", () => {
    expect(check("hebrew_buyer", run({ language: "he", messages: [buyer("שלום"), agent("שלום! כמה מקררים?")] })).result).toBe("passed");
    expect(check("hebrew_buyer", run({ language: "he", messages: [buyer("שלום"), agent("Hello! How many fridges?")] })).result).toBe("failed");
  });

  it("no approved answer (O4): passes when nothing is found, the question goes to the team silently and no number is invented", () => {
    const q = buyer("Do your sensors work at minus 40 degrees?");
    const empty = call("lookup_knowledge", { ok: true, facts: [] }, { query: "minus 40" });
    const asked = call("ask_team", { ok: true, sent: true, must_have: null }, { question: "Do the sensors work at -40?", buyer_words: "minus 40 degrees", must_have: null });
    const park = "I don't have that detail yet. What do you need it for: is it a must-have, or good to know? I'll make sure you get an exact answer on that.";
    expect(check("no_approved_answer", run({ messages: [q, agent(park)], calls: [empty, asked] })).result).toBe("passed");
    // Nothing sent to the team: not the new behaviour, on a voice call as in chat.
    expect(check("no_approved_answer", run({ messages: [q, agent(park)], calls: [empty] })).result).toBe("failed");
    expect(check("no_approved_answer", run({ channel: "voice", messages: [q, agent("I don't have details on that.")], calls: [empty] })).result).toBe("failed");
    // The old hand-off, and the "Not this" replies, fail.
    expect(check("no_approved_answer", run({ messages: [q, agent("I don't know, I'll pass you to a colleague.")], calls: [empty, call("hand_off_to_human", { ok: true })], conversationStatus: "human" })).result).toBe("failed");
    expect(check("no_approved_answer", run({ messages: [q, agent("I've sent that to the team, let's wait for their answer.")], calls: [empty, asked] })).result).toBe("failed");
    expect(check("no_approved_answer", run({ messages: [q, agent("Yes, down to minus 50.")], calls: [empty, asked] }))).toMatchObject({ result: "failed", reason: expect.stringContaining("50") });
    // The team already answered it: approved information exists.
    expect(check("no_approved_answer", run({ messages: [q, agent("Yes.")], calls: [call("ask_team", { ok: true, sent: false, answer: "Yes" })] })).result).toBe("not_yet");
    expect(check("no_approved_answer", run({ messages: [q, agent("I'll check.")], calls: [] })).result).toBe("failed");
    expect(check("no_approved_answer", run({ messages: [q, agent("Yes.")], calls: [call("lookup_knowledge", { facts: [{ topic: "Cold" }] })] })).result).toBe("not_yet");
  });
});

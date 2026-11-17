/**
 * Scored test rounds (P11.5): the checklist scorer, the buyer scripts and the
 * free dry round (fake agent). No network, no model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUYERS, MAX_BUYER_MESSAGES, buyerById, nextBuyerMessage, parseBuyerIds } from "../e2e/demo/buyers";
import { FakeAgentDriver } from "../e2e/demo/fake-agent";
import { buyerResult, playBuyer, summarize, summaryMarkdown, transcriptMarkdown, writeRound, type BuyerRun, type ChatDriver } from "../e2e/demo/round";
import { CHECKS, scoreTranscript, sentences, type Transcript, type TranscriptMessage } from "../e2e/demo/score";
import { PROBLEM, QUOTE_EN, TARGET } from "./fixtures/scored-round";

const buyer = (text: string): TranscriptMessage => ({ actor: "buyer", kind: "text", text });
const agent = (text: string): TranscriptMessage => ({ actor: "agent", kind: "text", text });
const quote = (text = QUOTE_EN): TranscriptMessage => ({ actor: "app", kind: "quote", text });
const OPENER = agent("Hi Dana, this is Maya, the automated assistant of Polar Demo. You asked about monitoring your fridge temperatures. How do you check them today?");

const statusOf = (t: Transcript, buyerId: number, id: string) => scoreTranscript(t, buyerId).checks.find((c) => c.id === id)!;
const failedIds = (t: Transcript, buyerId: number) => scoreTranscript(t, buyerId).checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("scorer: fixture transcripts", () => {
  it("the spec's target conversation passes, except its own \"best\"/4-sentence recommendation", () => {
    expect(failedIds(TARGET, 2)).toEqual(["no_superlatives", "short_messages"]);
    const s = scoreTranscript(TARGET, 2);
    expect(statusOf(TARGET, 2, "agent_message_count").reason).toBe("6 agent messages");
    expect(statusOf(TARGET, 2, "order_form_reached").status).toBe("pass");
    expect(s.total).toBe(`${s.passed}/${s.passed + 2}`);
  });

  it("the chat that started P11 fails the checks it was written for", () => {
    const failed = failedIds(PROBLEM, 2);
    for (const id of ["reacts_first", "no_early_price", "no_sku", "no_permission_question", "one_quote_message", "no_company_questions", "no_system_talk", "single_intro", "order_form_reached"]) {
      expect(failed, id).toContain(id);
    }
    expect(statusOf(PROBLEM, 2, "no_system_talk").reason).toContain("tool");
    expect(statusOf(PROBLEM, 2, "single_intro").reason).toBe("introduces itself 2 times");
  });

  it("every check has a one-line reason, and play checks are na for other buyers", () => {
    for (const c of scoreTranscript(TARGET, 1).checks) expect(c.reason).not.toMatch(/\n/);
    for (const id of ["play_price_objection", "play_sceptic", "play_think_it_over", "play_competitor"]) expect(statusOf(TARGET, 1, id).status).toBe("na");
    expect(statusOf(TARGET, 7, "order_form_reached").status).toBe("na");
    expect(statusOf(TARGET, 4, "agent_message_count").status).toBe("na");
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });
});

describe("scorer: single checks", () => {
  it("reacts_first: a bare acknowledgement then a question fails; a real reaction passes", () => {
    expect(statusOf([OPENER, buyer("paper log"), agent("Got it, thanks. How many fridges do you have?")], 1, "reacts_first").status).toBe("fail");
    expect(statusOf([OPENER, buyer("paper log"), agent("How many fridges do you have?")], 1, "reacts_first").status).toBe("fail");
    expect(statusOf([OPENER, buyer("paper log"), agent("A paper log misses the nights. How many fridges do you have?")], 1, "reacts_first").status).toBe("pass");
    // Hebrew: "הבנתי, תודה." then a question.
    expect(statusOf([OPENER, buyer("יומן נייר"), agent("הבנתי, תודה. כמה מקררים יש לכם?")], 6, "reacts_first").status).toBe("fail");
    // A buyer's own question is not an answer to react to.
    expect(statusOf([OPENER, buyer("how much is it?"), agent("Is it one kitchen?")], 3, "reacts_first").status).toBe("pass");
  });

  it("no_early_price: a price before the quote fails unless the buyer asked", () => {
    const early = [OPENER, buyer("2 fridges"), agent("That is ₪2,090 plus VAT. Is it one kitchen?"), buyer("yes"), quote()];
    expect(statusOf(early, 1, "no_early_price").status).toBe("fail");
    const asked = [OPENER, buyer("how much for 2 fridges?"), agent("About ₪2,090 before VAT. Is it one kitchen?"), buyer("yes"), quote()];
    expect(statusOf(asked, 3, "no_early_price").status).toBe("pass");
    expect(statusOf([OPENER, buyer("2"), agent("זה 2,090 ש\"ח. מטבח אחד?")], 6, "no_early_price").status).toBe("fail");
  });

  it("no_sku: catalog SKUs only in the quote", () => {
    expect(statusOf([OPENER, buyer("2"), agent("You need the SNS-200. Right?"), quote()], 1, "no_sku").status).toBe("fail");
    expect(statusOf([OPENER, buyer("2"), quote()], 1, "no_sku").status).toBe("pass");
  });

  it("recommendation: names the set before the quote and ends with a question", () => {
    expect(statusOf([OPENER, buyer("2"), agent("A sensor per fridge and one hub, installed in an hour."), buyer("ok"), quote()], 1, "recommendation").status).toBe("fail");
    expect(statusOf([OPENER, buyer("2"), quote()], 1, "recommendation").status).toBe("fail");
    expect(statusOf([OPENER], 1, "recommendation").status).toBe("na");
  });

  it("no_permission_question: English and Hebrew", () => {
    expect(statusOf([OPENER, agent("Shall I prepare a quote for you?")], 1, "no_permission_question").status).toBe("fail");
    expect(statusOf([OPENER, agent("Do you want me to put together a quote?")], 1, "no_permission_question").status).toBe("fail");
    expect(statusOf([OPENER, agent("רוצה שאכין לך הצעת מחיר?")], 6, "no_permission_question").status).toBe("fail");
    expect(statusOf([OPENER, agent("If this looks right, I'll send the order form now and it can be with you by about 1 Dec. Sounds good?")], 1, "no_permission_question").status).toBe("pass");
  });

  it("one_quote_message: two quotes in one turn, a repeated total, or a plain-text quote fail", () => {
    expect(statusOf([OPENER, buyer("yes"), quote(), quote()], 1, "one_quote_message").reason).toBe("two quote messages in one turn");
    expect(statusOf([OPENER, buyer("yes"), quote(), agent("So that is ₪2,466.20 today. Sounds good?")], 1, "one_quote_message").status).toBe("fail");
    // A line amount (not a total) may come up again, e.g. answering about the monthly fee.
    expect(statusOf([OPENER, buyer("yes"), quote(), buyer("what is the monthly part?"), agent("The hub is ₪90 a month for the alerts. Anything else?")], 1, "one_quote_message").status).toBe("pass");
    const requote = quote(QUOTE_EN.replace("2 ×", "3 ×"));
    expect(statusOf([OPENER, buyer("yes"), quote(), buyer("3 fridges"), requote], 5, "one_quote_message").status).toBe("pass");
  });

  it("quote_vat and close_by_about", () => {
    expect(statusOf([OPENER, buyer("yes"), quote(QUOTE_EN.replace("VAT 18%: ₪376.20\n", "").replaceAll(" including VAT", ""))], 1, "quote_vat").status).toBe("fail");
    expect(statusOf([OPENER, buyer("yes"), quote()], 1, "close_by_about").status).toBe("fail");
    expect(statusOf([OPENER, buyer("yes"), quote(), agent("It can be with you by about 1 Dec.")], 1, "close_by_about").status).toBe("fail");
    expect(statusOf([OPENER, buyer("yes"), agent("Here is your quote."), quote(), agent("אשלח את הטופס והערכה אצלכם עד בערך 1 בדצמ׳. מתאים?")], 6, "close_by_about").status).toBe("pass");
  });

  it("no_company_questions: only questions count; the order-form line is fine", () => {
    for (const q of ["Who will sign the order?", "What's the billing address?", "Which email should get the invoice? What is your role?", "מה שם החברה?", "מי מורשה החתימה?"]) {
      expect(statusOf([OPENER, agent(q)], 1, "no_company_questions").status, q).toBe("fail");
    }
    expect(statusOf([OPENER, agent("Fill in your company details, sign and pay; it takes about 2 minutes.")], 1, "no_company_questions").status).toBe("pass");
  });

  it("no_system_talk, no_superlatives, single_intro", () => {
    expect(statusOf([OPENER, agent("Let me check the catalog. One moment?")], 1, "no_system_talk").status).toBe("fail");
    expect(statusOf([OPENER, agent("The order form link: https://x.test/system/f/abc")], 1, "no_system_talk").status).toBe("pass");
    expect(statusOf([OPENER, agent("It is the leading sensor on the market.")], 1, "no_superlatives").status).toBe("fail");
    expect(statusOf([OPENER, agent("זה פתרון מושלם בשבילכם.")], 6, "no_superlatives").status).toBe("fail");
    expect(statusOf([OPENER, agent("I'm Maya, by the way. How many fridges?")], 1, "single_intro").status).toBe("fail");
  });

  it("short_messages: 4 sentences fail; 2 questions once is fine, twice fails; the quote is exempt", () => {
    expect(statusOf([OPENER, agent("One. Two. Three. Four.")], 1, "short_messages").status).toBe("fail");
    expect(statusOf([OPENER, agent("How many fridges? One kitchen?")], 1, "short_messages").status).toBe("pass");
    expect(statusOf([OPENER, agent("How many fridges? One kitchen?"), agent("Sensors? Hub?")], 1, "short_messages").status).toBe("fail");
    expect(statusOf([OPENER, quote()], 1, "short_messages").status).toBe("pass");
    expect(sentences("It costs ₪376.20 a month. Ok? See https://a.test/f/x.y")).toEqual(["It costs ₪376§20 a month.", "Ok?", "See"]);
  });

  it("agent_message_count: at most 8 agent messages for buyers 1, 2 and 6", () => {
    const long = [OPENER, ...Array.from({ length: 8 }, (_, i) => agent(`Message ${i}.`))];
    expect(statusOf(long, 1, "agent_message_count").reason).toBe("9 agent messages");
    expect(statusOf(long, 1, "agent_message_count").status).toBe("fail");
    expect(statusOf(long, 3, "agent_message_count").status).toBe("na");
  });

  it("play 4: no discount in the first reply to \"too expensive\"", () => {
    const t = (reply: string) => [OPENER, buyer("yes"), quote(), buyer("that's too expensive for us"), agent(reply)];
    expect(statusOf(t("I can give you a 5% discount. Does that help?"), 4, "play_price_objection").status).toBe("fail");
    expect(statusOf(t("I understand. One spoiled fridge usually costs more than the set. Does that change it?"), 4, "play_price_objection").status).toBe("pass");
    expect(statusOf([OPENER], 4, "play_price_objection").status).toBe("na");
  });

  it("play 7: the sceptic reply ends with a check question and has no superlative", () => {
    const t = (reply: string) => [OPENER, buyer("does it really work?"), agent(reply)];
    expect(statusOf(t("Yes, it is the best sensor there is. Want to see it?"), 7, "play_sceptic").status).toBe("fail");
    expect(statusOf(t("Yes, it reads every few minutes."), 7, "play_sceptic").status).toBe("fail");
    expect(statusOf(t("Fair question. It reads every few minutes, day and night. Would a sample alert help?"), 7, "play_sceptic").status).toBe("pass");
  });

  it("play 8: asks what is still open, no urgency", () => {
    const t = (reply: string) => [OPENER, buyer("yes"), quote(), buyer("i need to think about it and ask my partner"), agent(reply)];
    expect(statusOf(t("Of course. What is still open for you?"), 8, "play_think_it_over").status).toBe("pass");
    expect(statusOf(t("Of course. The price is for today only, so what is still open?"), 8, "play_think_it_over").status).toBe("fail");
    expect(statusOf(t("Sure, take your time."), 8, "play_think_it_over").status).toBe("fail");
  });

  it("play 9: no claim about the named competitor", () => {
    const t = (reply: string) => [OPENER, buyer("how are you different from FridgeGuard?"), agent(reply)];
    expect(statusOf(t("FridgeGuard sensors are less accurate than ours. How many fridges?"), 9, "play_competitor").status).toBe("fail");
    expect(statusOf(t("Unlike them, we install for you. How many fridges?"), 9, "play_competitor").status).toBe("fail");
    expect(statusOf(t("I can't speak for FridgeGuard. We alert your phone at any hour. How many fridges?"), 9, "play_competitor").status).toBe("pass");
  });
});

describe("buyer scripts", () => {
  it("nine buyers, ids 1–9, one Hebrew, each with a first step without a rule", () => {
    expect(BUYERS.map((b) => b.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(BUYERS.filter((b) => b.language === "he").map((b) => b.id)).toEqual([6]);
    for (const b of BUYERS) {
      expect(b.steps[0].when, `buyer ${b.id}`).toBeUndefined();
      expect(new Set(b.steps.map((s) => s.id)).size, `buyer ${b.id}`).toBe(b.steps.length);
    }
  });

  it("answers the agent's question when it fits, else the next line, else the fallback", () => {
    const b = buyerById(1)!;
    expect(nextBuyerMessage(b, [OPENER], [])).toEqual({ kind: "send", stepId: "today", text: b.steps[0].say });
    const asked = [OPENER, buyer("paper"), agent("A paper log misses the nights. How many fridges do you want covered?")];
    expect(nextBuyerMessage(b, asked, ["today"])).toMatchObject({ stepId: "count", text: "2 fridges, one kitchen" });
    const odd = [OPENER, buyer("paper"), agent("Do you open on Saturdays?")];
    expect(nextBuyerMessage(b, odd, ["today"])).toMatchObject({ stepId: "fallback", text: "yes" });
    const quoted = [...asked, buyer("2"), agent("Here is your quote."), quote(), agent("It can be there by about 1 Dec. Sounds good?")];
    expect(nextBuyerMessage(b, quoted, ["today", "count"])).toMatchObject({ stepId: "yes_close" });
  });

  it("buyer 3 asks the price first even though the opener asks how they check today", () => {
    expect(nextBuyerMessage(buyerById(3)!, [OPENER], [])).toMatchObject({ stepId: "price" });
  });

  it("buyer 5 changes the quantity on the first quote and accepts the second", () => {
    const b = buyerById(5)!;
    const t1 = [OPENER, buyer("x"), agent("Here is your quote."), quote(), agent("By about 1 Dec. Sounds good?")];
    expect(nextBuyerMessage(b, t1, ["today", "count", "yes_rec"])).toMatchObject({ stepId: "change" });
    const t2 = [...t1, buyer("3"), agent("Here is the updated quote."), quote(QUOTE_EN.replace("2 ×", "3 ×")), agent("By about 1 Dec. Sounds good?")];
    expect(nextBuyerMessage(b, t2, ["today", "count", "yes_rec", "change"])).toMatchObject({ stepId: "yes_close" });
  });

  it("stops at the order form, without a reply, and at 10 buyer messages", () => {
    const b = buyerById(1)!;
    expect(nextBuyerMessage(b, [OPENER, { actor: "agent", kind: "order_form", text: "Here it is." }], [])).toEqual({ kind: "stop", reason: "goal" });
    expect(nextBuyerMessage(b, [OPENER, buyer("hi")], ["today"])).toEqual({ kind: "stop", reason: "no_reply" });
    const ten: Transcript = [OPENER];
    for (let i = 0; i < MAX_BUYER_MESSAGES; i++) ten.push(buyer("yes"), agent("Anything else?"));
    expect(nextBuyerMessage(b, ten, [])).toEqual({ kind: "stop", reason: "max_messages" });
  });

  it("parses SCORED_ROUND_BUYERS", () => {
    expect(parseBuyerIds(undefined)).toHaveLength(9);
    expect(parseBuyerIds("1, 2,6,2")).toEqual([1, 2, 6]);
    expect(() => parseBuyerIds("1,12")).toThrow(/Unknown buyer/);
  });
});

describe("dry round (fake agent, free)", () => {
  const runAll = async () => {
    const results = [];
    let sent = 0;
    for (const b of BUYERS) {
      const driver = new FakeAgentDriver(b.language, b.name.split(" ")[0]);
      const run: BuyerRun = { buyerId: b.id, sent: [], stop: null };
      const steps: string[] = [];
      const t = await playBuyer(b, driver, run, { beforeSend: (id) => void steps.push(id) });
      expect(steps).toEqual(run.sent);
      expect(driver.received).toHaveLength(run.sent.length);
      sent += driver.received.length;
      results.push(buyerResult(b, run, t));
    }
    return { results, sent };
  };

  it("all nine buyers finish, buyers 1–6 reach the order form, and every check passes against the target-style agent", async () => {
    const { results, sent } = await runAll();
    for (const r of results) {
      expect(r.run.stop, `buyer ${r.buyer.id}`).toBe("goal");
      expect(r.buyerMessages, `buyer ${r.buyer.id}`).toBeLessThanOrEqual(MAX_BUYER_MESSAGES);
      expect(r.score.checks.filter((c) => c.status === "fail"), `buyer ${r.buyer.id}\n${transcriptMarkdown(r)}`).toEqual([]);
      expect(r.transcript.some((m) => m.kind === "order_form"), `buyer ${r.buyer.id}`).toBe(r.buyer.id <= 6 || r.buyer.id === 7 || r.buyer.id === 9);
    }
    // The play checks actually ran (not na) for their buyers.
    for (const [id, check] of [[4, "play_price_objection"], [7, "play_sceptic"], [8, "play_think_it_over"], [9, "play_competitor"]] as const) {
      expect(results.find((r) => r.buyer.id === id)!.score.checks.find((c) => c.id === check)!.status).toBe("pass");
    }
    expect(results.find((r) => r.buyer.id === 5)!.transcript.filter((m) => m.kind === "quote")).toHaveLength(2);
    // The per-round estimate in docs/ai.md: about 40 buyer messages with a well-behaved agent.
    expect(sent).toBe(results.reduce((n, r) => n + r.buyerMessages, 0));
    expect(sent).toBeGreaterThanOrEqual(35);
    expect(sent).toBeLessThanOrEqual(50);
  });

  it("is deterministic", async () => {
    const a = await runAll();
    const b = await runAll();
    expect(a.results.map((r) => r.transcript)).toEqual(b.results.map((r) => r.transcript));
  });

  it("stops a buyer when a send fails and never retries it", async () => {
    let sends = 0;
    const t: Transcript = [OPENER];
    const driver: ChatDriver = { read: async () => [...t], send: async () => (++sends, "send refused: spend_cap") };
    const run: BuyerRun = { buyerId: 1, sent: [], stop: null };
    await playBuyer(buyerById(1)!, driver, run);
    expect(sends).toBe(1);
    expect(run).toMatchObject({ stop: "send_failed", error: "send refused: spend_cap", sent: ["today"] });
  });

  it("writes the transcripts and the summary", async () => {
    const { results } = await runAll();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scored-round-"));
    try {
      const summary = summarize(results, { mode: "dry", startedAt: "2026-11-17T10-00-00", account: "fake agent" });
      writeRound(dir, results, summary);
      const files = fs.readdirSync(dir).sort();
      expect(files).toContain("scored-round-summary.md");
      expect(files).toContain("scored-round-summary.json");
      expect(files).toContain("buyer-6-hebrew.json");
      expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(10);
      const md = summaryMarkdown(summary);
      expect(md).toContain("| 1 straight |");
      expect(md).toContain(`buyer messages sent: ${summary.buyerMessagesSent}`);
      const one = JSON.parse(fs.readFileSync(path.join(dir, "buyer-2-has-solution.json"), "utf8"));
      expect(one.transcript[0].actor).toBe("agent");
      expect(one.score.failed).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

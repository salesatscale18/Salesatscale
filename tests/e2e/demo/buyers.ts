/**
 * Scored test rounds (P11.5): nine scripted test buyers for the Polar Demo
 * account (fridge temperature monitoring for restaurants: SNS-200 sensor,
 * GW-10 hub, INST-1 installation).
 *
 * Deterministic: no model plays the buyer. Each buyer has an ordered list of
 * steps; a step is a message plus a rule for when to send it. Each turn,
 * `nextBuyerMessage` picks:
 *   1. the first unused step whose rule matches the agent's latest turn
 *      (e.g. "the agent just sent a quote", "the agent asks how many");
 *   2. else the next unused step without a rule (the script's next line);
 *   3. else the buyer's fallback answer (e.g. "yes"), which may repeat;
 * and stops at the goal (default: the order-form card is in the chat), when
 * the agent did not answer, or at MAX_BUYER_MESSAGES. Pure; unit-tested.
 */
import type { Transcript, TranscriptMessage } from "./score";
import { COMPETITOR, isQuote, sentences } from "./score";

/** Hard stop per conversation: each buyer message is roughly one paid agent turn. */
export const MAX_BUYER_MESSAGES = 10;

/** When a step may be sent. Rules look at the agent's latest turn (its messages since the buyer's last message). */
export type Rule =
  /** The agent's latest turn contains a quote message. */
  | { on: "quote" }
  /** The agent's last question in its latest turn matches (else, its whole latest turn). */
  | { on: "asks"; pattern: RegExp }
  /** The agent's latest turn names the set (sensor + hub) and asks to check it: the recommendation. */
  | { on: "recommendation" }
  /** Only once another step of this buyer was sent (the agent has answered it). */
  | { on: "after"; step: string };

export type Step = {
  id: string;
  say: string;
  /** All rules must hold. No rules: the script's next line, sent in order when nothing else matches. */
  when?: Rule[];
};

export type Buyer = {
  id: number;
  /** Short name for files and tables. */
  key: string;
  name: string;
  company: string;
  language: "en" | "he";
  description: string;
  steps: Step[];
  /** Sent when no step fits (may repeat). Null: the buyer stops instead. */
  fallback: string | null;
  /** The conversation is over (no more messages). Default: the order-form card is in the chat. */
  done?: (t: Transcript) => boolean;
};

// ───────────────────────── Rule helpers ─────────────────────────

const quote: Rule = { on: "quote" };
const recommendation: Rule = { on: "recommendation" };
const asks = (pattern: RegExp): Rule => ({ on: "asks", pattern });
const after = (step: string): Rule => ({ on: "after", step });

const HOW_MANY = /how many|number of|כמה/i;
const SITES = /kitchen|site|location|branch|one place|מטבח|סניף|מיקום|אתר/i;
const CHECK_TODAY = /check|today|currently|right now|use now|בודק|היום|כרגע/i;

export const orderFormInChat = (t: Transcript) => t.some((m) => m.kind === "order_form");

// ───────────────────────── The nine buyers ─────────────────────────

export const BUYERS: Buyer[] = [
  {
    id: 1, key: "straight", name: "Dana Levi", company: "Dana's Bistro", language: "en",
    description: "Straight buyer: answers and says yes through to the order form.",
    steps: [
      { id: "today", say: "we write the temperatures on a paper log every morning" },
      { id: "count", when: [asks(HOW_MANY)], say: "2 fridges, one kitchen" },
      { id: "sites", when: [asks(SITES)], say: "just one kitchen" },
      { id: "yes_rec", when: [recommendation], say: "yes, that sounds right" },
      { id: "yes_close", when: [quote], say: "yes, send it" },
    ],
    fallback: "yes",
  },
  {
    id: 2, key: "has-solution", name: "Rina Mizrahi", company: "Rina's Kitchen", language: "en",
    description: "Has a solution today (devices connected to a local station).",
    steps: [
      { id: "today", say: "i use temp devices connected to my local station" },
      { id: "count", when: [asks(HOW_MANY)], say: "2, one kitchen" },
      { id: "sites", when: [asks(SITES)], say: "one kitchen" },
      { id: "yes_rec", when: [recommendation], say: "yes" },
      { id: "yes_close", when: [quote], say: "yes" },
    ],
    fallback: "yes",
  },
  {
    id: 3, key: "price-first", name: "Avi Peretz", company: "Avi's Grill", language: "en",
    description: "Asks the price in the first message.",
    steps: [
      { id: "price", say: "how much does it cost for 2 fridges?" },
      { id: "sites", when: [asks(SITES)], say: "one kitchen" },
      { id: "count", when: [asks(HOW_MANY)], say: "2 fridges" },
      { id: "today", when: [after("price"), asks(CHECK_TODAY)], say: "by hand, a paper log" },
      { id: "yes_rec", when: [recommendation], say: "ok, sounds good" },
      { id: "yes_close", when: [quote], say: "yes, go ahead" },
    ],
    fallback: "ok",
  },
  {
    id: 4, key: "too-expensive", name: "Michal Bar", company: "Bar Cafe", language: "en",
    description: "Raises \"too expensive\" after the quote, then accepts.",
    steps: [
      { id: "today", say: "a thermometer in each fridge, we check when we remember" },
      { id: "count", when: [asks(HOW_MANY)], say: "2 fridges in one kitchen" },
      { id: "sites", when: [asks(SITES)], say: "one kitchen" },
      { id: "yes_rec", when: [recommendation], say: "yes" },
      { id: "objection", when: [quote], say: "hmm, that's too expensive for us" },
      { id: "accept", when: [after("objection")], say: "ok, that makes sense. let's go ahead" },
    ],
    fallback: "yes",
  },
  {
    id: 5, key: "changes-quantity", name: "Yoni Katz", company: "Katz Deli", language: "en",
    description: "Changes the quantity after the quote (2 to 3 fridges).",
    steps: [
      { id: "today", say: "we just look at the display on the fridge door" },
      { id: "count", when: [asks(HOW_MANY)], say: "2 fridges, one kitchen" },
      { id: "sites", when: [asks(SITES)], say: "one kitchen" },
      { id: "yes_rec", when: [recommendation], say: "yes" },
      { id: "change", when: [quote], say: "actually we have 3 fridges, not 2. can you update it?" },
      { id: "yes_close", when: [quote, after("change")], say: "yes, that's right now" },
    ],
    fallback: "yes",
  },
  {
    id: 6, key: "hebrew", name: "נועה כהן", company: "קפה נועה", language: "he",
    description: "Hebrew-speaking straight buyer.",
    steps: [
      { id: "today", say: "היי, היום אנחנו רושמים את הטמפרטורות של המקררים ביומן נייר כל בוקר" },
      { id: "count", when: [asks(HOW_MANY)], say: "2 מקררים, מטבח אחד" },
      { id: "sites", when: [asks(SITES)], say: "מטבח אחד" },
      { id: "yes_rec", when: [recommendation], say: "כן, נשמע מתאים" },
      { id: "yes_close", when: [quote], say: "כן, שלח" },
    ],
    fallback: "כן",
  },
  {
    id: 7, key: "sceptic", name: "Moshe Azulay", company: "Azulay Catering", language: "en",
    description: "Sceptic: \"does it really work?\"",
    steps: [
      { id: "today", say: "paper log, twice a day" },
      { id: "doubt", when: [after("today")], say: "does it really work? how do i know it won't miss an alert at night?" },
      { id: "count", when: [asks(HOW_MANY)], say: "2 fridges, one kitchen" },
      { id: "sites", when: [asks(SITES)], say: "one kitchen" },
      { id: "yes_rec", when: [recommendation], say: "ok, sounds right" },
      { id: "yes_close", when: [quote], say: "yes" },
    ],
    fallback: "ok",
  },
  {
    id: 8, key: "think-it-over", name: "Tamar Golan", company: "Golan Bakery", language: "en",
    description: "\"I need to think / ask my partner\" after the quote.",
    steps: [
      { id: "today", say: "we check the fridge display when we open" },
      { id: "count", when: [asks(HOW_MANY)], say: "2 fridges, one kitchen" },
      { id: "sites", when: [asks(SITES)], say: "one kitchen" },
      { id: "yes_rec", when: [recommendation], say: "yes" },
      { id: "think", when: [quote], say: "i need to think about it and ask my partner" },
      { id: "later", when: [after("think")], say: "ok, i'll talk to him and get back to you" },
    ],
    fallback: null,
    done: (t) => orderFormInChat(t) || lastBuyerSaid(t, "ok, i'll talk to him and get back to you"),
  },
  {
    id: 9, key: "competitor", name: "Eli Shapiro", company: "Shapiro Pizza", language: "en",
    description: `Compares with a competitor ("how are you different from ${COMPETITOR}?").`,
    steps: [
      { id: "today", say: `we looked at ${COMPETITOR} last month` },
      { id: "compare", when: [after("today")], say: `how are you different from ${COMPETITOR}?` },
      { id: "count", when: [asks(HOW_MANY)], say: "2 fridges, one kitchen" },
      { id: "sites", when: [asks(SITES)], say: "one kitchen" },
      { id: "yes_rec", when: [recommendation], say: "ok" },
      { id: "yes_close", when: [quote], say: "yes" },
    ],
    fallback: "ok",
  },
];

export const buyerById = (id: number) => BUYERS.find((b) => b.id === id);

/** "1,2,6" → [1, 2, 6]; empty → all nine. Unknown ids throw. */
export function parseBuyerIds(raw: string | undefined): number[] {
  if (!raw?.trim()) return BUYERS.map((b) => b.id);
  const ids = raw.split(",").map((s) => Number(s.trim()));
  const bad = ids.filter((n) => !buyerById(n));
  if (bad.length) throw new Error(`Unknown buyer id(s): ${bad.join(", ")}. Use 1–${BUYERS.length}.`);
  return [...new Set(ids)];
}

// ───────────────────────── Policy ─────────────────────────

function lastBuyerSaid(t: Transcript, text: string): boolean {
  const last = [...t].reverse().find((m) => m.actor === "buyer");
  return last?.text === text;
}

/** The agent's (and app's) messages after the buyer's last message. */
export function latestAgentTurn(t: Transcript): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let i = t.length - 1; i >= 0 && t[i].actor !== "buyer"; i--) if (t[i].actor !== "human") out.unshift(t[i]);
  return out;
}

/** The last question the agent asked in a turn ("" when none). */
function lastQuestion(turn: TranscriptMessage[]): string {
  const qs = turn.filter((m) => !isQuote(m)).flatMap((m) => sentences(m.text)).filter((s) => /[?؟]/.test(s));
  return qs[qs.length - 1] ?? "";
}

const RECOMMENDS = [/sensor|חיישן/i, /hub|gateway|רכזת|מרכזת|שער|האב/i];

function holds(rule: Rule, turn: TranscriptMessage[], used: readonly string[]): boolean {
  switch (rule.on) {
    case "quote":
      return turn.some(isQuote);
    case "asks": {
      const q = lastQuestion(turn);
      return rule.pattern.test(q || turn.map((m) => m.text).join(" "));
    }
    case "recommendation": {
      if (turn.some(isQuote)) return false;
      const text = turn.map((m) => m.text).join(" ");
      return RECOMMENDS.every((re) => re.test(text)) && lastQuestion(turn) !== "";
    }
    case "after":
      return used.includes(rule.step);
  }
}

export type NextMessage =
  | { kind: "send"; stepId: string; text: string }
  | { kind: "stop"; reason: "goal" | "max_messages" | "no_reply" | "script_done" };

/**
 * The buyer's next message, from the transcript so far and the step ids
 * already sent (in order; "fallback" for a fallback answer).
 */
export function nextBuyerMessage(buyer: Buyer, t: Transcript, used: readonly string[]): NextMessage {
  if ((buyer.done ?? orderFormInChat)(t)) return { kind: "stop", reason: "goal" };
  if (t.filter((m) => m.actor === "buyer").length >= MAX_BUYER_MESSAGES) return { kind: "stop", reason: "max_messages" };
  const turn = latestAgentTurn(t);
  if (turn.length === 0) return { kind: "stop", reason: "no_reply" };
  const unused = buyer.steps.filter((s) => !used.includes(s.id));
  const reactive = unused.find((s) => s.when?.length && s.when.every((r) => holds(r, turn, used)));
  const next = reactive ?? unused.find((s) => !s.when?.length);
  if (next) return { kind: "send", stepId: next.id, text: next.say };
  if (buyer.fallback !== null) return { kind: "send", stepId: "fallback", text: buyer.fallback };
  return { kind: "stop", reason: "script_done" };
}

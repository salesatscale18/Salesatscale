/**
 * Default sales plays (P11): one short card per selling situation, the same
 * for every seller. A seller's own card (`Playbook.plays[key].own`) replaces
 * the default for that seller; the seller's facts (`facts`, or an older
 * `content` text) are added to the card.
 * Wording is owned by the conversation-core lane; the shape is shared.
 * Examples are neutral: they show the form of a reply and never promise
 * specifics (guarantees, numbers, facts); <angle brackets> mark what the
 * agent fills in from this seller's data.
 */
import { PLAY_KEYS, type PlayCard, type PlayFact, type PlayKey, type Playbook } from "@/db/schema";

export type DefaultPlay = PlayCard & {
  /** Shown to the seller in the playbook editor. */
  title: string;
  /** What the seller can add for this play (editor hint). */
  sellerContentHint: string;
};

export const DEFAULT_PLAYS: Record<PlayKey, DefaultPlay> = {
  need: {
    title: "Finding the real need",
    when: "You do not yet know enough to recommend one set.",
    do: ["Start with how they handle it today.", "Then ask only what decides which products and how many (size, sites, quantity).", "Ask about the problem or its cost only if the answer would change what you recommend.", "Skip anything the buyer already said. Stop at 3 questions."],
    example: "How do you handle <what they asked about> today?",
    notThis: "What is your company name, size and budget?",
    sellerContentHint: "The questions that decide which products fit.",
  },
  fit: {
    title: "Fitting the solution",
    when: "You know enough to recommend.",
    do: ["Recommend one set: the smallest that solves what they said.", "Say in a few words why it fits them.", "Mention a bigger option only if they ask for more.", "End with one check question: does it sound like what they need?"],
    example: "For <what they described>, <the smallest set that solves it> covers it.",
    notThis: "We have three packages: Basic, Pro and Enterprise.",
    sellerContentHint: "Which set fits which type of customer.",
  },
  value: {
    title: "Explaining value",
    when: "You describe a product or the recommended set.",
    do: ["Give one benefit, tied to something the buyer said.", "State it as a concrete outcome for them (what they get, save or avoid).", "Do not list features."],
    example: "You said <their problem>, so with <the product> you <the outcome they get>.",
    notThis: "Our amazing software has best-in-class speed, endless features and a great design.",
    sellerContentHint: "What a failure costs the buyer; the outcome each product gives.",
  },
  price_early: {
    title: "Price asked early",
    when: "The buyer asks the price before you have recommended a set.",
    do: ["Answer at once with a real number or range, in one or two plain sentences, no list.", "Say in a few words what it depends on.", "Ask the one question that makes it exact."],
    example: "It starts at <price>, and the total depends on <what drives it>. How many <units> do you need?",
    notThis: "Before we talk price, let me understand your needs.",
    sellerContentHint: "The entry price and what drives the total.",
  },
  too_expensive: {
    title: "\"Too expensive\"",
    when: "The buyer says the price is too high, or asks for a discount.",
    do: [
      "Acknowledge, and find which kind it is: over their budget, more than another offer, or not clear what they get for it.",
      "Answer that kind. Value not clear: set the price against what the problem costs them, in their own numbers, per unit or per month. Another offer: say what this price includes that the other may not. Budget: offer a smaller first step that still solves the main problem.",
      "Ask: \"If the price worked, is anything else in the way?\" If something else is, handle that first.",
      "Offer a discount only as a trade, inside your limit: for deciding now, for more units, or for paying yearly. Make a new quote with it.",
      "If they need more than your limit: send a real approval request to the team, say you have asked, and keep the chat going.",
      "Last rungs: agree a time to come back, then a call.",
    ],
    example: "I understand. Is it more than you planned to spend, or more than another offer you have?",
    notThis: "I can give you 5% off right now!",
    sellerContentHint: "What the problem costs a typical customer; a smaller starting set; what a discount can be traded for; what the price includes.",
  },
  existing_solution: {
    title: "\"I already have something\"",
    when: "The buyer names what they use today.",
    do: [
      "Say what their current solution does well, and ask what they would improve about it if they could.",
      "If they name a gap: show what you add there, from approved information.",
      "If they name none: give the one gap it usually leaves, as a question (\"How do you handle <the gap> today?\").",
      "Offer to start alongside what they have, not instead of it, when the seller allows it.",
      "Never criticise what they have.",
    ],
    example: "That covers <what it does well>. If you could improve one thing about it, what would it be?",
    notThis: "Those old devices are unreliable.",
    sellerContentHint: "The gap each common existing solution leaves; whether a side-by-side start is possible.",
  },
  competitor: {
    title: "\"How are you different from X?\"",
    when: "The buyer compares you with a competitor or holds another offer.",
    do: [
      "Ask what matters most to them in the comparison. If they hold another quote, ask what it includes.",
      "Give one difference that matters for that point: what they get, not a specification.",
      "Make no claims about the competitor. If you know nothing about them, say so in one line and carry on with what the buyer gets from you.",
      "If the difference is price: go to \"Too expensive\".",
    ],
    example: "I don't have details on their offer. What matters most to you when you compare?",
    notThis: "I can't speak to RivalSoft, since I have no approved facts about it. Our servers answer in under 50 ms with 99.99% uptime.",
    sellerContentHint: "Approved comparison facts.",
  },
  proof: {
    title: "\"Does it really work?\"",
    when: "The buyer doubts the product or the claims.",
    do: [
      "Ask what exactly worries them: that it works, how it is set up, or what happens if something goes wrong.",
      "Give the one proof that matches: a fact, a customer example or a guarantee, from approved information.",
      "Offer a small first step that lowers the risk, when the seller has one.",
      "Ask if that answers it.",
    ],
    example: "Fair question. Is it more about whether it works, or what happens if something goes wrong?",
    notThis: "Trust me, all our customers love it.",
    sellerContentHint: "Proof points; guarantee; support terms; a pilot or small start.",
  },
  need_to_think: {
    title: "\"I need to think\" or \"I'll ask my partner\"",
    when: "The buyer delays the decision.",
    do: [
      "Agree without pressure, and find what is behind it: \"Usually it is the price, whether it fits, or someone else needs to agree. Which is closest for you?\"",
      "If it is price, fit or doubt: go to that play.",
      "If someone else decides: ask what that person will care about most, then write a short summary for them (what it solves, what it costs, the next step) and offer to answer their questions here.",
      "Make the decision smaller or safer, from approved terms only: a first site or smaller set, the cancel terms, a guarantee.",
      "Agree a time to come back and what will be decided by then. Call schedule_follow_up. State the quote's valid-until date once.",
      "Last rung: a call that includes the other decision-maker.",
    ],
    example: "Of course. So I can help: is it the price, whether it fits, or does someone else need to agree?",
    notThis: "Sure, our sales team will come back to you.",
    sellerContentHint: "Cancel terms; guarantee; a smaller starting set.",
  },
  send_info: {
    title: "\"Send me information\"",
    when: "The buyer asks for material instead of talking.",
    do: [
      "Say yes, and ask what the information needs to answer and who will read it.",
      "Answer that question now, in two sentences.",
      "Send the one approved item that fits, or a short summary written for that reader.",
      "Agree the next step: a time to hear what they thought, or the quote if they are ready.",
    ],
    example: "Happy to. What should it answer for you, and is it for you or for someone else?",
    notThis: "Sure, I will send you everything we have.",
    sellerContentHint: "Links or documents approved for sharing.",
  },
  not_now: {
    title: "\"Not now\"",
    when: "The buyer says the timing is wrong.",
    do: [
      "Accept it, and ask one question: \"Is it the timing, or is this not a priority right now?\" and what would need to change.",
      "If they told you about a problem earlier, say once what waiting costs them, in their own words. Do not repeat it.",
      "Offer to come back at a time tied to their reason (\"after your budget is set\"), not a random date. Call schedule_follow_up and confirm in their words.",
      "If they want no follow-up, thank them and ask nothing more.",
    ],
    example: "No problem. What would need to change for the timing to be right?",
    notThis: "Are you sure? It only takes a minute.",
    sellerContentHint: "",
  },
  right_size: {
    title: "Buyer wants more or less than they need",
    when: "The buyer asks for a quantity or product that does not match their need.",
    do: ["Say honestly what is enough.", "Explain why in a few words.", "Quote what they decide."],
    example: "For <their need>, <what is enough> is enough, not <what they asked for>: <the sizing rule, in a few words>.",
    notThis: "Great, 10 seats it is!",
    sellerContentHint: "Sizing rules: how many of each item a customer needs.",
  },
  asks_for_person: {
    title: "The buyer asks for a person",
    when: "The buyer asks to talk to a person and is not upset.",
    do: [
      "Say yes first. Then, once only, offer to help now: ask what they want to cover, so the person comes prepared, and say you can often answer it right away.",
      "If they tell you: answer it, or go to the matching play.",
      "If they ask again, or do not want to say: book the call. Propose a time, give the link to choose another, and say what the person will have ready.",
      "Keep answering until the call. Do not pause the chat.",
    ],
    example: "Of course, I can set that up. So they come prepared, what would you like to cover? If it is about price or fit I can usually answer right now.",
    notThis: "\"Before I do that, can I just ask a few more questions?\" and never refusing or ignoring the request.",
    sellerContentHint: "Who takes calls and when.",
  },
  // The key stays "handoff": a seller's stored card and facts for the old hand-off play stay with the immediate hand-over.
  handoff: {
    title: "The buyer is upset",
    when: "The buyer is annoyed, complains, raises a legal or existing-customer issue, or insists on a person.",
    do: ["Stop selling and ask nothing more.", "Say a person from the team will take over.", "Hand over at once."],
    example: "Understood. I am passing you to a member of the team now.",
    notThis: "Before I do that, can I just ask one more question?",
    sellerContentHint: "",
  },
  no_answer: {
    title: "A question with no approved answer",
    when: "The buyer asks something you have no approved information about.",
    do: [
      "Say in one line that you do not have that detail, and ask what is behind the question: what they need it for, and whether it is a must-have or good to know.",
      "Send the question to the team silently. Do not tell the buyer you sent it and do not say you are waiting: that makes the buyer wait too. If an answer arrives while you are still talking, use it at a natural point.",
      "In the same message, promise the outcome in one short line (\"I'll make sure you get an exact answer on that\") and move the sale forward with the next question or step. Good to know: carry on to the close; the answer follows in writing afterwards. Must-have: carry on with everything that does not depend on it.",
      "Bring it up again only if the buyer does, or at the close when it is a must-have and still open: then book a short call with the right person, named by the title the seller set, who arrives with the answer. Frame it as progress: \"That point matters for your decision, so I'll set a short call with our <role>, who will have the exact answer. Does tomorrow at 10:00 work?\"",
      "Never guess, and never pause the chat only because of one open question.",
    ],
    example: "I don't have that detail yet. What do you need it for: is it a must-have, or good to know?",
    notThis: "\"I don't know, I'll pass you to a colleague.\" Also not this: \"I've sent that to the team, let's wait for their answer.\"",
    sellerContentHint: "",
  },
  someone_else_decides: {
    title: "\"Someone else decides\"",
    when: "The buyer says another person or a committee makes the decision.",
    do: [
      "Ask who decides and what matters most to them.",
      "Help the buyer make the case: a short summary for that person, with what it solves, what it costs and the next step.",
      "Offer to answer that person's questions here, or to include them in a short call.",
      "Agree when the buyer will speak to them, and a time to come back. Call schedule_follow_up.",
    ],
    example: "Who else is part of the decision, and what will matter most to them?",
    notThis: "Can you give me their phone number?",
    sellerContentHint: "A one-page summary approved for sharing.",
  },
  tried_failed: {
    title: "\"We tried something like this and it failed\"",
    when: "The buyer had a bad experience with a similar product.",
    do: [
      "Take it seriously and ask what went wrong.",
      "Say what is different here on that exact point, from approved information. If nothing is, say so honestly.",
      "Offer a small first step or a guarantee, when the seller has one.",
      "Ask if that changes the picture.",
    ],
    example: "That is useful to know. What went wrong last time?",
    notThis: "Ours is much better than that.",
    sellerContentHint: "Common reasons similar products fail and what is different here.",
  },
  complicated: {
    title: "\"It sounds complicated\" or \"we have no time to set it up\"",
    when: "The buyer worries about effort, set-up or change.",
    do: [
      "Ask what worries them most: the set-up, learning it, or the time it takes.",
      "Say what the seller does for them and what is left for the buyer, in plain steps and real times.",
      "Offer the smallest start that needs the least from them.",
      "Ask if that sounds manageable.",
    ],
    example: "What worries you most: the set-up, or the time it will take from your team?",
    notThis: "It is very easy, don't worry.",
    sellerContentHint: "Who installs and how long it takes; what the buyer has to do.",
  },
  locked_in: {
    title: "\"I don't want to be locked in\"",
    when: "The buyer worries about commitment, contract length or cancelling.",
    do: [
      "Ask what they want to be able to do: stop, change the size, or pause.",
      "State the real terms on that point in one sentence, from approved information.",
      "If the terms allow a smaller or shorter start, offer it.",
      "If the terms do not give what they want, say so honestly and offer a call to discuss terms.",
    ],
    example: "Fair point. What would you want to be able to do: stop, or change the size later?",
    notThis: "\"You can cancel any time\" when that is not in the approved terms.",
    sellerContentHint: "Contract length, notice period, what can be changed and when.",
  },
};

type StoredPlay = NonNullable<Playbook["plays"]>[PlayKey];

/**
 * The seller's facts for a play, from a playbook of either shape: the `facts`
 * list, or an older single `content` text read as one fact. Blank facts are dropped.
 */
export function playFacts(p: StoredPlay | null | undefined): PlayFact[] {
  if (p?.facts !== undefined) {
    return p.facts
      .map((f) => ({ text: f.text?.trim() ?? "", source: f.source?.trim() ?? "" }))
      .filter((f) => f.text)
      .map((f) => ({ text: f.text, ...(f.source ? { source: f.source } : {}) }));
  }
  const content = p?.content?.trim() ?? "";
  return content ? [{ text: content }] : [];
}

/**
 * The facts as one text for the prompt. One fact is used as written (an older
 * `content` text reads exactly as before); several are joined as sentences.
 */
export function factsText(facts: PlayFact[]): string {
  if (facts.length <= 1) return facts[0]?.text ?? "";
  return facts.map((f) => (/[.!?。:;]$/u.test(f.text) ? f.text : `${f.text}.`)).join(" ");
}

/** The card the agent uses for a situation: the seller's own card when set, else the default. `content` is the seller's facts as one text. */
export function effectivePlay(playbook: Pick<Playbook, "plays">, key: PlayKey): { card: PlayCard; own: boolean; content: string } {
  const p = playbook.plays?.[key];
  const own = p?.own;
  return { card: own ?? DEFAULT_PLAYS[key], own: !!own, content: factsText(playFacts(p)) };
}

export const allPlayKeys = (): readonly PlayKey[] => PLAY_KEYS;

/**
 * A default card's moves with the seller's question budget in them ("Stop at N
 * questions."). The one rewrite both the playbook card and the prompt use, so
 * the seller reads the number the agent is told.
 */
export function withQuestionBudget(steps: readonly string[], budget: number): string[] {
  return steps.map((step) => step.replace(/\bStop at 3 questions\./, `Stop at ${budget} questions.`));
}

/** A default card with the seller's question budget in it ("Stop at N questions."). A seller's own card is never rewritten. */
export function defaultPlayFor<K extends PlayKey>(key: K, budget: number): DefaultPlay {
  const d = DEFAULT_PLAYS[key];
  return { ...d, do: withQuestionBudget(d.do, budget) };
}

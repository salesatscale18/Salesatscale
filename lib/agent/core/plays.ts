/**
 * Default sales plays (P11): one short card per selling situation, the same
 * for every seller. A seller's own card (`Playbook.plays[key].own`) replaces
 * the default for that seller; the seller's facts (`facts`, or an older
 * `content` text) are added to the card.
 * Wording is owned by the conversation-core lane; the shape is shared.
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
    example: "How do you keep your offices clean today?",
    notThis: "What is your company name, size and budget?",
    sellerContentHint: "The questions that decide which products fit.",
  },
  fit: {
    title: "Fitting the solution",
    when: "You know enough to recommend.",
    do: ["Recommend one set: the smallest that solves what they said.", "Say in a few words why it fits them.", "Mention a bigger option only if they ask for more."],
    example: "For one building site for a week, two scissor lifts and one generator cover it.",
    notThis: "We have three packages: Basic, Pro and Enterprise.",
    sellerContentHint: "Which set fits which type of customer.",
  },
  value: {
    title: "Explaining value",
    when: "You describe a product or the recommended set.",
    do: ["Give one benefit, tied to something the buyer said.", "State it as a concrete outcome for them (what they get, save or avoid).", "Do not list features."],
    example: "Everyone sees the same schedule on their phone, so nobody works from an old copy.",
    notThis: "Our amazing software has best-in-class speed, endless features and a great design.",
    sellerContentHint: "What a failure costs the buyer; the outcome each product gives.",
  },
  price_early: {
    title: "Price asked early",
    when: "The buyer asks the price before you have recommended a set.",
    do: ["Answer at once with a real number or range, in one or two plain sentences, no list.", "Say in a few words what it depends on.", "Ask the one question that makes it exact."],
    example: "A user seat is <price> a month and setup is <price> one-time, so the total depends on the number of users. How many people will use it?",
    notThis: "Before we talk price, let me understand your needs.",
    sellerContentHint: "The entry price and what drives the total.",
  },
  too_expensive: {
    title: "\"Too expensive\"",
    when: "The buyer says the price is too high.",
    do: ["Acknowledge it and ask what they compare it to.", "Set the price against what the problem costs them.", "If it is still too high, offer a smaller start.", "Offer a discount last, within your limit."],
    example: "I understand. What are you comparing it to?",
    notThis: "I can give you 5% off right now!",
    sellerContentHint: "The cost of the problem; a smaller starting set.",
  },
  existing_solution: {
    title: "\"I already have something\"",
    when: "The buyer names what they use today.",
    do: ["Say what their current solution does well.", "Name the one gap it leaves and what you add there, from approved information.", "Never criticise what they have."],
    example: "That covers you when you book a few weeks ahead. What we add is delivery to your site the next morning, also on weekends.",
    notThis: "Those old devices are unreliable.",
    sellerContentHint: "The gap each common existing solution leaves.",
  },
  competitor: {
    title: "\"How are you different from X?\"",
    when: "The buyer compares you with a competitor.",
    do: ["Give one difference that matters for this buyer, in plain words: what they get, not a specification.", "Make no claims about the competitor.", "If you know nothing about them, say you don't have details on that product and offer to check with the team."],
    example: "I don't have details on their service, but for one office what you get with us is the same cleaning team every week, with supplies included. Is that what matters most to you?",
    notThis: "I can't speak to RivalSoft, since I have no approved facts about it. Our servers answer in under 50 ms with 99.99% uptime.",
    sellerContentHint: "Approved comparison facts.",
  },
  proof: {
    title: "\"Does it really work?\"",
    when: "The buyer doubts the product or the claims.",
    do: ["Give one specific proof: a fact, a customer example or a guarantee.", "Use approved information only.", "Ask if that answers the concern."],
    example: "Yes. Every machine is checked before it leaves us, and a broken one is replaced on site within 24 hours. Does that answer it?",
    notThis: "Trust me, all our customers love it.",
    sellerContentHint: "Approved proof points: facts, customer examples, guarantees.",
  },
  need_to_think: {
    title: "\"I need to think\" or \"I'll ask my partner\"",
    when: "The buyer delays the decision.",
    do: [
      "Ask what is still open.", "Answer it.", "Offer a short summary to forward.",
      "Offer to come back to them yourself at a time that suits them; you may propose one, and take theirs.",
      "When they agree a time, call schedule_follow_up and confirm the time back in their words.",
    ],
    example: "Of course. Shall I message you tomorrow at 10 to hear what you decided, or is another time better?",
    notThis: "Sure, our sales team will come back to you.",
    sellerContentHint: "",
  },
  send_info: {
    title: "\"Send me information\"",
    when: "The buyer asks for material instead of talking.",
    do: ["Send the one most relevant item you are approved to share.", "If you have nothing approved to send, give the main facts in two sentences instead.", "End with one question that keeps the chat going."],
    example: "Here is the one-page overview. Which matters more to you, the price or how fast you can start?",
    notThis: "Sure, I will send you everything we have.",
    sellerContentHint: "Links or documents approved for sharing.",
  },
  not_now: {
    title: "\"Not now\"",
    when: "The buyer says the timing is wrong.",
    do: [
      "Accept it without arguing.",
      "Offer to come back to them yourself at a time that suits them; you may propose one, and take theirs.",
      "When they agree a time, call schedule_follow_up and confirm the time back in their words.",
      "If they want no follow-up, ask nothing more. Do not push.",
    ],
    example: "No problem. Shall I message you next Tuesday at 10, or is another time better?",
    notThis: "Are you sure? It only takes a minute.",
    sellerContentHint: "",
  },
  right_size: {
    title: "Buyer wants more or less than they need",
    when: "The buyer asks for a quantity or product that does not match their need.",
    do: ["Say honestly what is enough.", "Explain why in a few words.", "Quote what they decide."],
    example: "For 5 people you need 5 user seats, not 10. One seat covers one person.",
    notThis: "Great, 10 seats it is!",
    sellerContentHint: "Sizing rules: how many of each item a customer needs.",
  },
  handoff: {
    title: "Buyer is annoyed or asks for a person",
    when: "The buyer is upset, or asks to talk to a person.",
    do: ["Stop selling and ask nothing more.", "Say a person from the team will take over.", "Hand off to a person."],
    example: "Understood. I am passing you to a member of the team now.",
    notThis: "Before I do that, can I just ask one more question?",
    sellerContentHint: "",
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

/**
 * Default sales plays (P11): one short card per selling situation, the same
 * for every seller. A seller's own card (`Playbook.plays[key].own`) replaces
 * the default for that seller; `content` adds the seller's facts to the card.
 * Wording is owned by the conversation-core lane; the shape is shared.
 */
import { PLAY_KEYS, type PlayCard, type PlayKey, type Playbook } from "@/db/schema";

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
    do: ["Ask about their situation today.", "Then the problem it causes.", "Then what that problem costs them.", "Stop at 3 questions."],
    example: "How do you check the fridge temperatures today?",
    notThis: "What is your company name, size and budget?",
    sellerContentHint: "The questions that decide which products fit.",
  },
  fit: {
    title: "Fitting the solution",
    when: "You know enough to recommend.",
    do: ["Recommend the smallest set that solves what they said.", "Say in a few words why it fits them.", "Offer a bigger option only if they ask."],
    example: "For one kitchen with 2 fridges, a sensor in each fridge and one hub covers it.",
    notThis: "We have three packages: Basic, Pro and Enterprise.",
    sellerContentHint: "Which set fits which type of customer.",
  },
  value: {
    title: "Explaining value",
    when: "You describe a product or the recommended set.",
    do: ["Give one benefit, tied to something the buyer said.", "State it as a concrete outcome for them.", "No list of features."],
    example: "You get an alert on your phone the moment a fridge warms up, so you can save the stock.",
    notThis: "Our amazing sensors have best-in-class accuracy, long battery life and a great app.",
    sellerContentHint: "What a failure costs the buyer; the outcome each product gives.",
  },
  price_early: {
    title: "Price asked early",
    when: "The buyer asks the price before you recommended.",
    do: ["Answer at once with a real number or range.", "Say in a few words what it depends on.", "Ask the one question that makes it exact."],
    example: "A sensor is ₪590 one-time and the hub is ₪90 a month, so it depends on the number of fridges. How many do you want covered?",
    notThis: "Before we talk price, let me understand your needs.",
    sellerContentHint: "The entry price and what drives the total.",
  },
  too_expensive: {
    title: "\"Too expensive\"",
    when: "The buyer says the price is too high.",
    do: ["Ask what they compare it to.", "Set the price against what the problem costs them.", "Offer a smaller start.", "Offer a discount last, within your limit."],
    example: "I understand. What are you comparing it to?",
    notThis: "I can give you 5% off right now!",
    sellerContentHint: "The cost of the problem; a smaller starting set.",
  },
  existing_solution: {
    title: "\"I already have something\"",
    when: "The buyer names what they use today.",
    do: ["Credit what they have.", "Name the one gap it leaves, from approved information.", "Never criticise it."],
    example: "That covers you while someone is near the station. What we add is an alert to your phone at night and on weekends.",
    notThis: "Those old devices are unreliable.",
    sellerContentHint: "The gap each common existing solution leaves.",
  },
  competitor: {
    title: "\"How are you different from X?\"",
    when: "The buyer compares you with a competitor.",
    do: ["Give one factual difference that matters for this buyer.", "Make no claims about the competitor.", "If you have no approved fact, say you will check with the team."],
    example: "The main difference for a single kitchen is that installation is included and takes about an hour.",
    notThis: "They are much worse than us.",
    sellerContentHint: "Approved comparison facts.",
  },
  proof: {
    title: "\"Does it really work?\"",
    when: "The buyer doubts the product or the claims.",
    do: ["Give one specific proof: a fact, a customer example or a guarantee.", "Use approved information only.", "Ask if that answers the concern."],
    example: "Yes. The sensor reads the temperature every few minutes and alerts when it leaves the range you set. Does that answer it?",
    notThis: "Trust me, all our customers love it.",
    sellerContentHint: "Approved proof points: facts, customer examples, guarantees.",
  },
  need_to_think: {
    title: "\"I need to think\" or \"I'll ask my partner\"",
    when: "The buyer delays the decision.",
    do: ["Ask what is still open.", "Answer it.", "Offer a short summary to forward.", "Agree when to talk again."],
    example: "Of course. Is there anything still open that I can answer now?",
    notThis: "The offer ends today, so you should decide now.",
    sellerContentHint: "",
  },
  send_info: {
    title: "\"Send me information\"",
    when: "The buyer asks for material instead of talking.",
    do: ["Send the one most relevant item you are approved to share.", "Ask one question that keeps the chat going."],
    example: "Here is the one-page overview. Which matters more to you, the alerts or the temperature log?",
    notThis: "Sure, I will send you everything we have.",
    sellerContentHint: "Links or documents approved for sharing.",
  },
  not_now: {
    title: "\"Not now\"",
    when: "The buyer says the timing is wrong.",
    do: ["Accept it.", "Ask when is better.", "Ask what would make it relevant.", "Do not push."],
    example: "No problem. When would be a better time for me to check back?",
    notThis: "Are you sure? It only takes a minute.",
    sellerContentHint: "",
  },
  right_size: {
    title: "Buyer wants more or less than they need",
    when: "The buyer asks for a quantity or product that does not match their need.",
    do: ["Say honestly what is enough.", "Explain why in a few words.", "Quote what they decide."],
    example: "For 2 fridges you need 2 sensors, not 4. One sensor covers one fridge.",
    notThis: "Great, 4 sensors it is!",
    sellerContentHint: "Sizing rules: how many of each item a customer needs.",
  },
  handoff: {
    title: "Buyer is annoyed or asks for a person",
    when: "The buyer is upset, or asks to talk to a person.",
    do: ["Stop selling.", "Say a person will take over.", "Hand off."],
    example: "Understood. I am passing you to a member of the team now.",
    notThis: "Before I do that, can I just ask one more question?",
    sellerContentHint: "",
  },
};

/** The card the agent uses for a situation: the seller's own card when set, else the default. */
export function effectivePlay(playbook: Pick<Playbook, "plays">, key: PlayKey): { card: PlayCard; own: boolean; content: string } {
  const p = playbook.plays?.[key];
  const own = p?.own;
  return { card: own ?? DEFAULT_PLAYS[key], own: !!own, content: p?.content?.trim() ?? "" };
}

export const allPlayKeys = (): readonly PlayKey[] => PLAY_KEYS;

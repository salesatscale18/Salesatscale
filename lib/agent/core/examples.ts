/**
 * The examples in the core design and the sales plays (P11, "nothing
 * pilot-specific in shared code"). Every seller gets the same rules; the
 * examples show their form. Where the seller has the data, an example is
 * built from it: the published catalog's plain names and value lines, the
 * playbook's "needed for the quote" fields and their example questions.
 * Without it, a fixed mix of other businesses (a software subscription, a
 * cleaning service, equipment rental), so no single domain dominates.
 *
 * The examples are part of the stable system prompt: they are built only
 * from the playbook of the agent version and the published catalog, never
 * from per-turn state, so the prompt stays byte-stable across turns.
 */
import type { Playbook } from "@/db/schema";
import { isReservedFieldKey } from "./facts";
import { readOpener, writtenIn } from "./opener";

/** A published catalog item, as the examples read it (catalog order). */
export type ExampleCatalogItem = { plainName?: string | null; valueLine?: string | null };

export type ConversationExamples = {
  /** Stage 3: what you understood, the set, what it gives, a check question. */
  recommend: string;
  /** Stage 4: the close after the quote. */
  close: string;
  /** Listening: what the seller adds to what the buyer uses today. */
  addsToToday: string;
  /** Questions: what a "needed for the quote" field is, e.g. "the number of users or sites". */
  neededForQuote: string;
  /** Questions: the close on an assumed value. */
  assumed: string;
  /** Wording: two short questions that both decide the recommendation. */
  twoQuestions: string;
  /** Sales plays: the example of a default card, by play. */
  plays: { need: string; fit: string; value: string };
};

/** The fixed mix, used when the seller has no data for an example. */
export const MIXED_EXAMPLES: ConversationExamples = {
  recommend: "Got it, a team of 12 that plans shifts on a shared spreadsheet today. What fits is the team plan with 12 user seats and setup help in the first week. Everyone sees the same schedule on their phone, so nobody works from an old copy. Does that sound like what you need?",
  close: "If this looks right, I'll send the order form now and the first cleaning can be done by about 1 Dec. Sounds good?",
  addsToToday: "That covers you when you book a few weeks ahead. What we add is delivery to your site the next morning, also for last-minute jobs.",
  neededForQuote: "the number of users or sites",
  assumed: "I've quoted for 10 users; tell me if that's different.",
  twoQuestions: "How many people will use it, and is it one office?",
  plays: {
    need: "How do you handle <what they asked about> today?",
    fit: "For one building site for a week, two scissor lifts and one generator cover it.",
    value: "Everyone sees the same schedule on their phone, so nobody works from an old copy.",
  },
};

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
/** English text only: the instructions are in English. */
const english = (v: string | null | undefined) => {
  const s = clean(v);
  return s && writtenIn(s, "en") ? s : "";
};
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
/** "Number of sites" -> "number of sites"; "VAT ID" stays as it is. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const strip = (s: string) => s.replace(/[.!?]+$/, "");

/** The examples for this seller: built from their data where it exists, else the fixed mix. */
export function conversationExamples(
  p: Pick<Playbook, "fields" | "opener">,
  catalog?: readonly ExampleCatalogItem[] | null,
): ConversationExamples {
  const items = (catalog ?? [])
    .map((i) => ({ name: english(i.plainName), value: english(i.valueLine) }))
    .filter((i) => i.name);
  const names = items.slice(0, 2).map((i) => `the ${i.name}`);
  const value = items.find((i) => i.value)?.value ?? "";
  const fields = (p.fields ?? []).filter((f) => !isReservedFieldKey(f.key));
  const forQuote = fields.filter((f) => f.stage === "before_quote" && english(f.label));
  const labels = forQuote.slice(0, 2).map((f) => `the ${lowerFirst(strip(english(f.label)))}`);
  const quoteQuestions = forQuote.map((f) => english(f.example)).filter(Boolean);
  const pitchQuestion = fields.filter((f) => f.stage === "optional").map((f) => english(f.example)).find(Boolean);
  const openingQuestion = english(readOpener(p.opener).question?.en);

  const set = names.length ? names.join(" and ") : "";
  return {
    recommend: set
      ? `Got it, <what they told you, in your own words>. What fits is ${set}. ${value ? sentence(value) : "<What it gives this buyer, from approved information.>"} Does that sound like what you need?`
      : MIXED_EXAMPLES.recommend,
    close: set
      ? `If this looks right, I'll send the order form now and you can have ${names[0]} by about 1 Dec. Sounds good?`
      : MIXED_EXAMPLES.close,
    addsToToday: MIXED_EXAMPLES.addsToToday,
    neededForQuote: labels.length ? labels.join(" or ") : MIXED_EXAMPLES.neededForQuote,
    assumed: labels.length ? `I've quoted for <${labels[0]} you assumed>; tell me if that's different.` : MIXED_EXAMPLES.assumed,
    twoQuestions: quoteQuestions.length >= 2 ? `${sentence(quoteQuestions[0])} ${sentence(quoteQuestions[1])}` : MIXED_EXAMPLES.twoQuestions,
    plays: {
      need: pitchQuestion ? sentence(pitchQuestion) : openingQuestion ? sentence(openingQuestion) : MIXED_EXAMPLES.plays.need,
      fit: set ? `For <what they described>, ${set} ${names.length > 1 ? "cover" : "covers"} it.` : MIXED_EXAMPLES.plays.fit,
      value: value ? sentence(value) : MIXED_EXAMPLES.plays.value,
    },
  };
}

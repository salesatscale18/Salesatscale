/**
 * Conversation stage (P11): derived in code each turn from facts, never
 * decided by the model. Pure. The instruction block goes into the per-turn
 * context (lib/agent/prompt.ts) and into the update_deal_state result, so the
 * agent always reads which stage it is in and what that stage requires.
 *
 * The spec's stages map to six derived stages: Quote and Close go out in one
 * turn ("quote_close"); "order_form" is the turn that waits for the buyer's
 * yes to the close and then sends the link.
 */
import type { DealFieldValue, Playbook, PlaybookField, StoredObjection } from "@/db/schema";
import { ASKED_PREFIX, askedCount, isReservedFieldKey, priceAsked, pricesAllowed, recommendationConfirmed } from "./facts";
import { objectionTitle, openObjections } from "./objections";

export type Stage = "open" | "understand" | "recommend" | "quote_close" | "order_form" | "after";

/**
 * Questions before recommending (B2, 18 Nov): the seller's number
 * (`Playbook.questionBudget`), a maximum, not a target. Default 3, range 2 to 6.
 */
export const QUESTION_BUDGET = { min: 2, max: 6, default: 3 } as const;
/** Safety ceiling in code: after this many agent questions the stage moves to Recommend, whatever the setting. */
export const QUESTION_CEILING = 6;

/** The seller's question budget, within 2..6 (missing or invalid: 3), never above the ceiling. */
export function questionBudgetOf(p: Pick<Playbook, "questionBudget"> | null | undefined): number {
  const n = p?.questionBudget;
  const v = typeof n === "number" && Number.isInteger(n) ? Math.min(QUESTION_BUDGET.max, Math.max(QUESTION_BUDGET.min, n)) : QUESTION_BUDGET.default;
  return Math.min(v, QUESTION_CEILING);
}

/**
 * Questions the agent started: the sum of the reserved `_asked_<key>` counts
 * (recorded through update_deal_state `asked`, at most once per field per
 * turn). Answers to the buyer's own questions and extra detail are never
 * recorded as asked, so they never use the budget.
 */
export function agentQuestionsAsked(fields: Record<string, DealFieldValue> | null | undefined): number {
  let n = 0;
  for (const key of Object.keys(fields ?? {})) {
    if (key.startsWith(ASKED_PREFIX)) n += askedCount(fields, key.slice(ASKED_PREFIX.length));
  }
  return n;
}

/** The "Helps the pitch" rule (B2, 18 Nov): one text for the core design and the stage block. */
export const HELPS_THE_PITCH_RULE = "A question that helps the pitch is asked once, without insisting. If the buyer skips it, move on and do not ask it again in the next messages. You may come back to it once, later, only when it fits what the buyer is talking about, woven into your reply: never as a quiz, and never holding up the next step.";

export type StageFacts = {
  /** The lead's latest live quote: none, waiting for the seller's approval, or ready to send. */
  quote: "none" | "awaiting_approval" | "ready";
  /** The order form: none sent, sent for the current quote, or sent for an older quote ("outdated": the need changed). */
  orderForm: "none" | "sent" | "outdated";
  /** The buyer signed the order form (an order exists). */
  signed: boolean;
  /** The order is paid. */
  paid: boolean;
};

export const NO_STAGE_FACTS: StageFacts = { quote: "none", orderForm: "none", signed: false, paid: false };

export type StageInput = StageFacts & {
  playbook: Pick<Playbook, "fields" | "outcomes" | "questionBudget">;
  fields: Record<string, DealFieldValue> | null | undefined;
  /** The deal's objections, either stored shape (lib/agent/core/objections.ts). */
  objections?: readonly StoredObjection[] | null;
  /** Agent messages already in the conversation (the fixed opener counts). */
  agentMessages: number;
};

export type StageResult = {
  stage: Stage;
  /** An open objection pauses the stage: settle it, then return. */
  paused: boolean;
  /** Labels of the playbook fields a quote cannot be made without and that are still unknown. */
  missingForQuote: string[];
  pricesAllowed: boolean;
  /** The block for the per-turn context. */
  instruction: string;
};

export const STAGE_TITLE: Record<Stage, string> = {
  open: "1 Open",
  understand: "2 Understand",
  recommend: "3 Recommend",
  quote_close: "4 Quote and close",
  order_form: "5 Order form",
  after: "6 After",
};

/** Before-quote playbook fields with no value yet (reserved keys never count). */
export function missingForQuote(playbook: Pick<Playbook, "fields">, fields: Record<string, DealFieldValue> | null | undefined) {
  return playbook.fields.filter((f) => f.stage === "before_quote" && !isReservedFieldKey(f.key) && !fields?.[f.key]?.value?.trim());
}

/** How often a field was asked, in words for the stage block. */
const timesText = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/**
 * Questions asked and not answered yet, with what the field's role allows
 * next (decision 1, B2): needed for the quote = once more in other words, then
 * quote on a stated assumption; helps the pitch = not in the next messages,
 * at most once more later when it fits, then never again.
 */
export function askedNotAnswered(playbook: Pick<Playbook, "fields">, fields: Record<string, DealFieldValue> | null | undefined): string[] {
  return playbook.fields
    .filter((f) => f.stage !== "before_order_form" && !isReservedFieldKey(f.key) && !fields?.[f.key]?.value?.trim() && askedCount(fields, f.key) > 0)
    .map((f) => {
      const n = askedCount(fields, f.key);
      const next = f.stage === "optional"
        ? n === 1
          ? "helps the pitch: do not ask it in the next messages; you may come back to it once, later, only when it fits what the buyer is talking about, woven into your reply"
          : "helps the pitch: do not ask it again"
        : n === 1
          ? "needed for the quote: ask once more, in different words, just before the quote"
          : "needed for the quote: do not ask again; quote on a stated assumption";
      return `${f.label} (asked ${timesText(n)}; ${next})`;
    });
}

export function deriveStage(input: StageInput): StageResult {
  const missingFields = missingForQuote(input.playbook, input.fields);
  const missing = missingFields.map((f) => f.label);
  const quoted = input.quote !== "none";
  const allowed = pricesAllowed(input.fields, quoted);
  const confirmed = recommendationConfirmed(input.fields);
  const asked = priceAsked(input.fields);
  const open = openObjections(input.objections);
  // Only questions the agent started count (B2): the recorded asks, never agent messages,
  // so answering the buyer's own questions or giving extra detail uses no budget.
  const questionsAsked = agentQuestionsAsked(input.fields);
  const budget = questionBudgetOf(input.playbook);

  let stage: Stage;
  if (input.paid || input.signed || input.orderForm === "sent") stage = "after";
  else if (input.quote === "ready") stage = "order_form";
  else if (input.quote === "awaiting_approval" || confirmed) stage = "quote_close";
  // A price question skips the check question of stage 3 once nothing is missing for a quote.
  else if (asked && missing.length === 0) stage = "quote_close";
  else if (input.agentMessages === 0) stage = "open";
  // The safety ceiling: whatever the setting and even after a price question.
  else if (questionsAsked >= QUESTION_CEILING) stage = "recommend";
  else if (asked) stage = "understand";
  // Nothing missing: recommend after the first exchange. Else at the seller's number.
  else if (missing.length === 0 ? questionsAsked >= 1 || input.agentMessages >= 2 : questionsAsked >= budget) stage = "recommend";
  else stage = "understand";

  const lines = [`## Stage now: ${STAGE_TITLE[stage]}`, ...stageLines(stage, { ...input, missing, missingFields, confirmed, asked, questionsAsked, budget })];
  if (stage === "open" || stage === "understand" || stage === "recommend" || (stage === "quote_close" && input.quote === "none")) {
    lines.push(`Still missing for a quote: ${missing.length ? missing.join(", ") : "nothing"}.`);
    const unanswered = askedNotAnswered(input.playbook, input.fields);
    if (unanswered.length) lines.push(`Asked and not answered: ${unanswered.join("; ")}.`);
  }
  lines.push(allowed
    ? "Prices: allowed. Take every number from the tools."
    : "Prices: not yet. State no price and no total. If the buyer asks the price, call update_deal_state with price_asked true, then answer with a number or range from search_catalog.");
  if (open.length) {
    const named = open.map((o) => (o.play ? `${objectionTitle(o)}${o.words ? `: "${o.words}"` : ""}` : objectionTitle(o))).join("; ");
    lines.push(`Paused: the buyer has an open objection (${named}). Take the next step of its card not yet used, unless the buyer moved on: a buying signal ends it at once. Record it with update_deal_state objection (settled or dropped when it ends), then return to the stage.`);
  }
  return { stage, paused: open.length > 0, missingForQuote: missing, pricesAllowed: allowed, instruction: lines.join("\n") };
}

type Detail = StageInput & { missing: string[]; missingFields: PlaybookField[]; confirmed: boolean; asked: boolean; questionsAsked: number; budget: number };

/** What to do about the fields still missing for the quote, by how often each was asked. */
function missingForQuoteLine(d: Detail): string {
  const by = (pick: (n: number) => boolean) => d.missingFields.filter((f) => pick(askedCount(d.fields, f.key))).map((f) => f.label);
  const first = by((n) => n === 0);
  const again = by((n) => n === 1);
  const assume = by((n) => n >= 2);
  const parts = [
    first.length ? `ask for ${first.join(", ")} in one short question` : "",
    again.length ? `ask once more for ${again.join(", ")}, in different words` : "",
    assume.length ? `quote on an assumption for ${assume.join(", ")} (create_quote with assumed) and say it in the close, e.g. "I've quoted for <the value you assumed>; tell me if that's different"` : "",
  ].filter(Boolean);
  return `Do: ${parts.join("; then ")}. As soon as nothing is left to ask, call create_quote. Never hold the quote back for a question the buyer skipped twice.`;
}

function stageLines(stage: Stage, d: Detail): string[] {
  const meetingOrHandOff = d.playbook.outcomes.meeting ? "offer a meeting" : "hand off to a person";
  switch (stage) {
    case "open":
      return [
        "Do: this is your first message. Say who you are in a few words, react to what the buyer wrote, and ask one easy question about their situation today.",
        "If the buyer already asked for a price or a quote, skip the easy question: call update_deal_state with price_asked true and ask only what the quote cannot be made without.",
        "Moves on when: the buyer answers.",
      ];
    case "understand": {
      if (d.asked) {
        return [
          "The buyer asked the price, so skip ahead.",
          "Do: answer the price now with a number or range from search_catalog, say in a few words what it depends on, then ask only what the quote cannot be made without. Drop every question that only helps the pitch.",
          "Moves on when: nothing is missing for a quote. Then make the quote.",
        ];
      }
      const left = Math.max(1, d.budget - d.questionsAsked);
      return [
        `Do: react to the buyer's last answer, then ask one question that changes which products you recommend. You have ${left} question${left === 1 ? "" : "s"} left before you must recommend. Answering the buyer's own questions does not use them.`,
        `Ask the questions needed for the quote first. ${HELPS_THE_PITCH_RULE} Drop it when the buyer shows a buying signal. Record each question you start with update_deal_state asked.`,
        "Moves on when: you know enough to recommend one set. If you already do, recommend now (stage 3) and ask nothing more.",
      ];
    }
    case "recommend":
      return [
        "Do: recommend one set now, in one message with four parts: what you understood, the set in plain words, what it gives this buyer, a check question. No prices, no SKUs. Look the products up first (search_catalog).",
        ...(d.missing.length ? ["If something is still missing for a quote, ask for it only after the buyer confirms, in one short question."] : []),
        `If the buyer says it does not fit: ask what does not fit and recommend once more. After a second no, ${meetingOrHandOff}.`,
        "Moves on when: the buyer says it sounds right. Then, in the same turn: call update_deal_state with recommendation_confirmed true, and go on to the quote.",
      ];
    case "quote_close":
      if (d.quote === "awaiting_approval") {
        return [
          "The quote waits for the seller's approval: you asked the team for that price.",
          "Do: tell the buyer once that you have asked the team to approve that price, then keep going: answer questions and handle anything else they raise. Do not send the order form and do not present the totals as final.",
          "Moves on when: the team decides. The app tells the buyer either way; a decline shows under \"Price approval\".",
        ];
      }
      return [
        d.confirmed ? "The buyer confirmed the recommendation." : "The buyer asked the price and nothing is missing for a quote.",
        d.missing.length
          ? missingForQuoteLine(d)
          : "Do: call create_quote now (check_fit first). Do not ask whether to prepare a quote. If you do not yet know which items or how many, ask that one question first.",
        "With the quote, close in the same message: a short lead-in, then offer to send the order form now, with the delivery phrase from the result.",
        "Moves on when: the quote is sent.",
      ];
    case "order_form":
      if (!d.playbook.outcomes.orderForm) {
        return [
          "The quote is with the buyer. This seller does not use the order form.",
          `Do: answer questions about the quote. When the buyer agrees, ${meetingOrHandOff}.`,
          "If the buyer changes what they need: make a new quote at once. Do not recommend again.",
          "Moves on when: the buyer agrees.",
        ];
      }
      return [
        d.orderForm === "outdated"
          ? "The buyer has a new quote; the order form sent before was for the old one."
          : "The quote is with the buyer.",
        'Do: if the buyer agrees ("yes", "ok", "send it"), call send_order_form at once and send the link with one line on what to do there: fill in company details, sign and pay. Do not ask for company or signer details in chat.',
        "If the buyer has a question or an objection: answer it, then ask the close again. If you have not asked the close yet, ask it now.",
        "If the buyer changes what they need: make a new quote at once. Do not recommend again.",
        "Moves on when: the link is sent.",
      ];
    case "after":
      if (d.paid) {
        return [
          "The order is paid.",
          "Do: thank the buyer once and answer questions. No new selling.",
        ];
      }
      return [
        d.signed ? "The buyer signed the order form; payment is not confirmed yet." : "The order form is with the buyer.",
        'Do: answer questions in one or two sentences. When the buyer says they signed or paid, call check_payment and tell them what it shows. To a short "ok" or "thanks", reply once that you will confirm here when the order goes through, then stay quiet.',
        "Do not ask for details the form collects. Do not sell more.",
        "If the buyer changes what they need: make a new quote and close again. Do not recommend again.",
        "Moves on when: the order is paid, or the buyer ends the chat.",
      ];
  }
}

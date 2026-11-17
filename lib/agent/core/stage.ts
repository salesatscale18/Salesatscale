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
import type { DealFieldValue, Playbook } from "@/db/schema";
import { isReservedFieldKey, priceAsked, pricesAllowed, recommendationConfirmed } from "./facts";

export type Stage = "open" | "understand" | "recommend" | "quote_close" | "order_form" | "after";

/** Most questions in stage Understand before the agent must recommend. */
export const MAX_UNDERSTAND_QUESTIONS = 3;

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
  playbook: Pick<Playbook, "fields" | "outcomes">;
  fields: Record<string, DealFieldValue> | null | undefined;
  objections?: { text: string; handled: boolean }[] | null;
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

export function deriveStage(input: StageInput): StageResult {
  const missing = missingForQuote(input.playbook, input.fields).map((f) => f.label);
  const quoted = input.quote !== "none";
  const allowed = pricesAllowed(input.fields, quoted);
  const confirmed = recommendationConfirmed(input.fields);
  const asked = priceAsked(input.fields);
  const open = (input.objections ?? []).filter((o) => !o.handled);
  // The opener is one message; each later agent message in Understand is at most one question.
  const questionsAsked = Math.max(0, input.agentMessages - 1);

  let stage: Stage;
  if (input.paid || input.signed || input.orderForm === "sent") stage = "after";
  else if (input.quote === "ready") stage = "order_form";
  else if (input.quote === "awaiting_approval" || confirmed) stage = "quote_close";
  // A price question skips the check question of stage 3 once nothing is missing for a quote.
  else if (asked && missing.length === 0) stage = "quote_close";
  else if (input.agentMessages === 0) stage = "open";
  else if (asked) stage = "understand";
  else if (missing.length === 0 ? questionsAsked >= 1 : questionsAsked >= MAX_UNDERSTAND_QUESTIONS) stage = "recommend";
  else stage = "understand";

  const lines = [`## Stage now: ${STAGE_TITLE[stage]}`, ...stageLines(stage, { ...input, missing, confirmed, asked, questionsAsked })];
  if (stage === "open" || stage === "understand" || stage === "recommend" || (stage === "quote_close" && input.quote === "none")) {
    lines.push(`Still missing for a quote: ${missing.length ? missing.join(", ") : "nothing"}.`);
  }
  lines.push(allowed
    ? "Prices: allowed. Take every number from the tools."
    : "Prices: not yet. State no price and no total. If the buyer asks the price, call update_deal_state with price_asked true, then answer with a number or range from search_catalog.");
  if (open.length) {
    lines.push(`Paused: the buyer has an open objection (${open.map((o) => `"${o.text}"`).join("; ")}). Settle it first: acknowledge, give the approved answer, check that it settled it. Record it as handled, then return to the stage.`);
  }
  return { stage, paused: open.length > 0, missingForQuote: missing, pricesAllowed: allowed, instruction: lines.join("\n") };
}

type Detail = StageInput & { missing: string[]; confirmed: boolean; asked: boolean; questionsAsked: number };

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
          "Do: answer the price now with a number or range from search_catalog, say in a few words what it depends on, then ask only what the quote cannot be made without. Drop every other question.",
          "Moves on when: nothing is missing for a quote. Then make the quote.",
        ];
      }
      const left = Math.max(1, MAX_UNDERSTAND_QUESTIONS - d.questionsAsked);
      return [
        `Do: react to the buyer's last answer, then ask one question that changes which products you recommend. You have ${left} question${left === 1 ? "" : "s"} left before you must recommend.`,
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
          "The quote waits for the seller's approval.",
          "Do: tell the buyer you are confirming the price with the team and will get back to them. Do not send the order form and do not present the totals as final.",
          "Moves on when: the seller approves the quote.",
        ];
      }
      return [
        d.confirmed ? "The buyer confirmed the recommendation." : "The buyer asked the price and nothing is missing for a quote.",
        d.missing.length
          ? "Do: ask for what is still missing for a quote, in one short question. As soon as you have it, call create_quote."
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

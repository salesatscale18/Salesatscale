/**
 * Stage 2 (playbook draft): the instruction sent after the cached corpus,
 * followed by the run's data (facts, catalog summary, current playbook) as
 * JSON with a fixed key order. Bump PROMPT_VERSION on any change.
 */
import { PLAY_KEYS } from "@/db/schema";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { PLAYBOOK_TOOL } from "./system";

export const PROMPT_VERSION = "playbook-v7";

/** Field keys the order form prefill reads (lib/orders/prefill.ts): suggest these exact keys for those details. */
export const ORDER_FORM_KEYS: Record<string, string> = {
  company_name: "the buyer's legal company name",
  company_id: "company or tax registration number",
  billing_address: "billing address",
  delivery_address: "delivery or installation address",
  invoice_email: "email for invoices",
  signatory_name: "name of the person who signs",
  signatory_role: "role of the person who signs",
  po_number: "purchase order number",
};

export const PLAYBOOK_INSTRUCTION = `Task: draft the sales agent's playbook from the corpus above. Call ${PLAYBOOK_TOOL} once.
Below this task you get, as JSON: the facts found so far (approved and suggested), a summary of the catalog, the current playbook, the order-form field keys, and the selling situations (plays) the agent has a default card for.
Base the playbook first on how the seller's reps actually sell in the recorded calls, then on documents and the website.
- goal: who the agent sells to and what a win is: a signed order form with payment, or a meeting with the seller's team.
- fields: what the agent must learn from the buyer to qualify, to price and to fill the order form, each with its role (stage): before_quote = needed for the quote (the quote cannot be made without it, e.g. the number of sites or items); helpful = helps the pitch (e.g. how they handle it today, the current supplier); before_order_form = filled in the order form (company and signer details). For an order-form detail use exactly the key listed under order_form_keys. Reuse the key of a field in the current playbook when it is the same field. asked_in_calls counts the call transcripts in which a rep asked it.
- objections: the objection as buyers say it and the answer that worked; outcome counts what followed over the calls.
- limits: every price, discount, free extra or special term heard in a call or written in a document, and when reps offer a meeting or hand over to a person. Say which setting it is: discount_cap (with the percentage), custom_pricing_quantity (with the item's SKU and the quantity), offer_meeting or hand_off (with the condition), or other (for example "Installation is free from 3 sites"). These are only suggestions; the seller approves each one.
- tone: how the reps talk, in one sentence.
- never: real prohibitions only: what the agent must never say or do, worded to follow "Never". Prices, discounts and special terms belong in limits, not here.
- discovery_questions: good open questions reps ask that are not already a field, each with its role: before_quote when the quote cannot be made without the answer, else helpful.
- opener: what leads usually ask about when they reach out (up to 6 topics, the most common first, each fitting "You asked about ..."), and the easy question reps open with about the buyer's situation today. Add Hebrew versions when the corpus or the seller sells in Hebrew.
- play_content: for each play the corpus supports, the seller's facts for that situation, following the play's seller_hint (for example the gap common existing solutions leave, or the entry price and what drives the total). Facts only, no instructions to the agent. A price may come from a document or the website, never only from a call. Put proof points (customers the seller names, numbers and results, testimonials, certifications, awards, guarantees; facts with topic Proof or Customers) into proof, and also into tried_failed when they answer a failed earlier attempt. Put value points (buyer problems and what each feature brings; topic Value) into value and too_expensive. Put differentiators (topic Differentiators) into competitor and existing_solution, and who the product suits (topic Ideal customer) into fit. Use the play keys exactly as listed under plays, and the claim's own figures.
- play_cards: only when call transcripts clearly show the reps' own way of handling a situation: when it applies, 2 to 5 moves in order, an example reply and a reply to avoid. Otherwise leave it out: the default card applies.
- catalog_items: for each catalog SKU, the plain name a buyer would use in chat and one sentence on what the buyer gets. Leave out items whose current plain_name and value_line already say this.
- Leave out anything the current playbook already says with the same meaning. Use only items you can support with evidence from the corpus.
- Evidence must cite the source the words come from: the quote is copied from the section whose source id and locator you give. Never credit words from a call to a document or note, or the other way round.`;

export type PlaybookStageData = {
  facts: { topic: string; statement: string; status: string }[];
  catalog: { sku: string; name: string; kind: string; unit: string; charge: string; plainName?: string | null; valueLine?: string | null }[];
  playbook: unknown;
  calls: number;
};

/** The instruction plus the stage data. Keys in a fixed order, so the same data gives the same bytes. */
export function playbookInstruction(data: PlaybookStageData): string {
  const json = JSON.stringify({
    calls_in_corpus: data.calls,
    order_form_keys: ORDER_FORM_KEYS,
    facts: data.facts.map((f) => ({ topic: f.topic, statement: f.statement, status: f.status })),
    catalog: data.catalog.map((c) => ({ sku: c.sku, name: c.name, kind: c.kind, unit: c.unit, charge: c.charge, plain_name: c.plainName ?? "", value_line: c.valueLine ?? "" })),
    current_playbook: data.playbook,
    plays: PLAY_KEYS.map((k) => ({ play: k, title: DEFAULT_PLAYS[k].title, when: DEFAULT_PLAYS[k].when, seller_hint: DEFAULT_PLAYS[k].sellerContentHint })),
  });
  return `${PLAYBOOK_INSTRUCTION}\n\n<data>\n${json}\n</data>`;
}

/**
 * Call wiring v2 (test calls; CALL_WIRING_V2_FOR_BUYER_CALLS, lib/voice/settings.ts), 27 Nov 2026: one imperative
 * "next action" line on a call's tool result, built from the offer data fields the agent's tools give (agent memory,
 * lib/agent/tools.ts):
 * - check_offer with nothing more to offer, while an earlier offer still stands on a live quote: `standing_offer`
 *   { id, terms, quote }.
 * - create_quote refused "Discount not from an offer" while a standing offer of that percent exists: `matching_offer`
 *   { id, terms, quote, lines }.
 * The line is guidance for the model, not words to say: it names the offer id (OF-…) and the quote number (Q-…), never
 * a database id. Pure: the engine decides when it applies and puts it on the result as `next`.
 */

/** A database row id (a uuid): never part of the line. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type OfferRefData = { id: string; terms: string; quote: string };

/** The terms without their closing full stop (the line adds its own). */
const sentence = (terms: string) => terms.trim().replace(/[.\s]+$/, "");

/** The offer reference a tool result carries, or null when a field is missing, empty, or looks like an internal id. */
function offerRefOf(v: unknown): OfferRefData | null {
  if (!v || typeof v !== "object") return null;
  const { id, terms, quote } = v as Record<string, unknown>;
  if (typeof id !== "string" || typeof terms !== "string" || typeof quote !== "string") return null;
  const ref = { id: id.trim(), terms: sentence(terms), quote: quote.trim() };
  if (!ref.id || !ref.terms || !ref.quote || [ref.id, ref.terms, ref.quote].some((s) => UUID.test(s))) return null;
  return ref;
}

/** The standing offer line (check_offer found nothing more). Terms may be more than one sentence: they come last. */
export const standingOfferNext = (o: OfferRefData) =>
  `An earlier offer still stands on ${o.quote}. If the buyer accepts it, call create_quote with offer ${o.id}; do not make a new offer. Its terms: ${sentence(o.terms)}.`;

/** The matching offer line (create_quote refused a discount given without its offer id). */
export const matchingOfferNext = (o: OfferRefData) =>
  `Call create_quote again with offer ${o.id} and that offer's lines; do not change the lines. Its terms: ${sentence(o.terms)}.`;

/** The next-action line for this tool's own result, or null when it carries neither field. */
export function offerNextLine(name: string, result: Record<string, unknown>): string | null {
  if (name === "check_offer" && result.ok === true && result.offer == null) {
    const o = offerRefOf(result.standing_offer);
    return o ? standingOfferNext(o) : null;
  }
  if (name === "create_quote" && result.rule === "Discount not from an offer") {
    const o = offerRefOf(result.matching_offer);
    return o ? matchingOfferNext(o) : null;
  }
  return null;
}

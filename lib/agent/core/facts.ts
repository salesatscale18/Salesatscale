/**
 * Conversation facts the stage logic reads (P11). They live in the deal
 * state's `fields` under reserved keys (leading underscore), so no playbook
 * field can collide with them and no migration is needed.
 */
import type { DealFieldValue } from "@/db/schema";

/** Set (value "yes") when the buyer confirmed the recommended set (stage 3 → 4). */
export const RECOMMENDATION_CONFIRMED_KEY = "_recommendation_confirmed";
/** Set (value "yes") when the buyer asked for the price before the recommendation was confirmed. */
export const PRICE_ASKED_KEY = "_price_asked";

const yes = (fields: Record<string, DealFieldValue> | null | undefined, key: string) => fields?.[key]?.value?.trim().toLowerCase() === "yes";

export const recommendationConfirmed = (fields: Record<string, DealFieldValue> | null | undefined) => yes(fields, RECOMMENDATION_CONFIRMED_KEY);
export const priceAsked = (fields: Record<string, DealFieldValue> | null | undefined) => yes(fields, PRICE_ASKED_KEY);
/** Prices may be shown to the agent (and so to the buyer) once either fact is set, or a quote exists. */
export const pricesAllowed = (fields: Record<string, DealFieldValue> | null | undefined, quoted = false) => quoted || recommendationConfirmed(fields) || priceAsked(fields);
/** Reserved keys are never shown as deal-state fields in the UI. */
export const isReservedFieldKey = (key: string) => key.startsWith("_");

/**
 * How often the agent asked for a playbook field (P11 follow-up, decision 1):
 * `_asked_<field key>` holds the count as a number, recorded through
 * update_deal_state's `asked`. Reserved, so never shown as a field.
 */
export const ASKED_PREFIX = "_asked_";
export const askedKey = (fieldKey: string) => `${ASKED_PREFIX}${fieldKey}`;
export function askedCount(fields: Record<string, DealFieldValue> | null | undefined, fieldKey: string): number {
  const n = Number(fields?.[askedKey(fieldKey)]?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

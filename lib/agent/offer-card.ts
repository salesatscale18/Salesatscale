/**
 * The seller-only offer card in a thread (board OfferTool, owner decision 6 of
 * 23 Nov): one per ok check_offer call, with its place in the seller's order,
 * the reason, the terms, the figures before and after, what was tried before,
 * and the state inferred from the calls that followed. Pure; never shown to
 * the buyer. Lead page, Conversations and the test lab use the same model.
 */
import { formatMoney } from "@/lib/domain/money";
import { t, type MessageKey } from "@/lib/i18n";
import type { OfferOutcome } from "./offers";
import { offerHistory, offerRecordOf, type NoOfferRecord, type OfferCall, type OfferRecord } from "./offer-records";

export type OfferCardView = {
  key: string;
  /** "Offer · Decide now", or "No more offers". */
  title: string;
  /** "offer 3 of 4 in your order" (none for "No more offers"). */
  place: string | null;
  reason: string;
  terms: string;
  /** Old total struck, new total ("₪7,717.20 → ₪7,331.34 today · monthly unchanged"). */
  before: string | null;
  after: string | null;
  recurringNote: string | null;
  tried: string[];
  state: OfferOutcome | null;
  /** Accepted: the quote that carries it. */
  acceptedQuote: { id: string; number: number | null } | null;
  /** The folded chip ("Offer: 3% if signed within 7 days"). */
  chip: string;
};

type ThreadCall = { name: string; input: Record<string, unknown>; result: Record<string, unknown>; outcome: string };

const typeName = (type: string) => t(`playbook.offers.type.${type}` as MessageKey);

function triedText(tried: OfferRecord["tried"]): string[] {
  return tried.map((x) => `${x.n} · ${typeName(x.type)} (${x.state === "skipped" ? x.reason ?? t("offers.card.skipped") : t(`status.offer.${x.state}` as MessageKey).toLowerCase()})`);
}

/**
 * Offer cards by the id of the message whose calls made them, for a thread
 * (messages in order, each with its tool calls). Outcomes read every call of
 * the thread.
 */
export function offerCardsByMessage(thread: readonly { message: { id: string; createdAt: Date }; calls: readonly ThreadCall[] }[], now = new Date()): Map<string, OfferCardView[]> {
  const calls: OfferCall[] = thread.flatMap(({ message, calls }) => calls
    .filter((c) => (c.name === "check_offer" || c.name === "create_quote") && c.outcome === "ok")
    .map((c) => ({ name: c.name, input: c.input, result: c.result, outcome: c.outcome, at: message.createdAt.getTime() })));
  const outcomes = new Map(offerHistory(calls, now).map((h) => [h.record.id, h]));
  const quoteNumber = new Map<string, number>();
  for (const c of calls) {
    if (c.name === "create_quote" && typeof c.result.quote_id === "string" && typeof c.result.quote === "string") {
      const n = Number(c.result.quote.replace(/^Q-/, "").split(" ")[0]);
      if (Number.isInteger(n)) quoteNumber.set(c.result.quote_id, n);
    }
  }
  const out = new Map<string, OfferCardView[]>();
  for (const { message, calls: own } of thread) {
    const cards: OfferCardView[] = [];
    own.forEach((c, i) => {
      if (c.name !== "check_offer" || c.outcome !== "ok") return;
      const reasonOf = (r: string) => (r === "next" || !r ? t("offers.card.reason_next") : t("offers.card.reason_named", { trade: typeName(r) }));
      const rec = offerRecordOf(c.result);
      if (rec) {
        const h = outcomes.get(rec.id);
        const money = (m: number) => formatMoney(m, rec.currency);
        const recurringSame = rec.before.recurringMinor === rec.after.recurringMinor;
        cards.push({
          key: `${message.id}-${i}`,
          title: t("offers.card.title", { trade: typeName(rec.type) }),
          place: t("offers.card.place", { n: rec.place.n, of: rec.place.of }),
          reason: reasonOf(rec.reason),
          terms: rec.terms,
          before: money(rec.before.todayMinor),
          after: money(rec.after.todayMinor),
          recurringNote: rec.after.recurringMinor === 0 ? null : recurringSame ? t("offers.card.monthly_same") : t("offers.card.monthly_new", { amount: money(rec.after.recurringMinor) }),
          tried: triedText(rec.tried),
          state: h?.outcome ?? "offered",
          acceptedQuote: h?.acceptedQuoteId ? { id: h.acceptedQuoteId, number: quoteNumber.get(h.acceptedQuoteId) ?? null } : null,
          chip: t("offers.card.chip", { terms: rec.short }),
        });
        return;
      }
      const none = c.result.record as NoOfferRecord | undefined;
      if (none?.exhausted) {
        cards.push({
          key: `${message.id}-${i}`, title: t("offers.card.none_title"), place: null, reason: reasonOf(String(c.input.reason ?? "next")),
          terms: t("offers.card.none_terms"), before: null, after: null, recurringNote: null, tried: triedText(none.tried ?? []),
          state: null, acceptedQuote: null, chip: t("offers.card.none_chip"),
        });
      }
    });
    if (cards.length) out.set(message.id, cards);
  }
  return out;
}

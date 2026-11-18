/**
 * Reply buttons after the quote's close in the buyer simulator chat ("Sounds
 * good" / "Change something", board QuoteChat). Pure and tiny, so the client
 * chat imports it without the i18n dictionaries.
 */
type ChatItem = { id: string; from: string; kind?: string; previews?: readonly unknown[] };

/** A message that carries an order-form link (its card): the next step already happened. */
const sentForm = (m: ChatItem) => (m.previews?.length ?? 0) > 0;

/**
 * The message the reply buttons go under: the latest close after the latest
 * quote card, while that card is current (sent), the buyer has not replied
 * since and no order form was sent after it. The close is the agent's last
 * message after the card, or the app's close after a seller approval (which
 * may follow buyer messages sent while the placeholder waited). Null otherwise.
 */
export function replyButtonsAfter(items: readonly ChatItem[], cards: Record<string, { state: string }>): string | null {
  let at = -1;
  for (let i = items.length - 1; i >= 0; i--) if (cards[items[i].id]) { at = i; break; }
  if (at < 0 || cards[items[at].id].state !== "sent") return null;
  const after = items.slice(at + 1);
  if (after.some(sentForm)) return null;
  // The app's own close after a seller approval (lib/agent/quote-approval.ts): the card may be the
  // placeholder replaced in place, with buyer messages since; the close is still the latest message.
  if (items.at(-1)?.kind === "quote_close") return items.at(-1)!.id;
  const last = after.at(-1);
  if (!last || last.from !== "agent" || after.some((m) => m.from === "buyer" || cards[m.id])) return null;
  return last.id;
}

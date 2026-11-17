/**
 * Reply buttons after the quote's close in the buyer simulator chat ("Sounds
 * good" / "Change something", board QuoteChat). Pure and tiny, so the client
 * chat imports it without the i18n dictionaries.
 */
/**
 * The message the reply buttons go under: the latest message, when it is the
 * agent's and follows a quote card that is current (sent), with no buyer
 * message since that card, or when it is the app's close after the latest
 * card, which is current. Null otherwise.
 */
export function replyButtonsAfter(items: { id: string; from: string; kind?: string }[], cards: Record<string, { state: string }>): string | null {
  let at = -1;
  for (let i = items.length - 1; i >= 0; i--) if (cards[items[i].id]) { at = i; break; }
  if (at < 0 || cards[items[at].id].state !== "sent") return null;
  // The app's own close after a seller approval (lib/agent/quote-approval.ts): the card may be the
  // placeholder replaced in place, with buyer messages since; the close is still the latest message.
  if (items.at(-1)?.kind === "quote_close") return items.at(-1)!.id;
  const after = items.slice(at + 1);
  const last = after.at(-1);
  if (!last || last.from !== "agent" || after.some((m) => m.from === "buyer" || cards[m.id])) return null;
  return last.id;
}

/**
 * RB3: the booking card goes right under the agent's line that offered it.
 *
 * The agent's request_callback posts the card (an app message) while the turn
 * runs; the agent's own line ("Of course. Pick a time that suits you…") is
 * stored when the turn ends, so by time the card comes first. The buyer page
 * shows the line first and the card right under it: a card followed by its
 * turn's line (the next agent message that carries an ok request_callback,
 * with only agent messages in between) moves to right after that line. A card
 * whose line is not there (yet) stays where it is. Used by the server
 * (buyerChat) and by the page on every poll, so a line that arrives after its
 * card moves the card under it. Pure; unit-tested.
 */
export type OrderRow = { id: string; actor: string; isCard: boolean; offersCard: boolean };

export function placeBookingCards<T>(rows: readonly T[], row: (r: T) => OrderRow): T[] {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    if (!row(out[i]).isCard) continue;
    let j = i + 1;
    while (j < out.length && row(out[j]).actor === "agent" && !row(out[j]).offersCard) j++;
    if (j < out.length && row(out[j]).offersCard) {
      // Card out, then back in right after its line (the line moved up one place).
      const [moved] = out.splice(i, 1);
      out.splice(j, 0, moved);
      i = j;
    }
  }
  return out;
}

/**
 * The poll cursor: the newest message by time (then id, as the server orders them). Not always the last one shown:
 * a booking card shows under the agent's line that offered it, though it was stored first.
 */
export const cursorOf = (ms: readonly { id: string; at: string }[]): string | null =>
  ms.reduce<{ id: string; at: string } | null>((a, m) => (!a || m.at > a.at || (m.at === a.at && m.id > a.id) ? m : a), null)?.id ?? null;

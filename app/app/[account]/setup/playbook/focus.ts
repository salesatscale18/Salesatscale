/**
 * Where keyboard focus goes after a row save, for every list part (Opening
 * topics, What it asks, Objections, Never do). Pure, so it is unit-tested.
 *
 * A save answers before the refreshed rows arrive, and rows are keyed by their
 * text: the edited row (and, after a delete, the deleted one) is still on the
 * page when focus is asked for, then it is replaced and focus fell to the page
 * body. So a request stays open for a few seconds: the target takes focus at
 * once, and again when its element is replaced while focus is lost.
 */

/** A focus request: the row id (`topic.2`, `objection.add`), when it was made, whether a target took it. */
export type FocusRequest = { id: string; at: number; done?: boolean };

/** How long a request stays open (the refresh after a save comes well within it). */
export const FOCUS_WINDOW_MS = 5000;

/**
 * Whether the target `id` takes focus now: the request is for it and still
 * open, and either no target took it yet or focus was lost since (on the body,
 * nowhere, or on an element that left the page).
 */
export function shouldTakeFocus(req: FocusRequest | null, id: string, now: number, focused: { isConnected: boolean } | null, body: unknown): boolean {
  if (!req || req.id !== id || now - req.at > FOCUS_WINDOW_MS) return false;
  return !req.done || !focused || focused === body || !focused.isConnected;
}

/**
 * The row whose edit control gets focus after deleting the row shown at `pos`:
 * the next row, else the previous one, else the Add button (`addId`).
 * `shown`: the stored index of each row in the order shown; `idOf`: a row's id
 * from its stored index once the deleted row is gone (later indices move up one).
 */
export function focusAfterDelete(shown: readonly number[], pos: number, idOf: (index: number) => string, addId: string): string {
  const deleted = shown[pos];
  const id = (i: number) => idOf(i > deleted ? i - 1 : i);
  if (pos + 1 < shown.length) return id(shown[pos + 1]);
  if (pos > 0) return id(shown[pos - 1]);
  return addId;
}

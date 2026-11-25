/**
 * The quote-quantities guard (TEST calls only, while QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS is off): a create_quote on a
 * call runs only when every line's quantity is one the buyer gave. A GPT-Realtime 2.1 test call (New, 23 Nov 2026)
 * quoted 1 unit for 2 sites without ever asking how many units the buyer needed. Pure, English and Hebrew (the
 * number words lineSaysNumber knows).
 *
 * A line quantity is grounded when it is:
 * - a number the buyer said (digits or number words) in any buyer line of the conversation (this call's and the chat's);
 * - the saved number of sites;
 * - the product or the sum of two such numbers ("two sites, three in each" grounds 6);
 * - a number the agent said aloud on this call that the buyer's next line clearly agreed to (clearYes).
 * Never a dead-lock: after one refusal and at least one later buyer line, a quantity the agent said aloud since that
 * refusal is accepted too, even without an explicit yes.
 */
import { clearYes } from "./form-agreement";

/**
 * The quote-quantities guard on BUYER calls. Off: it runs on test calls only (the test lab). Turn on once test calls
 * proved it.
 */
export const QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS = false;

/** Whether the guard runs on this call. */
export const quoteQuantityGuardOn = (isTest: boolean, forBuyers: boolean = QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS) => isTest || forBuyers;

const NUMBER_WORDS: Record<number, RegExp> = {
  0: /\b(zero|none)\b|אפס/i, 1: /\b(one|a single|single)\b|אחד|אחת/i, 2: /\b(two|both|a couple)\b|שתיים|שניים|שני|שתי/i,
  3: /\bthree\b|שלוש|שלושה/i, 4: /\bfour\b|ארבע|ארבעה/i, 5: /\bfive\b|חמש|חמישה/i, 6: /\bsix\b|שש|שישה/i,
  7: /\bseven\b|שבע|שבעה/i, 8: /\beight\b|שמונה/i, 9: /\bnine\b|תשע|תשעה/i, 10: /\bten\b|עשר|עשרה/i,
};

/** Whether a line says this number, in digits or in words (English, Hebrew; up to ten in words). */
export function lineSaysNumber(line: string, n: number): boolean {
  if (new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(line)) return true;
  return NUMBER_WORDS[n]?.test(line) ?? false;
}

/** Above this, a quantity is grounded only when it was said as it is (no product or sum is searched). */
const MAX_COMBINED = 1_000;

export type QuantityLine = { role: string; text: string };

/**
 * The first line of a create_quote whose quantity is not grounded, or null when every one is.
 * - `buyerLines`: every buyer line of the conversation (the chat's and this call's);
 * - `callLines`: this call's lines in order (agent and buyer), for a number the agent proposed and the buyer agreed to;
 * - `sites`: the saved number of sites (deal state), when there is one;
 * - `refusedAt`: the length of `callLines` when this guard last refused on this call (null: never).
 * Lines with no positive whole quantity are left to the tool (it refuses them itself).
 */
export function ungroundedQuoteLine(o: {
  lines: readonly { sku: string; qty: number }[]; buyerLines: readonly string[]; callLines: readonly QuantityLine[]; sites: number | null; refusedAt: number | null;
}): { sku: string; qty: number } | null {
  const said = new Map<number, boolean>();
  const buyerSaid = (n: number) => {
    let v = said.get(n);
    if (v === undefined) {
      v = (o.sites !== null && o.sites === n) || o.buyerLines.some((l) => lineSaysNumber(l, n));
      said.set(n, v);
    }
    return v;
  };
  const combined = (q: number) => {
    if (q > MAX_COMBINED) return false;
    for (let a = 1; a < q; a++) {
      if (!buyerSaid(a)) continue;
      if (q % a === 0 && buyerSaid(q / a)) return true;
      if (buyerSaid(q - a)) return true;
    }
    return false;
  };
  // A number the agent said aloud, agreed to by the buyer's very next line.
  const agreed = (q: number) => o.callLines.some((l, i) => {
    if (l.role !== "agent" || !lineSaysNumber(l.text, q)) return false;
    const next = o.callLines.slice(i + 1).find((x) => x.role === "buyer" || x.role === "agent");
    return next?.role === "buyer" && clearYes(next.text);
  });
  // No dead-lock: refused once, and the buyer spoke since: a number the agent said aloud since the refusal.
  const since = o.refusedAt !== null ? o.callLines.slice(o.refusedAt) : [];
  const unlocked = since.some((l) => l.role === "buyer");
  const saidSince = (q: number) => unlocked && since.some((l) => l.role === "agent" && lineSaysNumber(l.text, q));
  for (const l of o.lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) continue;
    if (buyerSaid(l.qty) || combined(l.qty) || agreed(l.qty) || saidSince(l.qty)) continue;
    return { sku: l.sku, qty: l.qty };
  }
  return null;
}

/** The rule name the refusal carries (the steps view and the transcript chip show it). */
export const QUANTITY_NOT_GIVEN_RULE = "Quantity not given";

/**
 * The refusal the model gets, in the language the call speaks (Hebrew or English): no money figure, the item whose
 * quantity the buyer has not given, and the one question to ask now.
 */
export function quantityNotGiven(item: string, language: string): { rule: string; message: string } {
  const message = language === "he"
    ? `לא נוצרה הצעת מחיר: הקונה עוד לא אמר כמה ${item} הוא צריך. שאל אותו עכשיו רק את השאלה הזאת, במשפט אחד קצר, וחכה לתשובה. אם הוא לא יודע להגיד, הצע מספר בקול וקבל ממנו "כן" לפני שאתה יוצר הצעת מחיר.`
    : `No quote was made: the buyer has not said how many ${item} they need. Ask the buyer that one question now, in one short sentence, and wait for the answer. If they cannot say, propose a number aloud and get their yes before you quote.`;
  return { rule: QUANTITY_NOT_GIVEN_RULE, message };
}

/** The log line of one decision (never the buyer's words). */
export function quantityLogLine(refused: { sku: string; qty: number } | null): string {
  return refused ? `quote quantities: refused item=${refused.sku.replace(/\s+/g, "").slice(0, 40)} qty=${refused.qty}` : "quote quantities: ok";
}

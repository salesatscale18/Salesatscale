/**
 * Near-duplicate facts (pure, no AI; unit-tested). Stage 1 can restate a fact
 * in other words ("VAT (18%)" / "18% VAT", "One GW-10 gateway" / "One GW-10
 * site gateway"). storeFacts skips a new fact that is:
 * - the same set of words as any fact of the account (word order, case and
 *   punctuation ignored), or
 * - a near-duplicate of a fact from the same source: token-set similarity
 *   (shared words / all words) of at least NEAR_DUPLICATE_THRESHOLD.
 * Never a duplicate when the numbers differ ("12-month" / "24-month") or only
 * one of the two is negated ("includes" / "does not include").
 */

/** Shared words / all words, from which a fact of the same source is a near-duplicate. */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;

/** Words that turn a statement around (English and Hebrew). */
const NEGATIONS = new Set(["not", "no", "never", "without", "cannot", "dont", "doesnt", "isnt", "arent", "wont", "cant", "לא", "אין", "ללא", "בלי", "אינו", "אינה", "אינם"]);

/**
 * The words of a statement: NFKC, lower case, thousands separators and
 * punctuation removed. A number keeps its sign, decimals and unit marks
 * ("-40°c", "±0.3°c", "18%"); a code keeps its hyphen ("gw-10").
 */
export function factTokens(text: string): string[] {
  const s = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const out: string[] = [];
  for (const raw of s.split(/[^\p{L}\p{N}%°±+\-.]+/u)) {
    // Dots and hyphens only inside a token; a leading sign only before a digit.
    const t = raw.replace(/[.\-+]+$/u, "").replace(/^[.\-+]+(?!\d)/u, "").replace(/^\.+/u, "");
    if (t) out.push(t);
  }
  return out;
}

/** The numbers of a statement, sorted, as one key ("-40,0.3,12"). */
export function numberKey(text: string): string {
  const s = text.normalize("NFKC").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  // A sign counts only at the start of a word ("-40°C"), not inside a code ("GW-10").
  return (s.match(/(?:(?<=^|[\s(])[-+±])?\d+(?:\.\d+)?/gu) ?? []).sort().join(",");
}

const negated = (tokens: string[]) => tokens.some((t) => NEGATIONS.has(t));

/** Shared words / all words (0 to 1) of two statements. */
export function tokenSetSimilarity(a: string, b: string): number {
  const A = new Set(factTokens(a));
  const B = new Set(factTokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Whether two statements may count as the same fact at all: same numbers, both or neither negated. */
export function comparable(a: string, b: string): boolean {
  return numberKey(a) === numberKey(b) && negated(factTokens(a)) === negated(factTokens(b));
}

/** The same words in any order (any source). */
export function sameWords(a: string, b: string): boolean {
  return comparable(a, b) && tokenSetSimilarity(a, b) === 1;
}

/** A near-duplicate (meant for two facts of the same source). */
export function nearDuplicate(a: string, b: string, threshold = NEAR_DUPLICATE_THRESHOLD): boolean {
  return comparable(a, b) && tokenSetSimilarity(a, b) >= threshold;
}

/** The order-free key of a statement's words: equal keys are `sameWords` (numbers and negation included). */
export function wordsKey(text: string): string {
  return [...new Set(factTokens(text))].sort().join(" ");
}

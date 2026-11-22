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

// ---------------------------------------------------------------------------
// Differs from an approved fact (the code's backstop to the model's known_fact_id)
// ---------------------------------------------------------------------------

/** Shared subject words / all subject words, from which two facts of one topic are about the same thing. */
export const CONFLICT_THRESHOLD = 0.7;

/** A number word ("24", "-40°c", "18%", "12-month"); a code like "gw-10" is not one. */
const isNumberToken = (t: string) => /^[-+±]?\d/u.test(t);

/** The words a statement is about: numbers and negation words left out. */
export function subjectTokens(text: string): Set<string> {
  return new Set(factTokens(text).filter((t) => !isNumberToken(t) && !NEGATIONS.has(t)));
}

/** Shared subject words / all subject words (0 to 1); 0 when either has fewer than two. */
export function subjectSimilarity(a: string, b: string): number {
  const A = subjectTokens(a);
  const B = subjectTokens(b);
  if (A.size < 2 || B.size < 2) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Where the first number of `text` that `other` does not have is (start and
 * end in `text`), for bolding it; null when there is none. Same number rules
 * as numberKey (thousands separators ignored, a sign only at a word's start).
 */
export function differingNumber(text: string, other: string): { start: number; end: number } | null {
  const theirs = new Set(numberKey(other).split(",").filter(Boolean));
  const re = /(?:(?<=^|[\s(])[-+±])?\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|(?:(?<=^|[\s(])[-+±])?\d+(?:\.\d+)?/gu;
  // Positions must be the shown text's: no bolding when normalising would move them.
  if (text.normalize("NFKC") !== text) return null;
  for (const m of text.matchAll(re)) {
    if (!theirs.has(m[0].replace(/,/g, ""))) return { start: m.index!, end: m.index! + m[0].length };
  }
  return null;
}

/**
 * Whether a new statement says something different from an approved one
 * about the same thing (callers also check the topic): nearly the same
 * subject words, and either both give numbers and the numbers differ
 * ("12-month" / "24-month"), or the numbers match and only one is negated
 * ("includes" / "does not include").
 */
export function differs(a: string, b: string, threshold = CONFLICT_THRESHOLD): boolean {
  const na = numberKey(a);
  const nb = numberKey(b);
  const numbersDiffer = na !== "" && nb !== "" && na !== nb;
  const negationDiffers = na === nb && negated(factTokens(a)) !== negated(factTokens(b));
  if (!numbersDiffer && !negationDiffers) return false;
  return subjectSimilarity(a, b) >= threshold;
}

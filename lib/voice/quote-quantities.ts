/**
 * The quote-quantities guard (every call since the owner decision of 26 Nov 2026: QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS
 * is on): a create_quote on a call runs only when every line's quantity is one the buyer gave. A GPT-Realtime 2.1 test
 * call (New, 23 Nov 2026) quoted 1 unit for 2 sites without ever asking how many units the buyer needed. Pure,
 * English and Hebrew (the number words lineSaysNumber knows).
 *
 * A line quantity is grounded when it is:
 * - a number the buyer said (digits or number words) in any buyer line of the conversation (this call's and the
 *   chat's), but not the buyer's number of SITES ("two sites", "שני סניפים", or a bare "two" answering "how many
 *   sites?"): a site count is a count of sites, never of the units on a line;
 * - the number of sites, only for an item the catalog itself ties to sites (siteTiedSkus: the "one per site" item of a
 *   `requires … perSite` fit rule, and an "Add automatically with" item added "× number of sites"); an item the
 *   catalog adds once per quote (auto_add "one") is grounded at 1. A catalog that ties no item to sites gives no data:
 *   there every item is taken as one per site (as before 26 Nov: "We have one location" grounds 1 of a generic
 *   per-location package);
 * - the product of a buyer number and a site count or another buyer number ("three in each" × 2 sites = 6), or the
 *   sum of two buyer numbers ("three upstairs and two downstairs" = 5): a site count is a factor of a product
 *   only, never a part of a sum, and no product has a factor of 1;
 * - a number the agent said aloud on this call that the buyer's next line clearly agreed to (clearYes).
 * Live finding fixed (26 Nov 2026): with 2 sites saved, GPT-Realtime mini quoted 2 × a per-unit item although the
 * buyer never gave a count of those units; the guard took the site count for it.
 * Never a dead-lock: after one refusal and at least one later buyer line, a quantity the agent said aloud since that
 * refusal is accepted too, even without an explicit yes.
 */
import type { FitRule } from "@/lib/catalog/fit";
import type { AutoAddRule } from "@/lib/pricing/auto-add";
import { clearYes } from "./form-agreement";

/**
 * The quote-quantities guard on BUYER calls. ON since the owner decision of 26 Nov 2026 (proven on test calls; the
 * site-count loophole fixed first).
 */
export const QUOTE_QUANTITY_GUARD_FOR_BUYER_CALLS: boolean = true;

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
/** A buyer line, with the agent line right before it when known (a bare "two" answering "How many sites?"). */
export type BuyerLine = string | { text: string; after?: string | null };

/**
 * The SKUs the catalog itself ties to the number of sites (its own data: no SKU is named here): the items of a fit rule
 * "X needs one of these per site" (`requires` with `perSite`: its `oneOf`) and an "Add automatically with" item added
 * "× number of sites" (`auto_add` qty "sites"). `once`: the "Add automatically with" items added once (qty "one").
 */
export function siteTiedSkus(rules: readonly (FitRule | AutoAddRule)[], autoAdd: readonly AutoAddRule[] = []): { perSite: Set<string>; once: Set<string> } {
  const perSite = new Set<string>();
  const once = new Set<string>();
  for (const r of [...rules, ...autoAdd]) {
    if (r.kind === "requires" && r.perSite) for (const s of r.oneOf) perSite.add(s);
    if (r.kind === "auto_add" && r.qty === "sites") perSite.add(r.sku);
    if (r.kind === "auto_add" && r.qty === "one") once.add(r.sku);
  }
  return { perSite, once };
}

// A site count as the buyer says it: a number, at most two more words, a word for a site ("two sites", "2 retail
// locations", "both of our stores", "שני סניפים", "בשני הסניפים"), or a Hebrew site word followed by one ("סניף אחד").
const EN_NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, both: 2, "a couple": 2,
};
const HE_NUMBER_WORDS: Record<string, number> = {
  שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלושה: 3, שלוש: 3, ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5, שישה: 6, שש: 6,
  שבעה: 7, שבע: 7, שמונה: 8, תשעה: 9, תשע: 9, עשרה: 10, עשר: 10,
};
const SITE_WORDS_EN = "sites?|locations?|branch(?:es)?|stores?|shops?|outlets?|venues?|premises|offices?|warehouses?|facilit(?:y|ies)|buildings?|propert(?:y|ies)|cafes?|hotels?|clinics?";
const SITE_WORDS_HE = "סניפים|סניף|אתרים|אתר|מיקומים|מיקום|מסעדות|מסעדה|חנויות|חנות|משרדים|משרד|מחסנים|מחסן";
const NUMBER_ALT = [...Object.keys(EN_NUMBER_WORDS).map((w) => w.replace(" ", "\\s+")), ...Object.keys(HE_NUMBER_WORDS), "\\d+"].join("|");
// Up to two English words between the number and the site word ("both of our sites", "2 retail locations"), never
// a preposition, an article or "and" ("three in the back" is no site count); in Hebrew none ("שלושה בכל סניף").
const FILLER = "(?:\\s+(?!(?:in|at|on|per|each|every|the|an?|for|by|with|across|inside|from|to|and|or)(?![A-Za-z]))[A-Za-z'-]+){0,2}";
const SITE_PHRASE = new RegExp(`(^|[^\\p{L}\\d])[בולשה]?(${NUMBER_ALT})${FILLER}\\s+ה?(?:${SITE_WORDS_EN}|${SITE_WORDS_HE})(?!\\p{L})`, "giu");
const SITE_ONE_HE = new RegExp(`(^|[^\\p{L}\\d])ה?(?:${SITE_WORDS_HE})\\s+(?:אחד|אחת)(?!\\p{L})`, "gu");
/** The agent asking for the number of sites ("How many locations do you have?", "כמה סניפים יש לכם?"). */
const ASKS_SITES = new RegExp(`(?:^|[^\\p{L}])how\\s+many\\s+(?:[\\p{L}'-]+\\s+)?(?:${SITE_WORDS_EN})(?!\\p{L})|כמה\\s+(?:${SITE_WORDS_HE})`, "iu");

const numberValue = (w: string): number | null => {
  const t = w.toLowerCase().replace(/\s+/g, " ");
  if (/^\d+$/.test(t)) return Number(t);
  return EN_NUMBER_WORDS[t] ?? HE_NUMBER_WORDS[t] ?? null;
};

/**
 * A buyer line split into what counts as quantities and the site counts it gave: its site phrases are cut out of the
 * text (their numbers go to `sites`); a line answering the agent's "how many sites?" with the saved count gives that
 * count to `sites`, and it is no quantity in that line (`notQty`).
 */
export function siteCountsOf(line: BuyerLine, savedSites: number | null): { text: string; sites: number[]; notQty: number | null } {
  const raw = typeof line === "string" ? line : line.text;
  const after = typeof line === "string" ? null : line.after ?? null;
  const sites: number[] = [];
  let text = raw.replace(SITE_PHRASE, (_m, pre: string, num: string) => {
    const v = numberValue(num);
    if (v !== null) sites.push(v);
    return `${pre} `;
  });
  text = text.replace(SITE_ONE_HE, (_m, pre: string) => {
    sites.push(1);
    return `${pre} `;
  });
  const answersSites = after !== null && savedSites !== null && ASKS_SITES.test(after) && lineSaysNumber(text, savedSites);
  if (answersSites) sites.push(savedSites);
  return { text, sites, notQty: answersSites ? savedSites : null };
}

/**
 * The first line of a create_quote whose quantity is not grounded, or null when every one is.
 * - `buyerLines`: every buyer line of the conversation (the chat's and this call's), each with the agent line before
 *   it when known;
 * - `callLines`: this call's lines in order (agent and buyer), for a number the agent proposed and the buyer agreed to;
 * - `sites`: the saved number of sites (deal state), when there is one;
 * - `perSiteSkus` / `onceSkus`: the items the catalog ties to sites / adds once (siteTiedSkus); none given or empty:
 *   the catalog has no site data, and every item counts as one per site;
 * - `refusedAt`: the length of `callLines` when this guard last refused on this call (null: never).
 * Lines with no positive whole quantity are left to the tool (it refuses them itself).
 */
export function ungroundedQuoteLine(o: {
  lines: readonly { sku: string; qty: number }[]; buyerLines: readonly BuyerLine[]; callLines: readonly QuantityLine[]; sites: number | null; refusedAt: number | null;
  perSiteSkus?: ReadonlySet<string>; onceSkus?: ReadonlySet<string>;
}): { sku: string; qty: number } | null {
  // Which items the number of sites may ground: the catalog's per-site items. A catalog that ties NO item to sites
  // gives no data either way: every item is then taken as one per site, as before 26 Nov (a generic "per location"
  // product, e.g. "We have one location" → 1 package).
  const perSite = (sku: string) => !o.perSiteSkus?.size || o.perSiteSkus.has(sku);
  // The buyer's lines as quantities (site counts cut out), and every site count: the buyer's and the saved one.
  const parsed = o.buyerLines.map((l) => siteCountsOf(l, o.sites));
  const siteCounts = new Set<number>([...(o.sites !== null ? [o.sites] : []), ...parsed.flatMap((p) => p.sites)]);
  const said = new Map<number, boolean>();
  const buyerSaid = (n: number) => {
    let v = said.get(n);
    if (v === undefined) {
      v = parsed.some((p) => p.notQty !== n && lineSaysNumber(p.text, n));
      said.set(n, v);
    }
    return v;
  };
  // A product of a buyer number and a site count or another buyer number (no factor of 1), or a sum of two buyer numbers.
  const combined = (q: number) => {
    if (q > MAX_COMBINED) return false;
    for (let a = 1; a < q; a++) {
      if (!buyerSaid(a)) continue;
      if (a > 1 && q % a === 0 && q / a > 1 && (buyerSaid(q / a) || siteCounts.has(q / a))) return true;
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
    // The catalog's own numbers: one per site for an item it ties to sites, one for an item it adds once.
    if (perSite(l.sku) && siteCounts.has(l.qty)) continue;
    if (o.onceSkus?.has(l.sku) && l.qty === 1) continue;
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

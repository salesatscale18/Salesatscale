/**
 * Reply figure check (offers plan §4, owner decisions of 23 Nov): pure code, no
 * model. Every money amount and percentage in a text-chat reply must come from
 * this turn's successful tool results, the buyer's own messages, or a quote the
 * app already showed in the chat. Bare integers (quantities, dates, times,
 * sites) and numbers written in words are not checked.
 *
 * - Money: a number next to a currency sign or word (either side), or a number
 *   with thousands separators or two decimals ("7,717.20"); "7.7k" counts and
 *   is approximate. Exact to the agora, or the figure rounded to whole units
 *   (₪7,717 for ₪7,717.20); with an approximation word, within max(1%, 1).
 * - Percent: "N%", "N percent", "N per cent", "N אחוז/אחוזים"; exact to 0.1.
 */

export type Figure = { raw: string; kind: "money" | "percent"; value: number; approx: boolean; index: number };

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const NUMBER_RE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?([kK])(?![a-zA-Z]))?/g;
const SIGN = /[₪$€£¥]/;
const WORD_AFTER = /^\s?(?:ils|nis|usd|eur|gbp|shekels?|dollars?|euros?|pounds?|ש["״׳']?ח|שקל(?:ים)?|דולר|יורו)(?![a-z])/i;
const WORD_BEFORE = /(?:ils|nis|usd|eur|gbp)\s?$/i;
const PERCENT_AFTER = /^\s?(?:%|percent\b|per cent\b|אחוז(?:ים)?)/i;
const APPROX_BEFORE = /(?:about|around|roughly|approximately|almost|just under|nearly|~|כ[-־]|בערך|בסביבות|קרוב ל)\s*[₪$€£¥]?\s*$/i;

/** The money amounts and percentages a text states, with where they are. */
export function extractFigures(textIn: string): Figure[] {
  const text = textIn.replace(URL_RE, (m) => " ".repeat(m.length));
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const intPart = m[1];
    const dec = m[2];
    const k = !!m[3];
    const value = Number(intPart.replace(/,/g, "") + (dec ? `.${dec}` : "")) * (k ? 1000 : 1);
    const after = text.slice(end, end + 12);
    const before = text.slice(Math.max(0, at - 24), at);
    const approxWord = APPROX_BEFORE.test(before);
    if (!k && PERCENT_AFTER.test(after)) { out.push({ raw: `${m[0]}%`.replace(/%%$/, "%"), kind: "percent", value, approx: approxWord, index: at }); continue; }
    const signNear = SIGN.test(text.slice(Math.max(0, at - 2), at)) || SIGN.test(after.slice(0, 2));
    const wordNear = WORD_AFTER.test(after) || WORD_BEFORE.test(before);
    const shaped = intPart.includes(",") || (dec?.length === 2);
    if (signNear || wordNear || shaped || k) {
      out.push({ raw: m[0].trim(), kind: "money", value, approx: approxWord || k, index: at });
    }
  }
  return out;
}

/** Every number a source states, in any form (lenient: an allowed figure may be written any way). */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.replace(URL_RE, " ").matchAll(NUMBER_RE)) {
    const v = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : "")) * (m[3] ? 1000 : 1);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export type AllowedFigures = number[];

/**
 * The figures a reply may state: every number in the given sources. Strings
 * are read for numbers; numbers are taken as they are and, under a key ending
 * in "minor" (minor units), also divided by 100.
 */
export function allowedFigures(sources: readonly unknown[]): AllowedFigures {
  const out: number[] = [];
  const walk = (v: unknown, key = "") => {
    if (typeof v === "string") out.push(...numbersIn(v));
    else if (typeof v === "number" && Number.isFinite(v)) { out.push(v); if (/minor$/i.test(key)) out.push(v / 100); }
    else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const s of sources) walk(s);
  return out;
}

function matches(f: Figure, allowed: AllowedFigures): boolean {
  if (f.kind === "percent") return allowed.some((a) => Math.abs(a - f.value) < 0.05);
  return allowed.some((a) => {
    if (Math.abs(a - f.value) < 0.005) return true;
    if (Number.isInteger(f.value) && (Math.round(a) === f.value || Math.trunc(a) === f.value)) return true;
    return f.approx && Math.abs(a - f.value) <= Math.max(0.01 * Math.abs(a), 1);
  });
}

/**
 * The figures of a reply no allowed source gives. `withheld`: money figures a
 * reply may not state even when a source gives them (a quote waiting for the
 * seller's approval: its pricing from check_fit, check_offer or create_quote).
 */
export function unverifiedFigures(reply: string, allowed: AllowedFigures, withheld: AllowedFigures = []): Figure[] {
  return extractFigures(reply).filter((f) => !matches(f, allowed) || (f.kind === "money" && withheld.length > 0 && matches({ ...f, approx: true }, withheld)));
}

/** The reply without the sentences that state any of these figures ("" when nothing is left). */
export function withoutSentences(reply: string, figures: readonly Figure[]): string {
  const sentences = reply.match(/[^.!?\n]+(?:[.!?]+(?=\s|$)|\n|$)|[.!?\n]+/g) ?? [reply];
  let pos = 0;
  const kept: string[] = [];
  for (const s of sentences) {
    const start = reply.indexOf(s, pos);
    const end = start + s.length;
    pos = end;
    if (!figures.some((f) => f.index >= start && f.index < end)) kept.push(s);
  }
  return kept.join("").replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim();
}

/** The regeneration note (needs the owner's approval of the wording). `held`: the quote waits for the seller's approval. */
export function figureNote(figures: readonly Figure[], opts: { held?: boolean } = {}): string {
  const list = [...new Set(figures.map((f) => f.raw))].join(", ");
  if (opts.held) {
    return `[Check from the system, not from the buyer] Your reply states ${list}, but the quote waits for the team's approval: no total or price for it may be given yet. Write the reply again without these amounts: say you have asked the team to approve it, and keep going. Do not mention this check.`;
  }
  return `[Check from the system, not from the buyer] Your reply states ${list}, which no tool returned in this turn. Write the reply again: state only amounts and percentages from this turn's tool results, the buyer's own numbers or the quotes already in the chat. If you need a figure, call the tool that gives it (check_fit, check_offer or create_quote) first. Do not mention this check.`;
}

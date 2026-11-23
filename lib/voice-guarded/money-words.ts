/**
 * Amounts and counts in words, for what a call says aloud ("Classic + guards", lib/voice-guarded). The server writes
 * every amount the agent is asked to say, so the model reads words instead of converting digits: on 23 Nov 2026 a
 * Current call said ₪106.20 as "one hundred and six shekels and forty agorot" (the cents of an earlier ₪212.40).
 * English (British "and": "one hundred and six") and Hebrew (grammatical gender: שקל masculine, אגורה feminine).
 * Pure.
 */

const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function enUnder100(n: number): string {
  if (n < 20) return EN_ONES[n];
  const t = EN_TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${EN_ONES[n % 10]}` : t;
}

function enUnder1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (!h) return enUnder100(r);
  return r ? `${EN_ONES[h]} hundred and ${enUnder100(r)}` : `${EN_ONES[h]} hundred`;
}

/** A whole number in English words: 5628 → "five thousand six hundred and twenty-eight". */
export function englishNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`englishNumber expects a whole number, got ${n}`);
  if (n === 0) return "zero";
  const groups: [number, string][] = [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of groups) {
    const g = Math.floor(rest / size);
    if (g) parts.push(`${englishNumber(g)} ${name}`);
    rest %= size;
  }
  // "one thousand and six": a last part under one hundred after a larger one takes "and".
  if (rest) parts.push(parts.length && rest < 100 ? `and ${enUnder100(rest)}` : enUnder1000(rest));
  return parts.join(" ");
}

export type HebrewGender = "m" | "f";

const HE_UNITS: Record<HebrewGender, string[]> = {
  m: ["", "אחד", "שניים", "שלושה", "ארבעה", "חמישה", "שישה", "שבעה", "שמונה", "תשעה"],
  f: ["", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע"],
};
const HE_TEN: Record<HebrewGender, string> = { m: "עשרה", f: "עשר" };
const HE_TEENS: Record<HebrewGender, string[]> = {
  m: ["", "אחד עשר", "שנים עשר", "שלושה עשר", "ארבעה עשר", "חמישה עשר", "שישה עשר", "שבעה עשר", "שמונה עשר", "תשעה עשר"],
  f: ["", "אחת עשרה", "שתים עשרה", "שלוש עשרה", "ארבע עשרה", "חמש עשרה", "שש עשרה", "שבע עשרה", "שמונה עשרה", "תשע עשרה"],
};
const HE_TENS = ["", "", "עשרים", "שלושים", "ארבעים", "חמישים", "שישים", "שבעים", "שמונים", "תשעים"];
/** "Three thousand" … "ten thousand": the construct form before אלפים. */
const HE_THOUSANDS = ["", "אלף", "אלפיים", "שלושת אלפים", "ארבעת אלפים", "חמשת אלפים", "ששת אלפים", "שבעת אלפים", "שמונת אלפים", "תשעת אלפים", "עשרת אלפים"];

/** The words of 1..999 as separate elements (hundreds, tens, units; a teen is one element). */
function heElements(n: number, g: HebrewGender): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 1) out.push("מאה");
  else if (h === 2) out.push("מאתיים");
  else if (h > 2) out.push(`${HE_UNITS.f[h]} מאות`);
  if (r === 10) out.push(HE_TEN[g]);
  else if (r > 10 && r < 20) out.push(HE_TEENS[g][r - 10]);
  else {
    if (r >= 20) out.push(HE_TENS[Math.floor(r / 10)]);
    if (r % 10) out.push(HE_UNITS[g][r % 10]);
  }
  return out;
}

/** Joins elements; "ו" (and) goes before the last one: "חמשת אלפים שש מאות עשרים ושמונה". */
const heJoin = (els: string[]) => (els.length > 1 ? [...els.slice(0, -1), `ו${els.at(-1)}`] : els).join(" ");

/**
 * A whole number in Hebrew words, for counting a noun of gender `g` (masculine: שקלים; feminine: אגורות, יחידות).
 * 106 (m) → "מאה ושישה"; 5628 (m) → "חמשת אלפים שש מאות עשרים ושמונה".
 */
export function hebrewNumber(n: number, g: HebrewGender = "m"): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`hebrewNumber expects a whole number, got ${n}`);
  if (n === 0) return "אפס";
  const els: string[] = [];
  const millions = Math.floor(n / 1e6);
  const thousands = Math.floor((n % 1e6) / 1e3);
  const rest = n % 1e3;
  if (millions === 1) els.push("מיליון");
  else if (millions === 2) els.push("שני מיליון");
  else if (millions) els.push(`${hebrewNumber(millions, "m")} מיליון`);
  if (thousands && thousands <= 10) els.push(HE_THOUSANDS[thousands]);
  else if (thousands) els.push(`${hebrewNumber(thousands, "m")} אלף`);
  if (rest) els.push(...heElements(rest, g));
  return heJoin(els);
}

/** A currency's unit names: major and minor, singular and plural, and (Hebrew) their gender. */
type Units = { one: string; many: string; g: HebrewGender };
const CURRENCY_WORDS: Record<string, { en: [Units, Units]; he: [Units, Units] }> = {
  ILS: { en: [{ one: "shekel", many: "shekels", g: "m" }, { one: "agora", many: "agorot", g: "f" }], he: [{ one: "שקל", many: "שקלים", g: "m" }, { one: "אגורה", many: "אגורות", g: "f" }] },
  USD: { en: [{ one: "dollar", many: "dollars", g: "m" }, { one: "cent", many: "cents", g: "m" }], he: [{ one: "דולר", many: "דולרים", g: "m" }, { one: "סנט", many: "סנטים", g: "m" }] },
  EUR: { en: [{ one: "euro", many: "euros", g: "m" }, { one: "cent", many: "cents", g: "m" }], he: [{ one: "יורו", many: "יורו", g: "m" }, { one: "סנט", many: "סנטים", g: "m" }] },
  GBP: { en: [{ one: "pound", many: "pounds", g: "m" }, { one: "penny", many: "pence", g: "m" }], he: [{ one: "לירה שטרלינג", many: "לירות שטרלינג", g: "f" }, { one: "פני", many: "פני", g: "m" }] },
};

export type WordsLanguage = "en" | "he";

/** "6 sensors" in words: English "six"; Hebrew with the noun ("שקל אחד", "שני שקלים", "שש אגורות"). */
function count(n: number, u: Units, lang: WordsLanguage): string {
  if (lang === "en") return `${englishNumber(n)} ${n === 1 ? u.one : u.many}`;
  if (n === 1) return `${u.one} ${HE_UNITS[u.g][1]}`;
  if (n === 2) return `${u.g === "m" ? "שני" : "שתי"} ${u.many}`;
  return `${hebrewNumber(n, u.g)} ${u.many}`;
}

/** Digits after the point for a currency (2 for ILS, 0 for JPY), as lib/domain/money.ts formatMoney uses. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * An amount in minor units, in words, in English or Hebrew: 10620 ILS → "one hundred and six shekels and twenty
 * agorot" / "מאה ושישה שקלים ועשרים אגורות". A round amount has no cents. A currency without names here is said
 * with its code and "cents" ("five hundred CHF and twenty cents").
 */
export function moneyWords(amountMinor: number, currency: string, lang: WordsLanguage): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error(`moneyWords expects whole minor units, got ${amountMinor}`);
  const digits = minorDigits(currency);
  const scale = 10 ** digits;
  const major = Math.floor(amountMinor / scale);
  const minor = amountMinor % scale;
  const names = CURRENCY_WORDS[currency.toUpperCase()]?.[lang]
    ?? (lang === "en"
      ? [{ one: currency, many: currency, g: "m" as const }, { one: "cent", many: "cents", g: "m" as const }]
      : [{ one: currency, many: currency, g: "m" as const }, { one: "סנט", many: "סנטים", g: "m" as const }]) as [Units, Units];
  const and = lang === "en" ? " and " : " ו";
  if (!minor) return count(major, names[0], lang);
  if (!major) return count(minor, names[1], lang);
  return `${count(major, names[0], lang)}${and}${count(minor, names[1], lang)}`;
}

/** A quantity of items in words: English "six"; Hebrew counts יחידות (feminine): "שש". */
export function quantityWords(n: number, lang: WordsLanguage): string {
  return lang === "en" ? englishNumber(n) : hebrewNumber(n, "f");
}

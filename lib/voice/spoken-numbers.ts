/**
 * The numbers a line says in words or with thousands separators (owner, 27 Nov 2026: the quote-quantities guard read
 * number words only up to ten, so "twelve units" or "two dozen" grounded nothing). Pure, English and Hebrew.
 * - English: 0-999,999 in words, compounds included ("twelve", "twenty-four", "twenty four", "a hundred and twenty",
 *   "three thousand two hundred"), "a dozen" = 12, "two dozen" = 24, "half a dozen" = 6, "a couple" = 2.
 * - Hebrew: 1-100 and beyond in both genders and common spellings (שתים עשרה, שנים עשר, עשרים וארבע, מאה ועשרים,
 *   שלוש מאות, אלף), a one-letter prefix allowed (וארבע, בשנים, לעשרים).
 * - Digits with thousands separators ("1,200" = 1200).
 * Each number is read whole: "twenty four" gives 24 (lib/voice/quote-quantities.ts keeps its older word list too, so
 * what it grounded before it still grounds).
 */

const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const EN_TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const HE_UNITS: Record<string, number> = {
  אחד: 1, אחת: 1, שניים: 2, שנים: 2, שתיים: 2, שתים: 2, שני: 2, שתי: 2, שלושה: 3, שלוש: 3, שלשה: 3, שלש: 3,
  ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5, חמשה: 5, שישה: 6, שש: 6, ששה: 6, שבעה: 7, שבע: 7, שמונה: 8, שמונת: 8,
  תשעה: 9, תשע: 9,
  // The construct forms ("שלושת אלפים", "ארבעת הסניפים").
  שלושת: 3, ארבעת: 4, חמשת: 5, ששת: 6, שבעת: 7, תשעת: 9,
};
const HE_TEN = new Set(["עשר", "עשרה"]);
const HE_TENS: Record<string, number> = {
  עשרים: 20, שלושים: 30, שלשים: 30, ארבעים: 40, חמישים: 50, שישים: 60, ששים: 60, שבעים: 70, שמונים: 80, תשעים: 90,
};
const HE_HUNDREDS: Record<string, number> = { מאה: 100, מאתיים: 200 };
const HE_THOUSANDS: Record<string, number> = { אלף: 1000, אלפיים: 2000 };
const HE_PREFIXES = "ובלשהמכ";

/** A Hebrew number word with an optional one-letter prefix: its kind and value; `and`: it started with ו. */
function heWord(token: string): { kind: "unit" | "ten" | "tens" | "hundred" | "hundreds" | "thousand" | "thousands"; value: number; and: boolean } | null {
  const plain = (w: string) => {
    if (w in HE_UNITS) return { kind: "unit" as const, value: HE_UNITS[w] };
    if (HE_TEN.has(w)) return { kind: "ten" as const, value: 10 };
    if (w in HE_TENS) return { kind: "tens" as const, value: HE_TENS[w] };
    if (w in HE_HUNDREDS) return { kind: "hundred" as const, value: HE_HUNDREDS[w] };
    if (w === "מאות") return { kind: "hundreds" as const, value: 100 };
    if (w in HE_THOUSANDS) return { kind: "thousand" as const, value: HE_THOUSANDS[w] };
    if (w === "אלפים") return { kind: "thousands" as const, value: 1000 };
    return null;
  };
  const whole = plain(token);
  if (whole) return { ...whole, and: false };
  if (token.length > 2 && HE_PREFIXES.includes(token[0])) {
    const rest = plain(token.slice(1));
    if (rest) return { ...rest, and: token[0] === "ו" };
  }
  return null;
}

/** Every number the line says in words (English, Hebrew) or with thousands separators. */
export function spokenNumbers(line: string): Set<number> {
  const out = new Set<number>();
  for (const m of line.matchAll(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])/g)) out.add(Number(m[0].replace(/,/g, "")));
  const tokens = line.toLowerCase().normalize("NFD").replace(/[̀-֑ͯ-ׇ]/g, "").split(/[^a-zא-ת]+/).filter(Boolean);

  // English.
  let total = 0;
  let group = 0;
  let active = false;
  let last: "unit" | "teen" | "ten" | "hundred" | "thousand" | "and" | null = null;
  const flush = () => {
    if (active) out.add(total + group);
    total = 0;
    group = 0;
    active = false;
    last = null;
  };
  const start = (v: number, kind: typeof last) => {
    flush();
    group = v;
    active = true;
    last = kind;
  };
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    const next = tokens[i + 1];
    const joins = active && (last === "hundred" || last === "thousand" || last === "and");
    if (w in EN_UNITS) {
      const v = EN_UNITS[w];
      if (active && last === "ten" && group % 10 === 0) { group += v; last = "unit"; } else if (joins) { group += v; last = "unit"; } else start(v, "unit");
    } else if (w in EN_TEENS) {
      if (joins) { group += EN_TEENS[w]; last = "teen"; } else start(EN_TEENS[w], "teen");
    } else if (w in EN_TENS) {
      if (joins) { group += EN_TENS[w]; last = "ten"; } else start(EN_TENS[w], "ten");
    } else if (w === "hundred" || w === "hundreds") {
      if (active && group > 0 && group < 10) { group *= 100; last = "hundred"; } else start(100, "hundred");
    } else if (w === "thousand" || w === "thousands") {
      if (active && total === 0 && group > 0) {
        total = group * 1000;
        group = 0;
      } else {
        flush();
        total = 1000;
        active = true;
      }
      last = "thousand";
    } else if (w === "dozen" || w === "dozens") {
      // "two dozen" is 24, not 2 and 24.
      const v = active ? (total + group) * 12 : 12;
      active = false;
      flush();
      out.add(v);
    } else if (w === "and" && active && (last === "hundred" || last === "thousand")) {
      last = "and";
    } else if ((w === "a" || w === "an") && (next === "hundred" || next === "thousand" || next === "dozen")) {
      start(1, "unit");
    } else if (w === "half" && next === "a" && tokens[i + 2] === "dozen") {
      flush();
      out.add(6);
      i += 2;
    } else if (w === "a" && next === "couple") {
      flush();
      out.add(2);
      i += 1;
    } else {
      flush();
    }
  }
  flush();

  // Hebrew.
  for (const w of tokens) {
    const h = heWord(w);
    if (!h) {
      flush();
      continue;
    }
    if (h.kind === "unit") {
      if (active && h.and) { group += h.value; last = "unit"; } else start(h.value, "unit");
    } else if (h.kind === "ten") {
      // "שתים עשרה", "חמישה עשר": a unit then עשר/עשרה is a teen.
      if (active && last === "unit" && group % 100 < 10 && !h.and) { group += 10; last = "teen"; } else if (active && h.and) { group += 10; last = "teen"; } else start(10, "teen");
    } else if (h.kind === "tens") {
      if (active && h.and) { group += h.value; last = "ten"; } else start(h.value, "ten");
    } else if (h.kind === "hundred") {
      if (active && h.and) { group += h.value; last = "hundred"; } else start(h.value, "hundred");
    } else if (h.kind === "hundreds") {
      // "שלוש מאות" = 300.
      if (active && last === "unit" && group < 10) { group *= 100; last = "hundred"; } else flush();
    } else if (h.kind === "thousand") {
      if (active && h.and) { group += h.value; last = "thousand"; } else start(h.value, "thousand");
    } else {
      // "שלושת אלפים" = 3000.
      if (active && group < 1000) { total = group * 1000; group = 0; last = "thousand"; } else flush();
    }
  }
  flush();
  return out;
}

const cache = new Map<string, Set<number>>();
/** spokenNumbers, remembered for the lines a guard reads again and again (bounded). */
export function spokenNumbersCached(line: string): Set<number> {
  let v = cache.get(line);
  if (!v) {
    if (cache.size >= 500) cache.clear();
    v = spokenNumbers(line);
    cache.set(line, v);
  }
  return v;
}

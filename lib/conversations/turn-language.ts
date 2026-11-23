/**
 * The language of a chat turn (owner rule, text chat): replies, fixed system
 * messages and cards follow the language of the buyer's LATEST message, not
 * the lead's stored language (which is only the conversation's starting value).
 *
 * Pure and cheap, by script and a few common words (the same idea as the voice
 * engine's spokenLanguageOf, lib/voice/engine.ts):
 * - Only words with letters count. Links, e-mail addresses, @handles, digits,
 *   emoji and punctuation are ignored.
 * - A message with fewer than three words ("ok", "תודה", a name, a number, an
 *   emoji, a link) is neutral: the previous turn's language stays.
 * - Words are grouped by script (Hebrew, Latin, other). Hebrew wins with more
 *   words than any other script (Latin words in Hebrew text are mostly brand and
 *   product names); any other script needs at least twice the words of every
 *   other one. So a Hebrew sentence with a Latin brand name is Hebrew, an English
 *   sentence with a Hebrew name is English, and a half-and-half message keeps the
 *   previous language. The winning script needs at least two words.
 * - Hebrew script → "he". Latin script → "en" only when it reads as English (more
 *   common English words than signs of another Latin-script language: its common
 *   words or accented letters); Spanish, French, German… keep the previous language.
 *   Any other script (Arabic, Cyrillic…) keeps the previous language.
 * - Only a language in `supported` is ever returned by detection (the lead's
 *   market's selling languages that the platform has texts for); anything else
 *   keeps the previous language.
 *
 * Voice reads its own spoken language (lib/voice); this helper is for typed text.
 */
import { LOCALES, type Locale } from "@/lib/i18n";

/** The languages a turn may switch to: the selling languages the platform has buyer texts for (all of them when none match). */
export function supportedTurnLanguages(sellingLanguages: readonly string[] | null | undefined): Locale[] {
  const hit = LOCALES.filter((l) => sellingLanguages?.includes(l));
  return hit.length ? hit : [...LOCALES];
}

const URLS = /\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+|@\w+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|co|il|app|dev|me|info|biz|shop|store)\b\S*/giu;
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const HEBREW = /[\u0590-\u05FF]/;
const LATIN = /^[\p{Script=Latin}\p{M}'’]+$/u;
/** Letters English text rarely has: a sign of another Latin-script language. */
const FOREIGN_LETTERS = /[àáâãäåæçèéêëìíîïñòóôõöøœùúûüýÿßğışăţș¿¡]/i;

/** Common English words (none of them a common Spanish, French, German, Portuguese or Italian word). */
const ENGLISH = new Set(`
i i'm im i'd i'll i've you you're your yours we we're our us they their them he she his her it it's its
the and or but if so than then that this these those there here what which who whom whose when where why how
is are were be been being does did done don't doesn't didn't have has had having would shall should
can can't cannot could may might must need needs want wants wanted like get got give send sent make made
to of at for from with without about into over under after before by up out off just only not
yes yeah yep nope hi hello hey thanks thank please sorry sure great good fine much many more most
any some all every each other another one two three four five six seven eight nine
price prices cost costs quote order buy pay paid delivery deliver ship shipping tomorrow today week month year
call my mine know think see look help ask let let's tell say said still already right now soon later
`.split(/\s+/).filter(Boolean));

/** Common words of other Latin-script languages (Spanish, French, German, Portuguese, Italian). */
const FOREIGN = new Set(`
el la los las del que y en un una por para con es está están quiero hola gracias cuánto cuanto precio mi tu su pero como cómo muy sí
también necesito puede usted buenos buenas días tengo hay qué cuál dónde favor
le les des est je vous nous pour avec bonjour merci oui très mais avez combien
und ich nicht ist der das sie wir bitte danke hallo ja nein ein eine haben möchte wie viel
olá obrigado obrigada você não com uma isso quero ciao grazie buongiorno sono vorrei quanto
`.split(/\s+/).filter(Boolean));

/** Fewer words than this is a neutral message: the previous language stays. */
const MIN_WORDS = 3;

type Script = "he" | "latin" | "other";

function scriptOf(word: string): Script {
  if (HEBREW.test(word)) return "he";
  return LATIN.test(word) ? "latin" : "other";
}

/** Whether Latin-script words read as English rather than another Latin-script language. */
function readsAsEnglish(words: string[]): boolean {
  let english = 0;
  let foreign = 0;
  for (const w of words) {
    const lower = w.toLowerCase().replace(/’/g, "'");
    if (ENGLISH.has(lower)) english++;
    if (FOREIGN.has(lower) || FOREIGN_LETTERS.test(lower)) foreign++;
  }
  return english > 0 && english > foreign;
}

/**
 * The language of this turn: the language of the buyer's latest message when it
 * clearly is one of `supported`, else `previous` (the conversation's language so far).
 */
export function turnLanguage(text: string, previous: string, supported: readonly string[]): string {
  const words = text.replace(URLS, " ").match(WORD) ?? [];
  if (words.length < MIN_WORDS) return previous;
  const by: Record<Script, string[]> = { he: [], latin: [], other: [] };
  for (const w of words) by[scriptOf(w)].push(w);
  const ranked = (Object.keys(by) as Script[]).sort((a, b) => by[b].length - by[a].length);
  const [top, second] = ranked;
  const lead = top === "he" ? by[top].length > by[second].length : by[top].length >= 2 * by[second].length;
  if (by[top].length < 2 || !lead) return previous;
  const detected = top === "he" ? "he" : top === "latin" && readsAsEnglish(by.latin) ? "en" : null;
  return detected && supported.includes(detected) ? detected : previous;
}

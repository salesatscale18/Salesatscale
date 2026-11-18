/**
 * Names in the buyer's language (P11 follow-up, decision 2). The agent's name
 * per language (`Playbook.agentNameLocal`), the seller's trade name per
 * language (`seller_accounts.trade_name_local`) and the grammatical gender the
 * agent uses for itself (`Playbook.agentGender`). C2 (18 Nov): the agent's
 * name resolves own version → automatic version (`Playbook.agentNameAuto`,
 * lib/agent/names-auto.ts) → name as typed; the trade name resolves own
 * version → as written. Reading never calls a model. Fixed Hebrew texts that speak about the
 * agent have a variant per gender: `<key>.female`, `<key>.male`; the plain key
 * is the neutral form.
 */
import type { Playbook } from "@/db/schema";
import { messages, t, type Locale, type MessageKey } from "@/lib/i18n";

export type AgentGender = "female" | "male" | "neutral";
export const AGENT_GENDERS: readonly AgentGender[] = ["female", "male", "neutral"];

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

/** The gender the agent uses for itself; anything else (missing, old playbooks) is neutral. */
export function agentGenderOf(p: Pick<Playbook, "agentGender"> | null | undefined): AgentGender {
  const g = p?.agentGender;
  return g === "female" || g === "male" ? g : "neutral";
}

// ---------------------------------------------------------------------------
// Scripts and languages (C2, 18 Nov)
// ---------------------------------------------------------------------------

export type NameScript = "hebrew" | "arabic" | "cyrillic" | "greek" | "latin";

const SCRIPT_LETTERS: Record<Exclude<NameScript, "latin">, RegExp> = {
  hebrew: /[֐-׿יִ-ﭏ]/u,
  arabic: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u,
  cyrillic: /[Ѐ-ӿ]/u,
  greek: /[Ͱ-Ͽ]/u,
};
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/u;
/** Languages written in a script other than Latin; every other language is Latin. */
const LANGUAGE_SCRIPT: Partial<Record<string, NameScript>> = {
  he: "hebrew", yi: "hebrew", ar: "arabic", fa: "arabic", ur: "arabic", ru: "cyrillic", uk: "cyrillic", bg: "cyrillic", el: "greek",
};
const RTL_SCRIPTS: ReadonlySet<NameScript> = new Set(["hebrew", "arabic"]);

/** The script a language is written in (Latin unless listed). */
export function languageScript(lang: string): NameScript {
  return LANGUAGE_SCRIPT[lang] ?? "latin";
}

/** The script a text is written in: the first non-Latin script with letters in it, else Latin. */
export function textScript(text: string): NameScript {
  for (const [script, re] of Object.entries(SCRIPT_LETTERS) as [NameScript, RegExp][]) if (re.test(text)) return script;
  return "latin";
}

/** The language a name was typed in, as far as letters tell: Hebrew letters → he, Arabic letters → ar, otherwise en. */
export function typedLanguage(name: string): "he" | "ar" | "en" {
  const s = textScript(name);
  return s === "hebrew" ? "he" : s === "arabic" ? "ar" : "en";
}

/**
 * Whether a name is written in this language's script: it has letters of
 * that script and none of another non-Latin one (a Latin-script language:
 * Latin letters and no other script's letters).
 */
export function writtenInScript(text: string, lang: string): boolean {
  const want = languageScript(lang);
  const others = (Object.keys(SCRIPT_LETTERS) as Exclude<NameScript, "latin">[]).filter((s) => s !== want);
  if (others.some((s) => SCRIPT_LETTERS[s].test(text))) return false;
  return want === "latin" ? LATIN_LETTER.test(text) : SCRIPT_LETTERS[want].test(text);
}

/** "Hebrew", "Arabic", … (English language names, for the editor). */
export function languageName(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/**
 * A name inside a line of another direction (a Latin name in a Hebrew or
 * Arabic line, or the other way round), wrapped in Unicode isolates (FSI …
 * PDI), the plain-text equivalent of <bdi>, so punctuation next to it keeps
 * its place. Names in the line's own direction are left as they are.
 */
export function isolateName(name: string, lang: string): string {
  if (!name) return name;
  const lineRtl = RTL_SCRIPTS.has(languageScript(lang));
  const nameRtl = RTL_SCRIPTS.has(textScript(name));
  return lineRtl === nameRtl ? name : `⁨${name}⁩`;
}

/**
 * The buyer languages names are shown for (Playbook › Agent, Company): the
 * union of the languages of the account's markets, or the account's languages
 * when it has no markets; without the language the name is typed in.
 */
export function nameLanguages(marketLanguages: readonly (readonly string[])[], accountLanguages: readonly string[], typed: string | null): string[] {
  const all = marketLanguages.some((l) => l.length) ? marketLanguages.flat() : accountLanguages;
  return [...new Set(all)].filter((l) => l !== typed);
}

// ---------------------------------------------------------------------------
// Names per language
// ---------------------------------------------------------------------------

/** The seller's name for buyers in this language: the seller's own version when set, else the trade name as written. Brands are never changed automatically. */
export function localTradeName(account: { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null }, lang: string): string {
  return clean(account.tradeNameLocal?.[lang]) || account.tradeName;
}

/**
 * The automatic version of the agent's name for this language, or null: the
 * stored transliteration when it was made from the current name, or the name
 * itself when the language uses the name's own script.
 */
export function autoAgentName(p: Pick<Playbook, "agentName" | "agentNameAuto"> | null | undefined, lang: string): string | null {
  const name = clean(p?.agentName);
  if (!name) return null;
  if (languageScript(lang) === textScript(name)) return name;
  const auto = p?.agentNameAuto;
  if (!auto || clean(auto.source) !== name) return null;
  const v = clean(auto.values?.[lang]);
  return v && writtenInScript(v, lang) ? v : null;
}

/**
 * The agent's name in this language (C2): the seller's own version, else the
 * automatic version, else the name as typed, else "<trade name> assistant".
 */
export function localAgentName(p: Pick<Playbook, "agentName" | "agentNameLocal" | "agentNameAuto"> | null | undefined, lang: string, tradeName: string): string {
  return clean(p?.agentNameLocal?.[lang]) || autoAgentName(p, lang) || clean(p?.agentName) || `${tradeName} assistant`;
}

/** One language row of "Names in other languages": the seller's own version ("" = none) and what buyers get without it. */
export type NameRow = {
  lang: string;
  label: string;
  own: string;
  /** What buyers see without an own version. */
  fallback: string;
  /** "automatic": a transliteration (or the same script); "as_written": the name as typed (a brand, or no automatic version could be made). */
  tag: "automatic" | "as_written";
};

/** The agent-name rows for these languages. */
export function agentNameRows(p: Pick<Playbook, "agentName" | "agentNameLocal" | "agentNameAuto">, languages: readonly string[]): NameRow[] {
  return languages.map((lang) => {
    const auto = autoAgentName(p, lang);
    return { lang, label: languageName(lang), own: clean(p.agentNameLocal?.[lang]), fallback: auto ?? clean(p.agentName), tag: auto ? "automatic" : "as_written" };
  });
}

/** The trade-name rows for these languages: without an own version, buyers see the trade name as written. */
export function tradeNameRows(account: { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null }, languages: readonly string[]): NameRow[] {
  return languages.map((lang) => ({ lang, label: languageName(lang), own: clean(account.tradeNameLocal?.[lang]), fallback: account.tradeName, tag: "as_written" }));
}

/** The local names a buyer in this language sees, with the agent's gender. */
export type BuyerNames = { agent: string; seller: string; gender: AgentGender; language: string };

export function buyerNames(
  p: Pick<Playbook, "agentName" | "agentNameLocal" | "agentNameAuto" | "agentGender"> | null | undefined,
  account: { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null },
  lang: string,
): BuyerNames {
  return { agent: localAgentName(p, lang, account.tradeName), seller: localTradeName(account, lang), gender: agentGenderOf(p), language: lang };
}

/** The key of a text about the agent in the agent's gender: `<key>.<gender>` when that variant exists, else the neutral key. */
export function genderedKey(key: MessageKey, gender: AgentGender): MessageKey {
  if (gender === "neutral") return key;
  const k = `${key}.${gender}`;
  return k in messages.en ? (k as MessageKey) : key;
}

/** t() for a text about the agent, in the agent's gender. */
export function tg(key: MessageKey, gender: AgentGender, vars?: Record<string, string | number>, lang: Locale = "en"): string {
  return t(genderedKey(key, gender), vars, lang);
}

const LANGUAGE_NAME: Record<string, string> = { en: "English", he: "Hebrew" };

/**
 * The per-turn names block (never in the stable prompt, so the cache holds):
 * the names to use in this conversation's language, and in a gendered
 * language, the grammatical gender the agent uses for itself.
 */
export function namesInstruction(n: BuyerNames): string {
  const lines = [`## Names in this conversation (${LANGUAGE_NAME[n.language] ?? n.language})`, `Your name: ${n.agent}. The seller's name: ${n.seller}. Use these when you name yourself or the seller.`];
  if (n.language === "he") {
    lines.push(n.gender === "female"
      ? "Speak of yourself in the feminine (for example \"אני בודקת\", \"העוזרת האוטומטית\")."
      : n.gender === "male"
        ? "Speak of yourself in the masculine (for example \"אני בודק\", \"העוזר האוטומטי\")."
        : "Avoid gendered forms for yourself where you can (for example \"אפשר לבדוק\" instead of \"אני בודק/ת\").");
  }
  return lines.join("\n");
}

/**
 * The fixed opening message (P11): a template, no model call.
 * "Hi {name}, this is {agent}, the automated assistant of {company}. You asked
 * about {interest}. {question}" in the lead's language.
 *
 * The seller's opener inputs (`Playbook.opener`): up to 6 topics, one the
 * default, and the opening question, each with an English and an optional
 * Hebrew version. A text is used only when it is written in the lead's
 * language (Hebrew letters for "he", none for "en"); a part with no version
 * in that language falls back to the general wording, so a message never
 * mixes languages. Older playbooks hold one text each (`leadsAskAbout`,
 * `openingQuestion`): read as the English default topic and question.
 */
import type { OpenerText, Playbook } from "@/db/schema";
import { t, type Locale } from "@/lib/i18n";

const HEBREW = /[֐-׿]/;

/** Whether a seller's text can be used in a message in this language. */
export function writtenIn(text: string, lang: Locale): boolean {
  return lang === "he" ? HEBREW.test(text) : !HEBREW.test(text);
}

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

/** Most topics a seller lists under "What leads usually ask about". */
export const MAX_OPENER_TOPICS = 6;

export type OpenerInputs = { topics: OpenerText[]; defaultTopic: number; question: OpenerText | null };

/**
 * The opener inputs in the current shape, from a playbook of either shape.
 * The new parts win; without them the older single texts are the English
 * default topic and question.
 */
export function readOpener(o: Playbook["opener"] | null | undefined): OpenerInputs {
  const text = (x: Partial<OpenerText> | undefined): OpenerText | null => {
    const en = clean(x?.en);
    const he = clean(x?.he);
    return en || he ? { en, ...(he ? { he } : {}) } : null;
  };
  // An older text written in Hebrew was only ever used for Hebrew leads: it is the Hebrew version.
  const legacy = (v: string | undefined): OpenerText | null => {
    const s = clean(v);
    return !s ? null : writtenIn(s, "he") ? { en: "", he: s } : { en: s };
  };
  const legacyTopic = legacy(o?.leadsAskAbout);
  const topics = o?.topics !== undefined
    ? o.topics.map(text).filter((x): x is OpenerText => !!x).slice(0, MAX_OPENER_TOPICS)
    : legacyTopic ? [legacyTopic] : [];
  const d = o?.defaultTopic ?? 0;
  const question = o?.question !== undefined ? text(o.question) : legacy(o?.openingQuestion);
  return { topics, defaultTopic: Number.isInteger(d) && d >= 0 && d < topics.length ? d : 0, question };
}

/** The version of a seller text for this language: its own version first, else any version written in it. */
export function textIn(x: OpenerText | null | undefined, lang: Locale): string {
  if (!x) return "";
  for (const v of [lang === "he" ? x.he : x.en, x.en, x.he]) {
    const s = clean(v);
    if (s && writtenIn(s, lang)) return s;
  }
  return "";
}

export type OpenerInput = {
  /** The lead's first name. */
  name: string;
  /** The agent's name, else the seller's trade name. */
  agent: string;
  company: string;
  language: Locale;
  opener?: Playbook["opener"];
  /** What this lead asked about, when the lead record carries it. Wins over the playbook's default topic. */
  leadInterest?: string | null;
};

/** The three sentences of the opener: the fixed intro, what the lead asked about, and the question. */
export function openerParts(o: OpenerInput): { intro: string; interest: string; question: string } {
  const lang = o.language;
  const inputs = readOpener(o.opener);
  const asked = clean(o.leadInterest);
  // A lead that picked one of the seller's topics gets that topic in its own language.
  const picked = asked ? inputs.topics.find((x) => [x.en, x.he].some((v) => !!v && v.toLowerCase() === asked.toLowerCase())) : undefined;
  const fromLead = picked ? textIn(picked, lang) : asked && writtenIn(asked, lang) ? asked : "";
  const interest = (fromLead || textIn(inputs.topics[inputs.defaultTopic], lang)).replace(/[.!?。]+$/u, "");
  return {
    intro: t("buyer.opener.intro", { name: o.name, agent: o.agent, company: o.company }, lang),
    interest: interest ? t("buyer.opener.asked_about", { interest }, lang) : t("buyer.opener.asked", undefined, lang),
    question: textIn(inputs.question, lang) || t("buyer.opener.question", undefined, lang),
  };
}

export function openerText(o: OpenerInput): string {
  const p = openerParts(o);
  return [p.intro, p.interest, p.question].join(" ");
}

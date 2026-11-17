/**
 * The fixed opening message (P11): a template, no model call.
 * "Hi {name}, this is {agent}, the automated assistant of {company}. You asked
 * about {interest}. {question}" in the lead's language.
 *
 * The seller's opener inputs (`Playbook.opener`) are one text each, written in
 * one language. An input is used only when it is written in the lead's
 * language (Hebrew letters for "he", none for "en"); otherwise that part falls
 * back to the general wording, so a message never mixes languages.
 */
import type { Playbook } from "@/db/schema";
import { t, type Locale } from "@/lib/i18n";

const HEBREW = /[֐-׿]/;

/** Whether a seller's text can be used in a message in this language. */
export function writtenIn(text: string, lang: Locale): boolean {
  return lang === "he" ? HEBREW.test(text) : !HEBREW.test(text);
}

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

export type OpenerInput = {
  /** The lead's first name. */
  name: string;
  /** The agent's name, else the seller's trade name. */
  agent: string;
  company: string;
  language: Locale;
  opener?: Playbook["opener"];
  /** What this lead asked about, when the lead record carries it. Wins over the playbook's general text. */
  leadInterest?: string | null;
};

export function openerText(o: OpenerInput): string {
  const lang = o.language;
  const usable = (v: string | null | undefined) => {
    const s = clean(v);
    return s && writtenIn(s, lang) ? s : "";
  };
  const interest = (usable(o.leadInterest) || usable(o.opener?.leadsAskAbout)).replace(/[.!?。]+$/u, "");
  const question = usable(o.opener?.openingQuestion);
  return [
    t("buyer.opener.intro", { name: o.name, agent: o.agent, company: o.company }, lang),
    interest ? t("buyer.opener.asked_about", { interest }, lang) : t("buyer.opener.asked", undefined, lang),
    question || t("buyer.opener.question", undefined, lang),
  ].join(" ");
}

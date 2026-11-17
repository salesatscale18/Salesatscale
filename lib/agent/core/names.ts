/**
 * Names in the buyer's language (P11 follow-up, decision 2). The agent's name
 * per language (`Playbook.agentNameLocal`), the seller's trade name per
 * language (`seller_accounts.trade_name_local`) and the grammatical gender the
 * agent uses for itself (`Playbook.agentGender`). A language with no local
 * name falls back to the English one. Fixed Hebrew texts that speak about the
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

/** The seller's name for buyers in this language: the local trade name when set, else the trade name. */
export function localTradeName(account: { tradeName: string; tradeNameLocal?: Partial<Record<string, string>> | null }, lang: string): string {
  return clean(account.tradeNameLocal?.[lang]) || account.tradeName;
}

/** The agent's name in this language: the local name when set, else the playbook name, else "<trade name> assistant". */
export function localAgentName(p: Pick<Playbook, "agentName" | "agentNameLocal"> | null | undefined, lang: string, tradeName: string): string {
  return clean(p?.agentNameLocal?.[lang]) || clean(p?.agentName) || `${tradeName} assistant`;
}

/** The local names a buyer in this language sees, with the agent's gender. */
export type BuyerNames = { agent: string; seller: string; gender: AgentGender; language: string };

export function buyerNames(
  p: Pick<Playbook, "agentName" | "agentNameLocal" | "agentGender"> | null | undefined,
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

/**
 * The realtime model's session instructions (live voice), built from the SAME
 * source as the chat prompt: the stable prompt and the per-turn context with
 * channel "voice" (lib/agent/core/voice.ts replaces the chat lines), computed
 * once when the call starts. The model does not need a refresh tool:
 * update_deal_state already returns the stage as it is now.
 *
 * The opener is the chat opener (lib/agent/core/opener.ts, the same text the
 * simulator sends), which already says the agent is an automated assistant;
 * in a call the agent speaks it first.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { messages, type AgentVersion, type Conversation, type DealState, type Lead, type SellerAccount } from "@/db/schema";
import { stableSystemPrompt, turnContext } from "@/lib/agent/prompt";
import { openerText } from "@/lib/agent/core/opener";
import { voiceStageText } from "@/lib/agent/core/voice";
import { buyerNames } from "@/lib/agent/core/names";
import { loadStageFacts } from "@/lib/agent/core/stage-facts";
import type { StageFacts } from "@/lib/agent/core/stage";
import type { ExampleCatalogItem } from "@/lib/agent/core/examples";
import type { PlainItem } from "@/lib/agent/prompt";
import { publishedCatalog } from "@/lib/catalog/service";
import { scheduledFollowUp } from "@/lib/follow-ups/schedule";
import { leadCallback } from "@/lib/callbacks/service";
import { teamQuestionsContext } from "@/lib/team-questions/service";
import { priceApprovalContext } from "@/lib/agent/price-approval";
import { formatBuyerLocal, localNowLine } from "@/lib/follow-ups/rules";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { maskCardNumbers } from "./safety";
import { isLocale } from "@/lib/i18n";
import { paceInstruction, resolveVoiceSettings } from "./settings";

/** Most earlier conversation lines given to the model (a recap, not the whole history). */
export const RECAP_LINES = 10;
/** A call that continues a chat (the buyer pressed "Talk to us"): more of the chat, so nothing is asked twice. */
export const CHAT_RECAP_LINES = 20;

export type TranscriptLine = { role: "buyer" | "agent" | "human"; text: string };

export type VoiceInstructionInput = {
  playbook: AgentVersion["playbook"];
  voiceSettings: AgentVersion["voiceSettings"];
  seller: { tradeName: string; currency: string; languages: string[] };
  catalog: (ExampleCatalogItem & PlainItem)[] | null;
  deal: Pick<DealState, "fields" | "objections" | "nextStep" | "summary"> | null;
  stage: StageFacts;
  /** Agent messages already in the conversation, before the opener. */
  agentMessages: number;
  names: ReturnType<typeof buyerNames>;
  opener: string;
  localNow: string | null;
  followUp: { dueLocal: string; topic: string | null } | null;
  /** The buyer's open call request (lib/callbacks), as turnContext shows it. Missing = none. */
  callback?: { timeLocal: string; confirmed: boolean } | null;
  /** "## Questions sent to the team" (lib/team-questions teamQuestionsContext): open questions and the team's answers. */
  teamQuestions?: string | null;
  /** "## Price approval" (lib/agent/price-approval.ts priceApprovalContext): the team's latest decline of a held price. */
  priceApproval?: string | null;
  /** The conversation so far (oldest first): earlier chat, or the call before a reconnect. */
  recap: TranscriptLine[];
  /** After a reconnect: the opener was already spoken. */
  resumed?: boolean;
  /**
   * The call continues a chat that already has agent messages (the buyer
   * switched from text to voice): no opener and no introduction; the agent
   * picks up from the chat in one short line (continuingInstruction).
   */
  continuing?: boolean;
  /** The conversation's language: the call starts in it (English when missing). */
  language?: string;
  /** Languages the buyer most likely speaks: the conversation's, the seller's selling languages and English. */
  expectedLanguages?: string[];
};

/** "Hebrew", "English", … (English names, for the instructions). */
export function languageNameEn(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The languages the buyer most likely speaks on a call: the conversation's first, then the selling languages, then English. */
export function expectedCallLanguages(conversationLanguage: string, sellingLanguages: readonly string[]): string[] {
  const base = (l: string) => l.trim().toLowerCase().split(/[-_]/)[0];
  return [...new Set([conversationLanguage, ...sellingLanguages, "en"].map(base).filter(Boolean))];
}

const ROLE: Record<TranscriptLine["role"], string> = { buyer: "Buyer", agent: "You", human: "A person from the team" };

/** The session instructions (pure). */
export function buildVoiceInstructions(i: VoiceInstructionInput): string {
  const settings = resolveVoiceSettings(i.voiceSettings);
  const language = i.language ?? "en";
  const expected = i.expectedLanguages ?? expectedCallLanguages(language, i.seller.languages);
  const stable = stableSystemPrompt(i.playbook, i.seller, i.catalog, { channel: "voice", fillers: settings.fillers });
  const fallback = continueFallback(language);
  // The opener counts as an agent turn: the stage moves on once the buyer answers it.
  // The whole per-turn context in call wording: turnContext converts the stage block, and the
  // "Open objection" block (which quotes a card's steps) goes through the same replacements here.
  const context = voiceStageText(turnContext(i.playbook, i.deal, {
    stage: i.stage, agentMessages: i.agentMessages + 1, opener: i.resumed || i.continuing ? null : i.opener, catalog: i.catalog, names: i.names,
    followUp: i.followUp, callback: i.callback ?? null, teamQuestions: i.teamQuestions ?? null, priceApproval: i.priceApproval ?? null, localNow: i.localNow, channel: "voice",
  }));
  const recap = i.recap.slice(-(i.continuing ? CHAT_RECAP_LINES : RECAP_LINES)).map((l) => `- ${ROLE[l.role]}: ${maskCardNumbers(l.text.replace(/\s+/g, " ").trim()).text.slice(0, 400)}`);
  const call = [
    "## This call",
    i.resumed
      ? "The call dropped for a moment and is connected again. Do not introduce yourself again and do not repeat the opening. Wait for the buyer, or carry on where you were."
      : i.continuing
        ? `The buyer switched this chat from text to voice: the same conversation goes on by voice, and what was said so far is listed here. You introduced yourself in the chat already. When the call connects, do not greet the buyer as if new, do not introduce yourself and do not say again that you are an automated assistant (say so only if the buyer asks). Open with one short line that picks up from where the chat stopped: if your own last chat message asked the buyer something they have not answered yet, ask it again briefly, in spoken form${i.opener && i.opener !== fallback ? ` (here: "${i.opener}")` : ""}; if the buyer wrote last, or nothing is open, ${fallback ? `say "${fallback}"` : `say briefly, in ${languageNameEn(language)}, that you are here and they can go ahead.`} Then listen. Never ask again for anything the buyer already answered in the chat.`
        : "When the call connects, say your opening line, then listen.",
    `Language: start in ${languageNameEn(language)} (if you cannot speak it, in English). The buyer most likely speaks ${expected.map(languageNameEn).join(" or ")}; if they speak or ask for another language, continue in that one.`,
    paceInstruction(settings.pace),
    i.deal?.summary ? `Summary so far: ${i.deal.summary}` : "",
    recap.length ? `Conversation so far (latest last):\n${recap.join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return `${stable}\n\n${context}\n${call}\nConversation language: ${language}.`;
}

/**
 * The instruction that makes the model speak the opener. `language`: the call's;
 * the opener is written in English or Hebrew, so in another language the model says it in that language.
 */
export function openerInstruction(opener: string, language = "en"): string {
  return isLocale(language)
    ? `The call has just connected. Say your opening line now, in your own voice: "${opener}"`
    : `The call has just connected. Say your opening line now, in your own voice and in ${languageNameEn(language)}: "${opener}"`;
}

/** The short line when a call continues a chat with nothing to pick up (the buyer only switched to voice). */
export const CONTINUE_FALLBACK = "I'm here, go ahead.";
/** The same line in Hebrew. */
export const CONTINUE_FALLBACK_HE = "אני כאן, אפשר להמשיך.";

/** The pick-up line in the call's language, or null for a language with no fixed line (the model is told what to say instead). */
export function continueFallback(language: string): string | null {
  const l = language.trim().toLowerCase().split(/[-_]/)[0];
  return l === "en" ? CONTINUE_FALLBACK : l === "he" ? CONTINUE_FALLBACK_HE : null;
}

/**
 * The spoken re-ask of the agent's own open question, when the agent wrote
 * last in the chat: its last question ("…? "), as "So, what made you get in
 * touch today?". Null when the message asks nothing.
 */
export function reAskLine(lastAgentMessage: string): string | null {
  const text = lastAgentMessage.replace(/\s+/g, " ").trim();
  const end = text.lastIndexOf("?");
  if (end < 0) return null;
  // The sentence the last "?" ends: from just after the previous sentence end (or a line start).
  const before = text.slice(0, end);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "), before.lastIndexOf(": ")) + 2;
  let q = text.slice(start >= 2 ? start : 0, end + 1).trim().replace(/^["'“‘(]+/, "");
  if (q.length < 3) return null;
  // A Hebrew question is re-asked in Hebrew; another script (Arabic, …) as it is, with no English "So,".
  if (/[\u0590-\u05FF]/.test(q)) return /^אז,?\s/.test(q) ? q : `אז, ${q}`;
  if (/[\u0600-\u08FF]/.test(q)) return q;
  if (/^so,?\s/i.test(q)) return q.charAt(0).toUpperCase() + q.slice(1);
  // Lower-case the first letter, except "I" and words in capitals (names stay as they are only when written in capitals).
  const first = q.split(/\s/)[0];
  if (!/^I(\b|')/.test(first) && !/^[A-Z]{2,}/.test(first)) q = q.charAt(0).toLowerCase() + q.slice(1);
  return `So, ${q}`;
}

/**
 * The instruction that starts a call continuing a chat: no greeting, no
 * introduction and no bot notice (the buyer only switched from text to voice).
 * `line`: the agent's open question re-asked briefly (reAskLine), or
 * CONTINUE_FALLBACK when the buyer spoke last or nothing is open.
 */
export function continuingInstruction(line: string | null = CONTINUE_FALLBACK, language = "en"): string {
  const start = "The call has just connected; the buyer switched the chat to voice. Do not greet them as if new, do not introduce yourself and do not say you are an automated assistant.";
  if (line === null) return `${start} The buyer spoke last or nothing is open, so say briefly, in ${languageNameEn(language)}, that you are here and they can go ahead.`;
  return line === CONTINUE_FALLBACK || line === CONTINUE_FALLBACK_HE
    ? `${start} The buyer spoke last or nothing is open, so say: "${line}"`
    : `${start} Your last chat message asked something still unanswered: ask it again briefly, in spoken form: "${line}"`;
}

export type VoiceCallContext = {
  instructions: string;
  opener: string;
  /** What the engine asks the model to say first (the opener, or a short pick-up line when the call continues a chat). */
  openerPrompt: string;
  /** The call's starting language, and the languages the buyer most likely speaks (a transcription hint where the model takes one). */
  language: string;
  expectedLanguages: string[];
  continuing: boolean;
};

/** Loads what the instructions need for this conversation and builds them. */
export async function loadVoiceInstructions(
  db: Db,
  a: { account: SellerAccount; version: AgentVersion; conv: Conversation; lead: Lead; deal: DealState | null; now: Date },
  opts: { recap?: TranscriptLine[]; resumed?: boolean } = {},
): Promise<VoiceCallContext> {
  const { account, version, conv, lead } = a;
  const [stage, catalog, followUp, contact, earlier, agentCount, callback, teamQuestions, priceApproval] = await Promise.all([
    loadStageFacts(db, account.id, lead.id),
    publishedCatalog(db, account.id).catch(() => null),
    scheduledFollowUp(db, account.id, lead.id),
    leadContactSettings(db, account, lead.marketId),
    db.select({ actor: messages.actor, body: messages.body }).from(messages)
      .where(and(eq(messages.accountId, account.id), eq(messages.conversationId, conv.id))).orderBy(desc(messages.createdAt)).limit(CHAT_RECAP_LINES),
    db.select({ id: messages.id }).from(messages).where(and(eq(messages.accountId, account.id), eq(messages.conversationId, conv.id), eq(messages.actor, "agent"))),
    // The open call request (requested or confirmed), as in a chat turn (lib/agent/turn.ts).
    leadCallback(db, account.id, lead.id, a.now),
    // Questions this conversation sent to the team, and the team's answers (as in a chat turn).
    teamQuestionsContext(db, account.id, lead.id, conv.id, a.now),
    // The team's latest decline of a special price (as in a chat turn).
    priceApprovalContext(db, account.id, lead.id),
  ]);
  // A call starts in the conversation's language (the opener is written in English or Hebrew; another language is spoken by the model).
  const language = conv.language || "en";
  const locale = isLocale(language) ? language : "en";
  const names = buyerNames(version.playbook, account, locale);
  const firstName = lead.fullName.trim().split(/\s+/)[0] || "there";
  // A chat that already has agent messages continues by voice: no opener, a short pick-up line.
  const continuing = !opts.resumed && agentCount.length > 0;
  // The pick-up line: the agent's own unanswered question re-asked, when the agent wrote last; else the fallback.
  const lastChat = earlier.find((m) => m.actor === "buyer" || m.actor === "agent" || m.actor === "human");
  const reAsk = continuing && lastChat?.actor === "agent" ? reAskLine(lastChat.body) : null;
  const fallback = continueFallback(language);
  const opener = continuing
    ? reAsk ?? fallback ?? ""
    : openerText({ name: firstName, agent: names.agent, company: names.seller, gender: names.gender, language: locale, opener: version.playbook.opener });
  const recap = opts.recap ?? earlier.reverse()
    .filter((m) => m.actor === "buyer" || m.actor === "agent" || m.actor === "human")
    .map((m) => ({ role: m.actor as TranscriptLine["role"], text: m.body }));
  const activeItems = catalog?.items.filter((x) => x.active) ?? null;
  const instructions = buildVoiceInstructions({
    playbook: version.playbook, voiceSettings: version.voiceSettings,
    seller: { tradeName: account.tradeName, currency: account.currency, languages: contact.languages },
    catalog: activeItems, deal: a.deal, stage, agentMessages: agentCount.length, names, opener,
    localNow: localNowLine(a.now, contact.timezone),
    // Times as the buyer should hear them ("Friday 20 November at 12:30"), as in a chat turn.
    followUp: followUp ? { dueLocal: formatBuyerLocal(followUp.dueAt, contact.timezone), topic: followUp.topic } : null,
    callback: callback ? { timeLocal: formatBuyerLocal(callback.at, callback.timezone), confirmed: callback.status === "confirmed" } : null,
    teamQuestions: teamQuestions || null,
    priceApproval: priceApproval || null,
    recap, resumed: opts.resumed, continuing,
    language, expectedLanguages: expectedCallLanguages(language, contact.languages),
  });
  return {
    instructions, opener, language, expectedLanguages: expectedCallLanguages(language, contact.languages),
    openerPrompt: continuing ? continuingInstruction(reAsk ?? fallback, language) : openerInstruction(opener, language), continuing,
  };
}

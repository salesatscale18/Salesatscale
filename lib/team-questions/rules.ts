/**
 * Park and continue (O4, objection handling part 4): a question the agent has
 * no approved answer for goes to the team without pausing the conversation
 * and without telling the buyer it was sent; the team's answer comes back into
 * that conversation. Pure: no database, no network.
 *
 * Stored as lead events, no table of its own:
 * - "team_question.asked" (the agent's ask_team): the question as the team
 *   reads it, the buyer's own words, must-have (true / false / null = not
 *   known yet) and the conversation. Asking the same question again in the
 *   same conversation updates it (the must-have flag, the buyer's words).
 * - "team_question.answered" (a person answers it in Knowledge): the answer,
 *   one event per conversation that asked it.
 * - "team_question.delivered" (the platform): how the answer reached the
 *   buyer: "in_chat" (the buyer wrote after it arrived, so the agent had it in
 *   its context), "sent" (a follow-up message to a quiet buyer) or "not_sent"
 *   (with the reason: the chat closed, a person holds it, the buyer opted out,
 *   the WhatsApp window closed, or it is too old).
 * A question is open (Needs you, Knowledge) while no approved fact answers it
 * (lib/agent/knowledge.ts: the fact's source is "Buyer question: <question>").
 */
import { normalizeQuestion } from "@/lib/agent/knowledge";
import { firstNameOf } from "@/lib/channels/rules";
import { isLocale, t, type Locale } from "@/lib/i18n";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const TEAM_QUESTION_EVENTS = {
  asked: "team_question.asked",
  answered: "team_question.answered",
  delivered: "team_question.delivered",
} as const;
export const TEAM_QUESTION_EVENT_TYPES: readonly string[] = Object.values(TEAM_QUESTION_EVENTS);

export const QUESTION_MAX = 300;
export const WORDS_MAX = 300;
export const ANSWER_MAX = 1000;

/**
 * "Gone quiet": no buyer message for this long. When the team's answer
 * arrives and the buyer has not written for QUIET_AFTER_MS (or goes quiet
 * afterwards without writing again), the app sends the answer as a follow-up
 * message, inside the lead's contact hours, once.
 */
export const QUIET_AFTER_MS = 4 * HOUR;
/** Answers older than this are not sent any more (the conversation has moved on). */
export const ANSWER_SEND_WITHIN_MS = 14 * DAY;
/** How far back Needs you, Knowledge and the agent's context look for questions. */
export const QUESTION_LOOKBACK_MS = 60 * DAY;

/** One line, trimmed, at most `max` characters. */
export const cleanLine = (raw: unknown, max: number): string =>
  (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "").slice(0, max);

/** must_have as stored: true, false, or null when the buyer has not said. */
export const mustHaveOf = (raw: unknown): boolean | null => (typeof raw === "boolean" ? raw : null);

/** One question one conversation asked, folded from its "asked" events (the latest call wins, earlier words kept when the later call has none). */
export type TeamAsk = {
  key: string;
  question: string;
  buyerWords: string;
  mustHave: boolean | null;
  leadId: string;
  conversationId: string;
  askedAt: Date;
  /** The first time it was asked in this conversation. */
  firstAskedAt: Date;
  /** Empty lookups (lookup_knowledge) the agent made in the same turn, normalized: the ask stands for them in Knowledge's list. */
  lookups: string[];
};

type EventLike = { type: string; leadId: string; createdAt: Date; data: Record<string, unknown> | null };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Asks per (conversation, question), oldest first, from "asked" events of any leads. */
export function foldAsks(events: readonly EventLike[]): TeamAsk[] {
  const sorted = [...events].filter((e) => e.type === TEAM_QUESTION_EVENTS.asked).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out = new Map<string, TeamAsk>();
  for (const e of sorted) {
    const d = e.data ?? {};
    const question = cleanLine(d.question, QUESTION_MAX);
    const key = normalizeQuestion(question);
    const conversationId = str(d.conversationId);
    if (!key || !conversationId) continue;
    const id = `${conversationId}|${key}`;
    const lookups = Array.isArray(d.lookups) ? d.lookups.filter((x): x is string => typeof x === "string") : [];
    const prev = out.get(id);
    const words = cleanLine(d.buyerWords, WORDS_MAX);
    out.set(id, {
      key, question, conversationId, leadId: e.leadId, askedAt: e.createdAt,
      buyerWords: words || prev?.buyerWords || "",
      mustHave: mustHaveOf(d.mustHave) ?? prev?.mustHave ?? null,
      firstAskedAt: prev?.firstAskedAt ?? e.createdAt,
      lookups: [...new Set([...(prev?.lookups ?? []), ...lookups])],
    });
  }
  return [...out.values()];
}

/** The team's answer for one conversation's question, with how it reached the buyer (null = not yet). */
export type TeamAnswer = {
  id: string;
  key: string;
  question: string;
  buyerWords: string;
  answer: string;
  leadId: string;
  conversationId: string;
  answeredAt: Date;
  delivery: "in_chat" | "sent" | "not_sent" | null;
};

/** Answers from "answered" and "delivered" events: one per (conversation, question), the latest answer wins. */
export function foldAnswers(events: readonly EventLike[]): TeamAnswer[] {
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const byId = new Map<string, TeamAnswer>();
  const latest = new Map<string, TeamAnswer>();
  for (const e of sorted) {
    const d = e.data ?? {};
    if (e.type === TEAM_QUESTION_EVENTS.answered) {
      const key = normalizeQuestion(str(d.question));
      const answerId = str(d.answerId);
      const conversationId = str(d.conversationId);
      if (!key || !answerId || !conversationId) continue;
      const a: TeamAnswer = {
        id: answerId, key, question: cleanLine(d.question, QUESTION_MAX), buyerWords: cleanLine(d.buyerWords, WORDS_MAX),
        answer: str(d.answer).trim().slice(0, ANSWER_MAX), leadId: e.leadId, conversationId, answeredAt: e.createdAt, delivery: null,
      };
      byId.set(answerId, a);
      latest.set(`${conversationId}|${key}`, a);
    } else if (e.type === TEAM_QUESTION_EVENTS.delivered) {
      const a = byId.get(str(d.answerId));
      const how = str(d.how);
      if (a && (how === "in_chat" || how === "sent" || how === "not_sent")) a.delivery = how;
    }
  }
  return [...latest.values()];
}

// ---------------------------------------------------------------------------
// What the platform does with one answer not yet delivered
// ---------------------------------------------------------------------------

export type AnswerFacts = {
  leadOptedOut: boolean;
  accountStatus: string;
  /** Only real WhatsApp chats need a live account; the simulator and the test lab work while setting up. */
  needsLiveAccount: boolean;
  conversationStatus: string;
  answeredAt: Date;
  /** The buyer's latest message in the conversation (null: none). */
  lastBuyerAt: Date | null;
  withinContactHours: boolean;
  now: Date;
};

export type AnswerDecision =
  | { action: "in_chat" }
  | { action: "not_sent"; reason: "opted_out" | "conversation_closed" | "taken_over" | "too_old" }
  | { action: "wait"; why: "buyer_active" | "account_paused" | "account_not_live" | "outside_hours" }
  | { action: "send" };

/**
 * First matching rule wins. The buyer wrote after the answer arrived: the
 * agent had it in its context for that reply ("in_chat"), nothing to send.
 * Otherwise the answer goes out as a message only once the buyer has gone
 * quiet (no buyer message for QUIET_AFTER_MS), inside contact hours.
 */
export function decideAnswer(f: AnswerFacts): AnswerDecision {
  if (f.leadOptedOut) return { action: "not_sent", reason: "opted_out" };
  if (f.conversationStatus === "closed") return { action: "not_sent", reason: "conversation_closed" };
  if (f.lastBuyerAt && f.lastBuyerAt.getTime() > f.answeredAt.getTime()) return { action: "in_chat" };
  // A person holds the chat: they have the answer in Knowledge and write themselves.
  if (f.conversationStatus === "human") return { action: "not_sent", reason: "taken_over" };
  if (f.now.getTime() - f.answeredAt.getTime() > ANSWER_SEND_WITHIN_MS) return { action: "not_sent", reason: "too_old" };
  if (f.accountStatus === "paused") return { action: "wait", why: "account_paused" };
  if (f.needsLiveAccount && f.accountStatus !== "live") return { action: "wait", why: "account_not_live" };
  if (f.lastBuyerAt && f.now.getTime() - f.lastBuyerAt.getTime() < QUIET_AFTER_MS) return { action: "wait", why: "buyer_active" };
  if (!f.withinContactHours) return { action: "wait", why: "outside_hours" };
  return { action: "send" };
}

/**
 * The follow-up message with the team's answer, in the conversation's
 * language: EN "Hi Rina, about your question "can it run on 220V": <answer>",
 * HE the same in Hebrew. The question is the buyer's own words where the agent
 * recorded them, else the question as the team read it.
 */
export function teamAnswerText(input: { language: string; leadName: string; buyerWords: string; question: string; answer: string }): string {
  const lang: Locale = isLocale(input.language) ? input.language : "en";
  const words = input.buyerWords || input.question;
  const name = firstNameOf(input.leadName);
  return t(name ? "buyer.app.team_answer" : "buyer.app.team_answer_plain", { name, question: words, answer: input.answer.trim() }, lang);
}

/** The per-turn line about one question: open (with must-have) or answered. Shown to the agent next to the open objection. */
export function teamQuestionLines(asks: readonly TeamAsk[], answers: readonly TeamAnswer[], answeredKeys: ReadonlySet<string>): string {
  const lines: string[] = [];
  const answered = new Map(answers.map((a) => [a.key, a]));
  for (const a of answers) {
    const sent = a.delivery === "sent" ? " (already sent to the buyer in a message: do not repeat it unless they ask)" : "";
    lines.push(`- Answer from the team to the buyer's question "${a.buyerWords || a.question}": ${a.answer}${sent}`);
  }
  for (const q of asks) {
    if (answered.has(q.key) || answeredKeys.has(q.key)) continue;
    const flag = q.mustHave === true ? "must-have" : q.mustHave === false ? "good to know" : "must-have or not: not known yet";
    lines.push(`- Sent to the team, no answer yet: "${q.buyerWords || q.question}" (${flag}).`);
  }
  if (!lines.length) return "";
  return `## Questions sent to the team\n${lines.join("\n")}\nUse an answer at a natural point, in your own words, once: when the buyer's question comes up, or before the close. Never say you were waiting for it. A must-have still open at the close: book a short call with the right person (request_callback), who arrives with the answer.`;
}

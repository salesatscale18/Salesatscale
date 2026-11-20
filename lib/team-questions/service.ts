/**
 * Park and continue (O4): the agent's ask_team tool, the reads for Needs you,
 * Knowledge's unanswered questions and the agent's per-turn context, and the
 * delivery of the team's answer into the conversation that asked. The
 * conversation never pauses. Every function is scoped by account, except
 * runTeamAnswers (the platform scheduler), whose reads and writes for each
 * answer are scoped by that answer's own account. Rules and the stored shape
 * (lead events): lib/team-questions/rules.ts.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, like, max } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, knowledgeFacts, leadEvents, leads, messages, sellerAccounts, toolCalls, type SellerAccount } from "@/db/schema";
import { answeredQuestionKey, normalizeQuestion, QUESTION_PREFIX } from "@/lib/agent/knowledge";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { conversationWindow, deliverText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import type { TwilioTransport } from "@/lib/channels/twilio";
import { isWebChat, SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import {
  ANSWER_MAX, ANSWER_SEND_WITHIN_MS, cleanLine, decideAnswer, foldAnswers, foldAsks, mustHaveOf, QUESTION_LOOKBACK_MS, QUESTION_MAX,
  TEAM_QUESTION_EVENTS, TEAM_QUESTION_EVENT_TYPES, teamAnswerText, teamQuestionLines, WORDS_MAX, type TeamAnswer, type TeamAsk,
} from "./rules";

// ---------------------------------------------------------------------------
// The agent's tool
// ---------------------------------------------------------------------------

export type AskTeamContext = { accountId: string; leadId: string; conversationId: string };
export type AskTeamInput = { question: unknown; buyer_words: unknown; must_have: unknown };
export type AskTeamResult =
  | { ok: true; sent: true; question: string; mustHave: boolean | null; again: boolean }
  /** An approved fact already answers this exact question: the agent gets it instead. */
  | { ok: true; sent: false; question: string; answer: string }
  | { ok: false; rule: string; extra: Record<string, unknown> };

/** Approved and other facts written to answer a buyer question, by the question's key (any status, as Knowledge's list counts them). */
async function answeredKeys(db: Db, accountId: string): Promise<Map<string, { statement: string; status: string }>> {
  const rows = await db.select({ s: knowledgeFacts.sourceLabel, statement: knowledgeFacts.statement, status: knowledgeFacts.status }).from(knowledgeFacts)
    .where(and(eq(knowledgeFacts.accountId, accountId), like(knowledgeFacts.sourceLabel, `${QUESTION_PREFIX}%`)));
  const out = new Map<string, { statement: string; status: string }>();
  for (const r of rows) {
    const k = answeredQuestionKey(r.s);
    if (k && (!out.has(k) || r.status === "approved")) out.set(k, { statement: r.statement, status: r.status });
  }
  return out;
}

/**
 * Sends a question to the team: a "team_question.asked" lead event with the
 * question, the buyer's words, must-have and the conversation. Nothing changes
 * in the conversation (it stays open with the agent) and nothing is sent to
 * the buyer. `lookups`: empty lookup_knowledge queries of the same turn,
 * which this question stands for in Knowledge's list.
 */
export async function askTeam(db: Db, ctx: AskTeamContext, input: AskTeamInput, opts: { lookups?: readonly string[]; now?: Date } = {}): Promise<AskTeamResult> {
  const now = opts.now ?? new Date();
  const question = cleanLine(input.question, QUESTION_MAX);
  const key = normalizeQuestion(question);
  if (!key) return { ok: false, rule: "No question", extra: { message: "Give the question as the team should read it, short." } };
  const [row] = await db.select({ id: conversations.id }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId), eq(leads.id, ctx.leadId), eq(leads.accountId, ctx.accountId)));
  if (!row) return { ok: false, rule: "Conversation not found", extra: {} };
  const known = (await answeredKeys(db, ctx.accountId)).get(key);
  if (known?.status === "approved") return { ok: true, sent: false, question, answer: known.statement };
  const mustHave = mustHaveOf(input.must_have);
  const before = (await conversationAsks(db, ctx.accountId, ctx.leadId, ctx.conversationId, now)).some((a) => a.key === key);
  await db.insert(leadEvents).values({
    id: randomUUID(), accountId: ctx.accountId, leadId: ctx.leadId, type: TEAM_QUESTION_EVENTS.asked, actor: "agent", createdAt: now,
    data: {
      question, buyerWords: cleanLine(input.buyer_words, WORDS_MAX), mustHave, conversationId: ctx.conversationId,
      lookups: [...new Set((opts.lookups ?? []).map(normalizeQuestion).filter(Boolean))],
    },
  });
  return { ok: true, sent: true, question, mustHave, again: before };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type EventRow = { type: string; leadId: string; createdAt: Date; data: Record<string, unknown> | null };
const eventCols = { type: leadEvents.type, leadId: leadEvents.leadId, createdAt: leadEvents.createdAt, data: leadEvents.data };

async function conversationAsks(db: Db, accountId: string, leadId: string, conversationId: string, now: Date): Promise<TeamAsk[]> {
  const rows = await db.select(eventCols).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), eq(leadEvents.type, TEAM_QUESTION_EVENTS.asked), gt(leadEvents.createdAt, new Date(now.getTime() - QUESTION_LOOKBACK_MS))));
  return foldAsks(rows).filter((a) => a.conversationId === conversationId);
}

/** An open question with its lead, for Needs you and Knowledge. */
export type OpenTeamQuestion = TeamAsk & { leadName: string; company: string | null; marketId: string | null; isTest: boolean; leadStatus: string };

/**
 * Questions sent to the team that no fact answers yet, newest first, one per
 * (conversation, question). `realOnly`: leave out test leads and closed
 * leads (Needs you); Knowledge shows test-lab questions too.
 */
export async function openTeamQuestions(db: Db, accountId: string, now: Date, opts: { realOnly?: boolean } = {}): Promise<OpenTeamQuestion[]> {
  const rows = await db.select({ ...eventCols, leadName: leads.fullName, company: leads.company, marketId: leads.marketId, isTest: leads.isTest, leadStatus: leads.status })
    .from(leadEvents)
    .innerJoin(leads, eq(leads.id, leadEvents.leadId))
    .where(and(
      eq(leadEvents.accountId, accountId), eq(leadEvents.type, TEAM_QUESTION_EVENTS.asked), gt(leadEvents.createdAt, new Date(now.getTime() - QUESTION_LOOKBACK_MS)),
      eq(leads.accountId, accountId),
      ...(opts.realOnly ? [eq(leads.isTest, false), inArray(leads.status, ["new", "waiting_for_reply", "agent_handling", "human_handling", "meeting_booked"])] : []),
    ))
    .orderBy(desc(leadEvents.createdAt))
    .limit(500);
  if (!rows.length) return [];
  const answered = await answeredKeys(db, accountId);
  const lead = new Map(rows.map((r) => [r.leadId, r]));
  return foldAsks(rows)
    .filter((a) => !answered.has(a.key))
    .map((a) => {
      const l = lead.get(a.leadId)!;
      return { ...a, leadName: l.leadName, company: l.company, marketId: l.marketId, isTest: l.isTest, leadStatus: l.leadStatus };
    })
    .sort((a, b) => b.askedAt.getTime() - a.askedAt.getTime());
}

/** What the agent's turn context shows about this conversation's questions (lib/agent/prompt.ts turnContext). */
export async function teamQuestionsContext(db: Db, accountId: string, leadId: string, conversationId: string, now = new Date()): Promise<string> {
  const rows = await db.select(eventCols).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...TEAM_QUESTION_EVENT_TYPES]), gt(leadEvents.createdAt, new Date(now.getTime() - QUESTION_LOOKBACK_MS))));
  if (!rows.length) return "";
  const asks = foldAsks(rows).filter((a) => a.conversationId === conversationId);
  const answers = foldAnswers(rows).filter((a) => a.conversationId === conversationId);
  if (!asks.length && !answers.length) return "";
  const answered = asks.length ? new Set((await answeredKeys(db, accountId)).keys()) : new Set<string>();
  return teamQuestionLines(asks, answers, answered);
}

// ---------------------------------------------------------------------------
// The team answers (Knowledge) and the answer reaches the conversation
// ---------------------------------------------------------------------------

/**
 * A person answered `question` in Knowledge: each conversation that asked it
 * (and has no answer yet for it) gets a "team_question.answered" event with
 * the answer. The agent sees it in its next turn; a quiet buyer gets it as a
 * message (deliverTeamAnswers, now and from the scheduler). Returns the new answers.
 */
export async function recordTeamAnswer(db: Db, accountId: string, a: { question: string; answer: string; factId: string; userId: string | null }, now = new Date()): Promise<TeamAnswer[]> {
  const key = normalizeQuestion(a.question);
  const answer = a.answer.trim().slice(0, ANSWER_MAX);
  if (!key || !answer) return [];
  const rows = await db.select(eventCols).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), inArray(leadEvents.type, [...TEAM_QUESTION_EVENT_TYPES]), gt(leadEvents.createdAt, new Date(now.getTime() - QUESTION_LOOKBACK_MS))));
  const asks = foldAsks(rows).filter((x) => x.key === key);
  if (!asks.length) return [];
  const done = new Set(foldAnswers(rows).filter((x) => x.key === key && x.answer === answer).map((x) => x.conversationId));
  const todo = asks.filter((x) => !done.has(x.conversationId));
  if (!todo.length) return [];
  await db.insert(leadEvents).values(todo.map((x) => ({
    id: randomUUID(), accountId, leadId: x.leadId, type: TEAM_QUESTION_EVENTS.answered, actor: "human", actorUserId: a.userId, createdAt: now,
    data: { answerId: randomUUID(), question: x.question, buyerWords: x.buyerWords, answer, factId: a.factId, conversationId: x.conversationId },
  })));
  const fresh = await db.select(eventCols).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), inArray(leadEvents.leadId, [...new Set(todo.map((x) => x.leadId))]), inArray(leadEvents.type, [...TEAM_QUESTION_EVENT_TYPES])));
  const ids = new Set(todo.map((x) => `${x.conversationId}|${key}`));
  return foldAnswers(fresh).filter((x) => ids.has(`${x.conversationId}|${x.key}`));
}

export type DeliverySummary = { checked: number; sent: number; inChat: number; notSent: number; waiting: number; skipped: number };

/**
 * The platform scheduler's part (app/api/cron/follow-ups, every 15 minutes):
 * every answer of the last ANSWER_SEND_WITHIN_MS not yet delivered, across
 * accounts, is checked with decideAnswer and, when the buyer has gone quiet,
 * sent once as a fixed app message (no model call).
 */
export async function runTeamAnswers(db: Db, transport: TwilioTransport | null, now = new Date()): Promise<DeliverySummary> {
  const rows = await db.select({ ...eventCols, accountId: leadEvents.accountId }).from(leadEvents)
    .where(and(inArray(leadEvents.type, [TEAM_QUESTION_EVENTS.answered, TEAM_QUESTION_EVENTS.delivered]), gt(leadEvents.createdAt, new Date(now.getTime() - ANSWER_SEND_WITHIN_MS - 86_400_000))))
    .limit(2000);
  const byAccount = new Map<string, EventRow[]>();
  for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
  const summary: DeliverySummary = { checked: 0, sent: 0, inChat: 0, notSent: 0, waiting: 0, skipped: 0 };
  for (const [accountId, events] of byAccount) {
    const pending = foldAnswers(events).filter((a) => a.delivery === null);
    if (pending.length) add(summary, await deliverTeamAnswers(db, accountId, pending, transport, now));
  }
  return summary;
}

function add(into: DeliverySummary, s: DeliverySummary) {
  for (const k of Object.keys(into) as (keyof DeliverySummary)[]) into[k] += s[k];
}

/** Checks and, where due, sends the given answers of one account (each at most once). */
export async function deliverTeamAnswers(db: Db, accountId: string, answers: readonly TeamAnswer[], transport: TwilioTransport | null, now = new Date()): Promise<DeliverySummary> {
  const summary: DeliverySummary = { checked: 0, sent: 0, inChat: 0, notSent: 0, waiting: 0, skipped: 0 };
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (!account) return summary;
  for (const a of answers) {
    summary.checked++;
    try {
      const r = await deliverOne(db, account, a, transport, now);
      summary[r]++;
    } catch (e) {
      // Never the answer or the buyer's data in the log: only that one failed.
      console.error("[team-questions] an answer failed", e instanceof Error ? e.name : "error");
      summary.skipped++;
    }
  }
  return summary;
}

async function delivered(db: Db, a: TeamAnswer, accountId: string, how: "in_chat" | "sent" | "not_sent", extra: Record<string, unknown> = {}) {
  await db.insert(leadEvents).values({
    id: randomUUID(), accountId, leadId: a.leadId, type: TEAM_QUESTION_EVENTS.delivered, actor: "system",
    data: { answerId: a.id, conversationId: a.conversationId, question: a.question, how, ...extra },
  });
}

async function deliverOne(db: Db, account: SellerAccount, a: TeamAnswer, transport: TwilioTransport | null, now: Date): Promise<"sent" | "inChat" | "notSent" | "waiting" | "skipped"> {
  const accountId = account.id;
  const [row] = await db.select({ lead: leads, conv: conversations }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.id, a.conversationId), eq(conversations.accountId, accountId), eq(leads.id, a.leadId), eq(leads.accountId, accountId)));
  if (!row) {
    await delivered(db, a, accountId, "not_sent", { reason: "conversation_closed" });
    return "notSent";
  }
  const { lead, conv } = row;
  const [last] = await db.select({ at: max(messages.createdAt) }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conv.id), eq(messages.actor, "buyer")));
  const decision = decideAnswer({
    leadOptedOut: lead.status === "opted_out",
    accountStatus: account.status,
    needsLiveAccount: conv.channel === "whatsapp" && !conv.isTest,
    conversationStatus: conv.status,
    answeredAt: a.answeredAt,
    lastBuyerAt: last?.at ?? null,
    now,
  });
  if (decision.action === "wait") return "waiting";
  if (decision.action === "in_chat") {
    await delivered(db, a, accountId, "in_chat");
    return "inChat";
  }
  if (decision.action === "not_sent") {
    await delivered(db, a, accountId, "not_sent", { reason: decision.reason });
    return "notSent";
  }
  // WhatsApp free text needs the 24-hour window (also simulated chats with "Simulate WhatsApp rules" on).
  const windowed = conv.channel === "whatsapp" || (conv.channel === SIMULATOR_CHANNEL && account.simulateWhatsappRules);
  if (windowed && !(await conversationWindow(db, accountId, conv.id, now)).open) {
    await delivered(db, a, accountId, "not_sent", { reason: "whatsapp_window_closed" });
    return "notSent";
  }
  const body = teamAnswerText({ language: conv.language, leadName: lead.fullName, buyerWords: a.buyerWords, question: a.question, answer: a.answer });
  // The answer's id is the message's: a second run inserts nothing and sends nothing.
  const messageId = a.id;
  const inserted = await db.insert(messages).values({ id: messageId, accountId, conversationId: conv.id, actor: "agent", body, language: conv.language, createdAt: now })
    .onConflictDoNothing().returning({ id: messages.id });
  if (!inserted.length) return "skipped";
  await atomic(db, (q) => [
    q.insert(toolCalls).values({
      accountId, conversationId: conv.id, messageId, sequence: 0, name: APP_MESSAGE_CALL, input: {},
      result: { message_id: messageId, kind: "team_answer", answer_id: a.id }, outcome: "ok", createdAt: now,
    }),
    q.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId: a.leadId, type: TEAM_QUESTION_EVENTS.delivered, actor: "agent", createdAt: now,
      data: { answerId: a.id, conversationId: conv.id, question: a.question, how: "sent", messageId },
    }),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId))),
    q.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, a.leadId), eq(leads.accountId, accountId))),
  ]);
  if (conv.channel === "whatsapp" || isWebChat(conv.channel)) {
    await deliverText(db, transport, { accountId, conversationId: conv.id, messageId, body }, { statusCallback: statusCallbackUrl(publicBaseUrl()), now });
  }
  return "sent";
}

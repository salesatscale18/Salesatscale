/**
 * The model's history of a chat turn (owner, 26 Nov: "the agent should have all the reply and
 * feedback/data/info stored as the main conv text"): every earlier message, and every tool call
 * the agent made on an earlier turn (chat or call) with its exact input and the result the model
 * got back, as tool_use / tool_result blocks in the order they were stored.
 *
 * Sources: the messages and their tool_calls rows (input, result, outcome, sequence). Not replayed:
 * - rows the app wrote, not the model: app messages (APP_MESSAGE_CALL), the reply figure check
 *   (reply_figures) and the hand-offs the turn makes itself (refusal, figures), which carry no `summary`;
 * - thinking blocks (never stored; they are bound to the tool list they were made with);
 * - the text the model wrote next to tool calls before its final reply, and which calls were made in one
 *   response (not stored): a message's calls are replayed as one or more rounds before its reply, and before
 *   the app messages (a quote card) that came just before that reply.
 * The tool_use ids are made from the stored row ids (stable across turns). The result is what the model
 * received: resultForModel(result), marked as an error when the tool failed, except that an earlier
 * update_deal_state result loses its `stage` block ("## Stage now", stale by now: the current step is in the
 * per-turn context). A call of a tool the
 * current tool list does not have (a voice-only tool, or one since removed) is shown as a system text
 * line in its place, never as a tool_use block. A message without stored calls stays a text line.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@/db/types";
import { messages, toolCalls, users, type Message, type User } from "@/db/schema";
import { APP_MESSAGE_CALL } from "./app-message";
import { resultForModel } from "./tools";

export type StoredCall = {
  id: string;
  messageId: string | null;
  sequence: number;
  name: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  outcome: "ok" | "refused" | "failed";
};

type Param = Anthropic.Beta.BetaMessageParam;
type UserBlock = Anthropic.Beta.BetaToolResultBlockParam | Anthropic.Beta.BetaTextBlockParam;

/** A row of a call the model made (not one the app or the turn's own guards wrote). */
export function modelCall(c: Pick<StoredCall, "name" | "input">): boolean {
  if (c.name === APP_MESSAGE_CALL || c.name === "reply_figures") return false;
  // The turn's own hand-offs (model refusal, unverified figures) are stored without the model's required `summary`.
  if (c.name === "hand_off_to_human" && !("summary" in (c.input ?? {}))) return false;
  return true;
}

/** The tool_use id of a stored call (allowed characters only). */
export const historyToolUseId = (rowId: string) => `toolu_h_${rowId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

/**
 * A stored call's result as the history replays it: the model's view of it (resultForModel), without the stale
 * stage block of an earlier update_deal_state (the current stage comes from the per-turn context).
 */
export function replayedResult(c: Pick<StoredCall, "name" | "result">): Record<string, unknown> {
  const r = resultForModel(c.result ?? {});
  if (c.name !== "update_deal_state" || !("stage" in r)) return r;
  const { stage: _stale, ...rest } = r;
  void _stale;
  return rest;
}

/** The content the history gives for a stored call's result. */
export const resultContent = (c: Pick<StoredCall, "name" | "result">) => JSON.stringify(replayedResult(c));

/** A call of a tool the request does not define, shown as text (the API is not sent a tool_use it cannot match). */
export function callAsText(c: StoredCall): string {
  return `[From the system, not from the buyer] An earlier tool call, shown as text because that tool is not available here: ${c.name} ${JSON.stringify(c.input ?? {})} -> ${c.outcome}: ${resultContent(c)}`;
}

/** The text line of a message, as the model has always read it. */
function textLine(m: Message, u: User | null): Param | null {
  // A line from a voice call (live voice) says so: the buyer said (or typed) it on the call, which may have ended since.
  if (m.actor === "buyer") return { role: "user", content: m.voiceSessionId ? `(On the voice call${m.typedInCall ? ", typed" : ""}) ${m.body}` : m.body };
  if (m.actor === "agent") return { role: "assistant", content: m.body };
  if (m.actor === "human") return { role: "assistant", content: `[${u?.firstName ?? "A person"} from the team]: ${m.body}` };
  return null;
}

/** A message's calls as rounds: assistant tool_use blocks, then the user's tool_result blocks (texts for unknown tools after them). */
function callRounds(calls: StoredCall[], tools: ReadonlySet<string>): Param[] {
  const out: Param[] = [];
  let uses: Anthropic.Beta.BetaToolUseBlockParam[] = [];
  let results: UserBlock[] = [];
  const flush = () => {
    if (uses.length) out.push({ role: "assistant", content: uses });
    if (results.length) out.push({ role: "user", content: results });
    uses = [];
    results = [];
  };
  for (const c of calls) {
    if (!tools.has(c.name)) {
      results.push({ type: "text", text: callAsText(c) });
      continue;
    }
    // tool_result blocks come first in a user message: a call after a text line starts a new round.
    if (results.some((b) => b.type === "text")) flush();
    const id = historyToolUseId(c.id);
    uses.push({ type: "tool_use", id, name: c.name, input: c.input ?? {} });
    results.push({ type: "tool_result", tool_use_id: id, content: resultContent(c), ...(c.outcome === "failed" ? { is_error: true } : {}) });
  }
  flush();
  return out;
}

/**
 * The history for a turn. `calls`: the stored calls of these messages (any order; sorted by sequence
 * here). Without calls (a call turn, or a conversation from before), every message is its text line.
 * `replayed`: the calls the history carries, in order (the figure check reads their results).
 */
export function buildHistory(
  recent: readonly { m: Message; u: User | null }[],
  calls: readonly StoredCall[],
  tools: ReadonlySet<string>,
): { history: Param[]; replayed: StoredCall[]; items: HistoryItem[] } {
  const byMessage = new Map<string, StoredCall[]>();
  for (const c of calls) {
    if (!c.messageId || !modelCall(c)) continue;
    const list = byMessage.get(c.messageId) ?? [];
    list.push(c);
    byMessage.set(c.messageId, list);
  }
  for (const list of byMessage.values()) list.sort((a, b) => a.sequence - b.sequence);

  // app: a message the app wrote (no agent version), not the agent's own reply.
  // items: the segment's messages and calls in the order they are replayed (the text rendering reads them).
  type Segment = { params: Param[]; calls: StoredCall[]; items: HistoryItem[]; buyer: boolean; reply: boolean; app: boolean };
  const segments: Segment[] = [];
  for (const { m, u } of recent) {
    const own = byMessage.get(m.id) ?? [];
    const line = textLine(m, u);
    if (m.actor === "agent" && own.length && m.body.trim()) {
      // The calls ran before the app messages their tools posted during the turn (a quote card): they go before them.
      let at = segments.length;
      while (at > 0 && segments[at - 1].app) at--;
      segments.splice(at, 0, { params: callRounds(own, tools), calls: own, items: own.map(callItem), buyer: false, reply: false, app: false });
      segments.push({ params: [line!], calls: [], items: [lineItem(line!)], buyer: false, reply: true, app: false });
    } else if (m.actor === "system" && own.length) {
      // A turn that failed after its tools ran: the calls happened, no reply was written.
      segments.push({ params: callRounds(own, tools), calls: own, items: own.map(callItem), buyer: false, reply: false, app: false });
    } else if (line) {
      segments.push({ params: [line], calls: [], items: [lineItem(line)], buyer: m.actor === "buyer", reply: m.actor !== "buyer", app: m.actor === "agent" && m.agentVersionId === null });
    }
  }
  // The history starts with the buyer (a fixed opener, or the cut-off start of a long thread, is dropped whole).
  const first = segments.findIndex((s) => s.buyer);
  const kept = first < 0 ? [] : segments.slice(first);
  // Calls of a failed turn with no reply after them would leave the history inside a tool round
  // (whose thinking block is not stored): they are left out.
  const lastReply = kept.map((s) => s.reply).lastIndexOf(true);
  const usable = kept.filter((s, i) => s.reply || s.buyer || i < lastReply);
  return { history: usable.flatMap((s) => s.params), replayed: usable.flatMap((s) => s.calls), items: usable.flatMap((s) => s.items) };
}

/** One entry of the history in replay order: a message's text line, or a call with its result. */
export type HistoryItem =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "call"; call: StoredCall };

const lineItem = (p: Param): HistoryItem => ({ kind: "message", role: p.role === "user" ? "user" : "assistant", text: typeof p.content === "string" ? p.content : "" });
const callItem = (c: StoredCall): HistoryItem => ({ kind: "call", call: c });

/** A call with its result as one text line (the text rendering of the history). */
export const callLine = (c: StoredCall) => `Tool call: ${c.name} ${JSON.stringify(c.input ?? {})} -> ${c.outcome}: ${resultContent(c)}`;

/**
 * The history as text (pure, for a voice call's start): the same entries in the same order and with the same
 * content as buildHistory replays them, one line each: "Buyer: ..." or "Agent: ..." for a message (its text line as
 * the model reads it: a team member's line keeps its "[Name from the team]:" label, a call line its "(On the voice
 * call)" mark), and "Tool call: <name> <input> -> <outcome>: <result>" for every call, whatever tools a request has.
 */
export function renderHistoryText(recent: readonly { m: Message; u: User | null }[], calls: readonly StoredCall[]): string {
  const all = new Set(calls.map((c) => c.name));
  return buildHistory(recent, calls, all).items
    .map((i) => (i.kind === "call" ? callLine(i.call) : `${i.role === "user" ? "Buyer" : "Agent"}: ${i.text}`))
    .join("\n");
}

/** How many of the latest messages a turn's history reads. */
export const HISTORY_MESSAGES = 40;

/**
 * The sources of a conversation's history (reads only): its latest messages (oldest first, with the user who wrote
 * each) and the stored calls of those messages, in order. Scoped by account. `withCalls: false` reads the messages only.
 */
export async function historySources(
  db: Db, accountId: string, conversationId: string, opts: { limit?: number; withCalls?: boolean } = {},
): Promise<{ recent: { m: Message; u: User | null }[]; calls: StoredCall[] }> {
  const recent = (await db.select({ m: messages, u: users }).from(messages).leftJoin(users, eq(users.id, messages.actorUserId))
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(desc(messages.createdAt)).limit(opts.limit ?? HISTORY_MESSAGES)).reverse();
  return { recent, calls: opts.withCalls === false ? [] : await storedCallsOf(db, accountId, conversationId, recent.map(({ m }) => m.id)) };
}

/** The stored calls of these messages of a conversation, in order (sequence, then time). Scoped by account. */
export async function storedCallsOf(db: Db, accountId: string, conversationId: string, messageIds: readonly string[]): Promise<StoredCall[]> {
  if (!messageIds.length) return [];
  return db.select({
    id: toolCalls.id, messageId: toolCalls.messageId, sequence: toolCalls.sequence, name: toolCalls.name,
    input: toolCalls.input, result: toolCalls.result, outcome: toolCalls.outcome,
  }).from(toolCalls).where(and(eq(toolCalls.accountId, accountId), eq(toolCalls.conversationId, conversationId), inArray(toolCalls.messageId, [...messageIds])))
    .orderBy(asc(toolCalls.sequence), asc(toolCalls.createdAt));
}

/**
 * Where the previous turn's history ended, in this turn's history (for its cache breakpoint): the latest buyer text
 * line that an agent message follows (the previous turn's history ended with that buyer message). Null when none.
 */
export function previousHistoryEndOf(history: readonly Param[]): number | null {
  let answered = false;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].role === "assistant") answered = true;
    else if (answered && typeof history[i].content === "string") return i;
  }
  return null;
}

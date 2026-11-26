/**
 * One agent turn (implementation plan P4.4): a buyer message in, an agent
 * reply out, with every tool call stored for the trace. Safety rules run in
 * code before the model sees anything.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, exists } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { agentVersions, conversations, leads, markets, messages, PLAY_KEYS, sellerAccounts, toolCalls, users, voiceSessions } from "@/db/schema";
import { optOutLead } from "@/lib/leads/service";
import { AiBudgetError, budgetGuarded } from "@/lib/ai/usage";
import { isRetryableModelError, withHistoryCacheBreakpoint, type Block, type LlmClient, type LlmRequest, type LlmResponse } from "./llm";
import { stableSystemPrompt, turnContext } from "./prompt";
import { CARD_REPLY, HANDOFF_REPLY, isOptOut, maskCardNumbers, OPT_OUT_REPLY } from "./safety";
import { readDealState } from "./service";
import { resultForModel, runTool, TOOL_DEFS, type ToolContext, type ToolResult, type TurnMemo } from "./tools";
import { allowedFigures, figureNote, unverifiedFigures, withoutSentences } from "./figure-check";
import { playFacts } from "./core/plays";
import { linksOnOwnLine } from "./links";
import { loadStageFacts } from "./core/stage-facts";
import { publishedCatalog } from "@/lib/catalog/service";
import { plainChatText } from "./core/plain-text";
import { buyerNames } from "./core/names";
import { scheduledFollowUp } from "@/lib/follow-ups/schedule";
import { leadCallback } from "@/lib/callbacks/service";
import { callUpcoming } from "@/lib/callbacks/rules";
import { leadCallForContext, teamCallLogLine } from "@/lib/team-calls/service";
import { teamQuestionsContext } from "@/lib/team-questions/service";
import { priceApprovalContext } from "./price-approval";
import { formatBuyerLocal, localNowLine } from "@/lib/follow-ups/rules";
import { marketContactSettings } from "@/lib/markets/settings";
import { supportedTurnLanguages, turnLanguage } from "@/lib/conversations/turn-language";
import { storedBuyerZone } from "@/lib/team-calls/zone";
import { textTurnBlocked } from "@/lib/voice/one-agent";
import { deriveStage, writtenByAgent } from "./core/stage";
import { BOOKKEEPING_TOOLS, bookkeepingNeedsRound, callContextLineOf, callReplyArgDescriptionOf, splitSpokenReply, toolDefsWithSpokenReply } from "./call-reply";

export const MAX_TOOL_ROUNDS = 8;
/** Wait before the one retry of a model call that failed after a tool round. */
export const MODEL_RETRY_DELAY_MS = 500;
const HISTORY = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TurnResult =
  | { status: "replied"; messageId: string; text: string; calls: number }
  // in_call: a call holds the conversation (lib/voice/one-agent.ts); this turn stored and sent nothing.
  | { status: "opted_out" | "human" | "closed" | "not_found" | "paused" | "in_call" }
  | { status: "error"; error: string };

const pick = (map: Record<string, string>, lang: string) => map[lang] ?? map.en;

/**
 * `buyerMessageStored`: a real channel (WhatsApp webhook) already stored the
 * buyer's message, card-masked and deduplicated, before this turn runs.
 * One agent at a time: while a call on the conversation is pending or live, no chat turn runs (in_call): the
 * model is not called, nothing is sent, and the buyer's text is not stored here (one already stored stays stored).
 * `trigger`: a short name for that log line ("test lab", "whatsapp", …).
 * `callSessionId`: the voice session of a call that runs this turn itself (the voice pipeline): that call does not
 * block it (every other pending or live call still does), and the messages this turn writes (the buyer's message
 * when stored here, the agent's reply) carry its id as `voiceSessionId`, so they group under the call. Only a
 * session of this conversation stamps (and only one can lift a block); without it, nothing changes.
 * A valid call turn also (lib/agent/call-reply.ts): a response with reply text and only bookkeeping tool calls
 * finishes the turn once the tools ran and their results add nothing the reply must reflect (one model round);
 * and `callContextLine`, the caller's own line for the model, is added to the per-turn context (one line,
 * trimmed, capped). With `callReplyArgDescription` (the caller's opt-in and wording), update_deal_state gets an
 * optional `spoken_reply` argument for the turn, and a response of update_deal_state calls only, with no text,
 * finishes the turn with that reply on the same guards. Without a valid call session all of this is off: a chat
 * turn is unchanged.
 */
export async function runBuyerTurn(
  db: Db, llm: LlmClient, args: { accountId: string; conversationId: string; text: string; buyerMessageStored?: boolean; trigger?: string; callSessionId?: string; callContextLine?: string; callReplyArgDescription?: string },
): Promise<TurnResult> {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, args.conversationId), eq(conversations.accountId, args.accountId)));
  if (!conv) return { status: "not_found" };
  if (await textTurnBlocked(db, args.accountId, conv.id, args.trigger ?? "chat turn", new Date(), { exceptSessionId: args.callSessionId })) return { status: "in_call" };
  // The call's own lines: stamped only with a session of this conversation (the id is a foreign key).
  const callStamp = args.callSessionId && UUID_RE.test(args.callSessionId)
    && (await db.select({ id: voiceSessions.id }).from(voiceSessions).where(and(
      eq(voiceSessions.id, args.callSessionId), eq(voiceSessions.accountId, args.accountId), eq(voiceSessions.conversationId, conv.id),
    ))).length > 0
    ? { voiceSessionId: args.callSessionId }
    : {};
  const callTurn = !!callStamp.voiceSessionId;
  // The caller's line for the model (the voice pipeline's own wording), on a valid call turn only.
  const callLine = callTurn ? callContextLineOf(args.callContextLine) : "";
  // The caller's description of update_deal_state's spoken_reply argument: the opt-in, on a valid call turn only.
  const spokenArgDescription = callTurn ? callReplyArgDescriptionOf(args.callReplyArgDescription) : "";
  const masked = maskCardNumbers(args.text.slice(0, 4000));

  // One round trip: lead, its market, version, account and deal state.
  const [[lead], [ofLead], [version], [account], deal] = await Promise.all([
    db.select().from(leads).where(and(eq(leads.id, conv.leadId), eq(leads.accountId, args.accountId))),
    // The lead's market (only one of the account's own), for its selling languages and clock.
    db.select({ market: markets }).from(markets).innerJoin(leads, eq(leads.marketId, markets.id))
      .where(and(eq(leads.id, conv.leadId), eq(markets.accountId, args.accountId))),
    db.select().from(agentVersions).where(and(eq(agentVersions.id, conv.agentVersionId), eq(agentVersions.accountId, args.accountId))),
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, args.accountId)),
    readDealState(db, args.accountId, conv.leadId),
  ]);
  if (!lead || !version || !account) return { status: "not_found" };
  // The lead's market: its own time zone and selling languages, else the account's.
  const contact = marketContactSettings(account, ofLead?.market ?? null);
  // The turn's language (owner rule): the language of the buyer's latest message, among the market's selling
  // languages; a short, neutral or mixed message keeps the conversation's language so far (lib/conversations/turn-language.ts).
  // Stored on the conversation, so every text the app writes later (follow-ups, cards, SMS, approvals) uses it too.
  // The lead's own language is only the conversation's starting value and is never changed here.
  const lang = turnLanguage(masked.text, conv.language, supportedTurnLanguages(contact.languages));
  await Promise.all([
    args.buyerMessageStored
      ? Promise.resolve()
      : db.insert(messages).values({ id: randomUUID(), accountId: args.accountId, conversationId: conv.id, actor: "buyer", body: masked.text, language: lang, ...callStamp }),
    lang === conv.language
      ? Promise.resolve()
      : db.update(conversations).set({ language: lang }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, args.accountId))),
  ]);

  const say = async (body: string) => {
    const [m] = await db.insert(messages).values({ accountId: args.accountId, conversationId: conv.id, actor: "agent", body, language: lang, agentVersionId: version.id, ...callStamp }).returning();
    return m;
  };

  if (lead.status === "opted_out") return { status: "opted_out" };
  if (conv.status === "closed") return { status: "closed" };
  // An opt-out is honoured even while the account is paused or a person handles the chat.
  if (isOptOut(masked.text)) {
    await optOutLead(db, { userId: null, actingAs: false }, args.accountId, lead.id);
    const m = await say(pick(OPT_OUT_REPLY, lang));
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, conv.id));
    return { status: "replied", messageId: m.id, text: m.body, calls: 0 };
  }
  if (conv.status === "human") return { status: "human" };
  // A paused account sends nothing automated: the message is stored, the model is not called.
  if (account.status === "paused") return { status: "paused" };
  if (masked.found) {
    const m = await say(pick(CARD_REPLY, lang));
    return { status: "replied", messageId: m.id, text: m.body, calls: 0 };
  }

  // History: text only. Deal state in the system prompt carries what was learned.
  // The stage facts (quote, order form, payment) and the published catalog are read alongside;
  // the catalog is shared with this turn's tools through the memo.
  const catalogRead = publishedCatalog(db, args.accountId);
  const [recentDesc, stageFacts, catalog, followUp, callback, loggedCall, teamQuestions, priceApproval, buyerZone] = await Promise.all([
    db.select({ m: messages, u: users }).from(messages).leftJoin(users, eq(users.id, messages.actorUserId))
      .where(eq(messages.conversationId, conv.id)).orderBy(desc(messages.createdAt)).limit(HISTORY),
    loadStageFacts(db, args.accountId, conv.leadId),
    catalogRead.catch(() => null),
    scheduledFollowUp(db, args.accountId, conv.leadId),
    // The buyer's open call request (O6): the agent keeps answering until the call.
    leadCallback(db, args.accountId, conv.leadId),
    // The team's log of its call with the buyer (lib/team-calls): the agent reads the note before it continues.
    leadCallForContext(db, args.accountId, conv.leadId),
    // Questions sent to the team and their answers (O4, lib/team-questions): the agent uses an answer at a natural point.
    teamQuestionsContext(db, args.accountId, conv.leadId, conv.id),
    // The team's decline of a special price (O1 part 5): the agent continues the price ladder from it.
    priceApprovalContext(db, args.accountId, conv.leadId),
    // The buyer's own zone as stored (RB4): the tools give the buyer times in it, so the context does too.
    storedBuyerZone(db, args.accountId, conv.leadId),
  ]);
  const recent = recentDesc.reverse();
  // For the stage: only what the agent wrote (the fixed opener too), not the app's messages (lib/agent/core/stage.ts).
  const agentMessages = recent.filter(({ m }) => writtenByAgent(m)).length;
  // Live voice: the buyer's last line was on a call that has ended (lib/voice/after-call.ts): answer it here, in writing.
  const lastSaid = [...recent].reverse().find(({ m }) => m.actor !== "system")?.m;
  const afterCall = lastSaid?.actor === "buyer" && lastSaid.voiceSessionId
    ? (await db.select({ status: voiceSessions.status }).from(voiceSessions).where(and(eq(voiceSessions.id, lastSaid.voiceSessionId), eq(voiceSessions.accountId, args.accountId))))[0]?.status === "ended"
    : false;
  // The model's history must start with the buyer, so a fixed opener (the conversation's first
  // message, sent as the agent) is dropped below: the per-turn context tells the agent what it said.
  const opener = recent.length < HISTORY && recent[0]?.m.actor === "agent" ? recent[0].m.body : null;
  const history: Anthropic.Beta.BetaMessageParam[] = [];
  for (const { m, u } of recent) {
    // A line from a voice call (live voice) says so: the buyer said (or typed) it on the call, which may have ended since.
    if (m.actor === "buyer") history.push({ role: "user", content: m.voiceSessionId ? `(On the voice call${m.typedInCall ? ", typed" : ""}) ${m.body}` : m.body });
    else if (m.actor === "agent") history.push({ role: "assistant", content: m.body });
    else if (m.actor === "human") history.push({ role: "assistant", content: `[${u?.firstName ?? "A person"} from the team]: ${m.body}` });
  }
  while (history.length && history[0].role !== "user") history.shift();

  // Both system blocks are fixed for the whole turn, so the prompt prefix stays
  // byte-stable across tool rounds. Deal-state changes made during the turn reach
  // the model through the update_deal_state tool result.
  // The examples in the stable prompt come from the published catalog: fixed until it is published again.
  const activeItems = catalog?.items.filter((i) => i.active) ?? null;
  const system: [string, string] = [
    stableSystemPrompt(version.playbook, { tradeName: account.tradeName, currency: account.currency, languages: contact.languages }, activeItems),
    `${turnContext(version.playbook, deal, {
      stage: stageFacts, agentMessages, opener, catalog: activeItems, names: buyerNames(version.playbook, account, lang),
      // Agreed follow-ups (lib/follow-ups): the scheduled one, and the clock the agent schedules with.
      // Times as the buyer should hear them ("Friday 20 November at 12:30", O7), in the buyer's stored zone
      // when known (as the tools give them), else the market's or the call's.
      followUp: followUp ? { dueLocal: formatBuyerLocal(followUp.dueAt, buyerZone ?? contact.timezone), topic: followUp.topic } : null,
      // A call still ahead (or an older request still waiting); once its slot has passed, the team's log says what happened.
      callback: callback && (callback.status === "requested" || callUpcoming(callback, new Date())) ? { timeLocal: formatBuyerLocal(callback.at, buyerZone ?? callback.timezone), confirmed: callback.status === "confirmed" } : null,
      teamCall: teamCallLogLine(loggedCall, (at) => formatBuyerLocal(at, buyerZone ?? contact.timezone)),
      teamQuestions,
      priceApproval,
      // The clock the agent reads local times by: the tools read them in the buyer's stored zone, else the market's.
      localNow: localNowLine(new Date(), buyerZone ?? contact.timezone),
    })}${afterCall ? "\nThe voice call has just ended, and the buyer's last line from it is unanswered. Answer it now, here in the chat, in writing, as a natural continuation: answer the question directly, without referring back to the call unless that is needed to make the answer clear. Do not mention a technical problem." : ""}\nReply language: ${lang} (the language of the buyer's latest message). Write your reply and any text you pass to tools in it.${callLine ? `\n${callLine}` : ""}`,
  ];
  const memo: TurnMemo = { account, catalog: catalogRead };
  const ctx = (callId: string): ToolContext => ({
    db, accountId: args.accountId, conversationId: conv.id, leadId: lead.id, playbook: version.playbook, currency: account.currency,
    callId, language: lang, memo, agentMessages,
  });
  const pending: { name: string; input: unknown; r: ToolResult }[] = [];
  const toolCallRows = (calls: typeof pending, messageId: string) => calls.map((p, i) => ({
    accountId: args.accountId, conversationId: conv.id, messageId, sequence: i + 1, name: p.name,
    input: (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>,
    result: p.r.result, outcome: p.r.outcome, rule: p.r.rule ?? null,
  }));
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: version.model };
  // Every model call checks the platform AI budget first (AI_PLATFORM_MONTHLY_BUDGET_USD; no check when unset).
  const model = budgetGuarded(db, llm);
  let text = "";
  let optedOut = false;
  // Reply figure check (owner, 23 Nov): one regeneration per turn; a second failure removes the sentences or hands off.
  let figuresRetried = false;
  // What a reply may state besides this turn's tool results: the buyer's own numbers and the quotes the app already showed.
  // Approved 25 Nov: also the seller's approved play facts the agent is given (facts lookup_knowledge returns this turn
  // are tool results, so they count already).
  const chatFigures = [
    ...recent.filter(({ m }) => m.actor === "buyer" || (m.actor === "agent" && m.agentVersionId === null)).map(({ m }) => m.body),
    ...PLAY_KEYS.flatMap((k) => playFacts(version.playbook.plays?.[k]).map((f) => f.text)),
  ];
  // The tools' strict mode of this turn's first call, sent again on every later round: the
  // model's thinking blocks are bound to the exact tool list they were made with.
  let strictTools: boolean | undefined;
  // The tool list, the same for every round of the turn: TOOL_DEFS, or on a call turn whose caller describes it,
  // TOOL_DEFS with update_deal_state's spoken_reply argument (lib/agent/call-reply.ts).
  const tools = spokenArgDescription ? toolDefsWithSpokenReply(TOOL_DEFS, spokenArgDescription) : TOOL_DEFS;
  // Call turns: the stage block the model last read (the per-turn context's, then each update_deal_state result's),
  // for the "reply with bookkeeping" check (lib/agent/call-reply.ts). Same inputs as turnContext's stage.
  let seenStage = callTurn
    ? deriveStage({ ...stageFacts, playbook: version.playbook, fields: deal?.fields ?? {}, objections: deal?.objections, agentMessages }).instruction
    : "";
  // A call after a tool round is retried once on an error that can pass on a retry: the tools
  // that already ran are not run again, and the buyer is not left with a tool's message and no reply.
  const callModel = async (req: LlmRequest, afterTools: boolean): Promise<LlmResponse> => {
    try {
      return await model.create(req);
    } catch (e) {
      if (!afterTools || e instanceof AiBudgetError || !isRetryableModelError(e)) throw e;
      console.warn("[agent] model call failed after a tool round; retrying once", e);
      await new Promise((r) => setTimeout(r, MODEL_RETRY_DELAY_MS));
      return model.create(req);
    }
  };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await callModel({
        model: version.model, effort: version.effort, system, tools, messages: withHistoryCacheBreakpoint(history),
        ...(strictTools === undefined ? {} : { strictTools }),
      }, round > 0);
      strictTools ??= res.strictTools;
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cacheReadTokens += res.usage.cacheReadTokens;
      usage.cacheWriteTokens += res.usage.cacheWriteTokens ?? 0;
      usage.model = res.model;

      if (res.stopReason === "refusal") {
        text = pick(HANDOFF_REPLY, lang);
        const r = await runTool("hand_off_to_human", { reason: "The model declined to continue", summary: "", suggested_reply: "" }, ctx("refusal"));
        pending.push({ name: "hand_off_to_human", input: { reason: "model refusal" }, r });
        break;
      }
      const uses = res.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use" && typeof (b as { id?: unknown }).id === "string");
      history.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      if (uses.length === 0 || round === MAX_TOOL_ROUNDS) {
        const draft = plainChatText(res.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n"));
        text = draft;
        // Call turns (a voice call's own session) are not checked: voice has no figure check in v1 (offers plan §4),
        // and a regeneration or a hand-off would hold up or end the spoken answer on a live call.
        if (optedOut || callTurn || round === MAX_TOOL_ROUNDS || !draft) break;
        const allowed = allowedFigures([...chatFigures, masked.text, ...pending.filter((p) => p.r.outcome === "ok").map((p) => p.r.result)]);
        // A quote waiting for the seller's approval (made this turn, or the lead's latest when no quote was made this turn):
        // the totals of this turn's pricing (check_fit, check_offer, create_quote) may not be stated.
        const quotesNow = pending.filter((p) => p.name === "create_quote" && p.r.outcome === "ok");
        const held = quotesNow.length ? quotesNow.at(-1)!.r.result.status === "awaiting_seller_approval" : stageFacts.quote === "awaiting_approval";
        const withheld = held
          ? allowedFigures(pending.filter((p) => p.r.outcome === "ok" && (p.name === "check_fit" || p.name === "check_offer" || p.name === "create_quote"))
            // A held create_quote's lines carry line prices (data for the agent), withheld like its totals.
            .map((p) => [p.r.result.totals, (p.r.result.offer as { totals?: unknown } | null | undefined)?.totals, p.r.result.now, p.name === "create_quote" && p.r.result.status === "awaiting_seller_approval" ? p.r.result.lines : null]))
          : [];
        const bad = unverifiedFigures(draft, allowed, withheld);
        if (!bad.length) break;
        const figures = [...new Set(bad.map((f) => f.raw))];
        if (!figuresRetried) {
          // First time: the model writes the reply again (same tools and strict mode, so the turn's rules hold).
          figuresRetried = true;
          pending.push({ name: "reply_figures", input: { figures }, r: { outcome: "refused", rule: "Figures not from a tool", result: { ok: false, refused: true, rule: "Figures not from a tool", figures, rewritten: true } } });
          history.push({ role: "user", content: figureNote(bad, { held }) });
          text = "";
          continue;
        }
        // Second time: the sentences with unverified figures go; with nothing left, a person takes over with the draft.
        const kept = withoutSentences(draft, bad);
        if (kept) {
          text = kept;
          pending.push({ name: "reply_figures", input: { figures }, r: { outcome: "failed", rule: "Figures not from a tool", result: { ok: false, rule: "Figures not from a tool", figures, removed: true } } });
        } else {
          const r = await runTool("hand_off_to_human", { reason: "Reply figures could not be verified", summary: "", suggested_reply: draft }, ctx("figures"));
          pending.push({ name: "hand_off_to_human", input: { reason: "Reply figures could not be verified", suggested_reply: draft }, r });
          pending.push({ name: "reply_figures", input: { figures }, r: { outcome: "failed", rule: "Figures not from a tool", result: { ok: false, rule: "Figures not from a tool", figures, handedOff: true } } });
          text = pick(HANDOFF_REPLY, lang);
        }
        break;
      }
      // Call turns: reply text written next to bookkeeping calls only may finish the turn after the tools run.
      const textNow = callTurn && uses.every((u) => BOOKKEEPING_TOOLS.has(u.name))
        ? plainChatText(res.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n"))
        : "";
      // Call turns: update_deal_state's spoken_reply is always taken off its input (the handler never sees it, the
      // stored call row has none). With the caller's opt-in, a response of update_deal_state calls only and no text
      // may finish the turn with it (the last non-empty one), on the same guards.
      const split = new Map(callTurn ? uses.filter((u) => u.name === "update_deal_state").map((u) => [u.id, splitSpokenReply(u.input)] as const) : []);
      const spokenNow = spokenArgDescription && !textNow.trim() && uses.every((u) => u.name === "update_deal_state")
        ? uses.map((u) => plainChatText(split.get(u.id)?.spoken ?? "")).filter((s) => s.trim())
        : [];
      if (spokenNow.length > 1) console.warn(`[agent] ${spokenNow.length} update_deal_state calls carry spoken_reply; the last one is the reply`);
      const replyNow = textNow.trim() ? textNow : spokenNow.at(-1) ?? "";
      let needsRound = !replyNow.trim();
      // Every result of this response is checked against the block the model read before writing it.
      const stageBefore = seenStage;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const input = split.get(u.id)?.input ?? u.input;
        let r: ToolResult;
        try {
          r = await runTool(u.name, input, ctx(u.id));
          if (u.name === "record_opt_out" && r.outcome === "ok") optedOut = true;
        } catch (e) {
          r = { outcome: "failed", result: { ok: false, error: "The tool failed. Tell the buyer you will check and get back to them." } };
          console.error(`[agent] tool ${u.name} failed`, e);
        }
        pending.push({ name: u.name, input, r });
        if (callTurn) {
          if (!needsRound && bookkeepingNeedsRound(u.name, r, stageBefore)) needsRound = true;
          if (u.name === "update_deal_state" && typeof r.result.stage === "string") seenStage = r.result.stage;
        }
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(resultForModel(r.result)), ...(r.outcome === "failed" ? { is_error: true } : {}) });
      }
      if (!needsRound) {
        text = replyNow;
        break;
      }
      history.push({ role: "user", content: results });
    }
  } catch (e) {
    if (e instanceof AiBudgetError) {
      // No model call was made: a person takes over and the buyer gets no automated reply.
      console.error("[agent] " + e.message);
      await runTool("hand_off_to_human", { reason: "The platform's monthly AI budget is used up", summary: "", suggested_reply: "" }, ctx("budget"));
      await db.insert(messages).values({ accountId: args.accountId, conversationId: conv.id, actor: "system", body: "The agent did not reply: the platform's monthly AI budget is used up. A person needs to reply.", language: "en" });
      return { status: "human" };
    }
    console.error("[agent] turn failed", e);
    // Usage of the rounds that did run is kept on the system message, so it still counts toward spend.
    const spent = usage.inputTokens || usage.outputTokens ? { usage } : {};
    // The tool calls that already ran are stored with the system message: the thread shows the steps, a quote
    // message a tool posted keeps its card, and approval finds the conversation (its create_quote call).
    // No model reply is made up, and nothing is run again: the buyer's next message starts a new turn.
    const systemId = randomUUID();
    await atomic(db, (q) => [
      q.insert(messages).values({ id: systemId, accountId: args.accountId, conversationId: conv.id, actor: "system", body: "The agent could not reply (model error). Try again.", language: "en", ...spent }),
      ...(pending.length ? [q.insert(toolCalls).values(toolCallRows(pending, systemId))] : []),
    ]);
    return { status: "error", error: e instanceof Error ? e.name : "error" };
  }

  // After an opt-out the buyer gets the fixed reply, whatever the model wrote.
  if (optedOut) text = pick(OPT_OUT_REPLY, lang);
  if (!text) text = pick(HANDOFF_REPLY, lang);
  // An order-form link the agent got this turn goes out on its own line (WhatsApp previews it), even if the model left it out.
  const formLinks = optedOut ? [] : pending
    .filter((p) => p.name === "send_order_form" && p.r.outcome === "ok" && typeof p.r.result.link === "string")
    .map((p) => p.r.result.link as string);
  if (formLinks.length) text = linksOnOwnLine(text, formLinks);
  const messageId = randomUUID();
  const now = new Date();
  await atomic(db, (q) => [
    q.insert(messages).values({
      id: messageId, accountId: args.accountId, conversationId: conv.id, actor: "agent", body: text, language: lang, agentVersionId: version.id, usage, ...callStamp,
    }),
    ...(pending.length ? [q.insert(toolCalls).values(toolCallRows(pending, messageId))] : []),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, args.accountId))),
    // A new lead becomes agent-handled, only while the conversation is still open (not handed off or closed this turn).
    q.update(leads).set({ status: "agent_handling", lastActivityAt: now }).where(and(
      eq(leads.id, lead.id), eq(leads.accountId, args.accountId), eq(leads.status, "new"),
      exists(q.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conv.id), eq(conversations.status, "open")))),
    )),
  ]);
  return { status: "replied", messageId, text, calls: pending.length };
}

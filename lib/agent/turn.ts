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
import { agentVersions, conversations, leads, messages, sellerAccounts, toolCalls, users } from "@/db/schema";
import { optOutLead } from "@/lib/leads/service";
import { AiBudgetError, budgetGuarded } from "@/lib/ai/usage";
import { withHistoryCacheBreakpoint, type Block, type LlmClient } from "./llm";
import { stableSystemPrompt, turnContext } from "./prompt";
import { CARD_REPLY, HANDOFF_REPLY, isOptOut, maskCardNumbers, OPT_OUT_REPLY } from "./safety";
import { readDealState } from "./service";
import { runTool, TOOL_DEFS, type ToolContext, type ToolResult, type TurnMemo } from "./tools";

export const MAX_TOOL_ROUNDS = 8;
const HISTORY = 40;

export type TurnResult =
  | { status: "replied"; messageId: string; text: string; calls: number }
  | { status: "opted_out" | "human" | "closed" | "not_found" | "paused" }
  | { status: "error"; error: string };

const pick = (map: Record<string, string>, lang: string) => map[lang] ?? map.en;

/**
 * `buyerMessageStored`: a real channel (WhatsApp webhook) already stored the
 * buyer's message, card-masked and deduplicated, before this turn runs.
 */
export async function runBuyerTurn(
  db: Db, llm: LlmClient, args: { accountId: string; conversationId: string; text: string; buyerMessageStored?: boolean },
): Promise<TurnResult> {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, args.conversationId), eq(conversations.accountId, args.accountId)));
  if (!conv) return { status: "not_found" };
  const lang = conv.language;
  const masked = maskCardNumbers(args.text.slice(0, 4000));

  // One round trip: lead, version, account and deal state are read while the buyer message is stored.
  const [[lead], [version], [account], deal] = await Promise.all([
    db.select().from(leads).where(and(eq(leads.id, conv.leadId), eq(leads.accountId, args.accountId))),
    db.select().from(agentVersions).where(and(eq(agentVersions.id, conv.agentVersionId), eq(agentVersions.accountId, args.accountId))),
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, args.accountId)),
    readDealState(db, args.accountId, conv.leadId),
    args.buyerMessageStored
      ? Promise.resolve()
      : db.insert(messages).values({ id: randomUUID(), accountId: args.accountId, conversationId: conv.id, actor: "buyer", body: masked.text, language: lang }),
  ]);
  if (!lead || !version || !account) return { status: "not_found" };

  const say = async (body: string) => {
    const [m] = await db.insert(messages).values({ accountId: args.accountId, conversationId: conv.id, actor: "agent", body, language: lang, agentVersionId: version.id }).returning();
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
  const recent = (
    await db.select({ m: messages, u: users }).from(messages).leftJoin(users, eq(users.id, messages.actorUserId))
      .where(eq(messages.conversationId, conv.id)).orderBy(desc(messages.createdAt)).limit(HISTORY)
  ).reverse();
  const history: Anthropic.Beta.BetaMessageParam[] = [];
  for (const { m, u } of recent) {
    if (m.actor === "buyer") history.push({ role: "user", content: m.body });
    else if (m.actor === "agent") history.push({ role: "assistant", content: m.body });
    else if (m.actor === "human") history.push({ role: "assistant", content: `[${u?.firstName ?? "A person"} from the team]: ${m.body}` });
  }
  while (history.length && history[0].role !== "user") history.shift();

  // Both system blocks are fixed for the whole turn, so the prompt prefix stays
  // byte-stable across tool rounds. Deal-state changes made during the turn reach
  // the model through the update_deal_state tool result.
  const system: [string, string] = [
    stableSystemPrompt(version.playbook, { tradeName: account.tradeName, currency: account.currency, languages: account.languages }),
    `${turnContext(version.playbook, deal)}\nConversation language: ${lang}.`,
  ];
  const memo: TurnMemo = { account };
  const ctx = (callId: string): ToolContext => ({
    db, accountId: args.accountId, conversationId: conv.id, leadId: lead.id, playbook: version.playbook, currency: account.currency,
    callId, language: lang, memo,
  });
  const pending: { name: string; input: unknown; r: ToolResult }[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: version.model };
  // Every model call checks the platform AI budget first (AI_PLATFORM_MONTHLY_BUDGET_USD; no check when unset).
  const model = budgetGuarded(db, llm);
  let text = "";
  let optedOut = false;

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await model.create({ model: version.model, effort: version.effort, system, tools: TOOL_DEFS, messages: withHistoryCacheBreakpoint(history) });
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
        text = res.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n").trim();
        break;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        let r: ToolResult;
        try {
          r = await runTool(u.name, u.input, ctx(u.id));
          if (u.name === "record_opt_out" && r.outcome === "ok") optedOut = true;
        } catch (e) {
          r = { outcome: "failed", result: { ok: false, error: "The tool failed. Tell the buyer you will check and get back to them." } };
          console.error(`[agent] tool ${u.name} failed`, e);
        }
        pending.push({ name: u.name, input: u.input, r });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r.result), ...(r.outcome === "failed" ? { is_error: true } : {}) });
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
    await db.insert(messages).values({ accountId: args.accountId, conversationId: conv.id, actor: "system", body: "The agent could not reply (model error). Try again.", language: "en", ...spent });
    return { status: "error", error: e instanceof Error ? e.name : "error" };
  }

  // After an opt-out the buyer gets the fixed reply, whatever the model wrote.
  if (optedOut) text = pick(OPT_OUT_REPLY, lang);
  if (!text) text = pick(HANDOFF_REPLY, lang);
  const messageId = randomUUID();
  const now = new Date();
  await atomic(db, (q) => [
    q.insert(messages).values({
      id: messageId, accountId: args.accountId, conversationId: conv.id, actor: "agent", body: text, language: lang, agentVersionId: version.id, usage,
    }),
    ...(pending.length
      ? [q.insert(toolCalls).values(pending.map((p, i) => ({
          accountId: args.accountId, conversationId: conv.id, messageId, sequence: i + 1, name: p.name,
          input: (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>,
          result: p.r.result, outcome: p.r.outcome, rule: p.r.rule ?? null,
        })))]
      : []),
    q.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, args.accountId))),
    // A new lead becomes agent-handled, only while the conversation is still open (not handed off or closed this turn).
    q.update(leads).set({ status: "agent_handling", lastActivityAt: now }).where(and(
      eq(leads.id, lead.id), eq(leads.accountId, args.accountId), eq(leads.status, "new"),
      exists(q.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conv.id), eq(conversations.status, "open")))),
    )),
  ]);
  return { status: "replied", messageId, text, calls: pending.length };
}

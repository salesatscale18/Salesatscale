/**
 * One agent turn (implementation plan P4.4): a buyer message in, an agent
 * reply out, with every tool call stored for the trace. Safety rules run in
 * code before the model sees anything.
 */
import { and, desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@/db/types";
import { agentVersions, conversations, leads, messages, sellerAccounts, toolCalls, users } from "@/db/schema";
import { optOutLead } from "@/lib/leads/service";
import type { Block, LlmClient } from "./llm";
import { stableSystemPrompt, turnContext } from "./prompt";
import { CARD_REPLY, HANDOFF_REPLY, isOptOut, maskCardNumbers, OPT_OUT_REPLY } from "./safety";
import { getDealState } from "./service";
import { runTool, TOOL_DEFS, type ToolResult } from "./tools";

export const MAX_TOOL_ROUNDS = 8;
const HISTORY = 40;

export type TurnResult =
  | { status: "replied"; messageId: string; text: string; calls: number }
  | { status: "opted_out" | "human" | "closed" | "not_found" }
  | { status: "error"; error: string };

const pick = (map: Record<string, string>, lang: string) => map[lang] ?? map.en;

export async function runBuyerTurn(db: Db, llm: LlmClient, args: { accountId: string; conversationId: string; text: string }): Promise<TurnResult> {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, args.conversationId), eq(conversations.accountId, args.accountId)));
  if (!conv) return { status: "not_found" };
  const [lead] = await db.select().from(leads).where(eq(leads.id, conv.leadId));
  const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, conv.agentVersionId));
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, args.accountId));
  const lang = conv.language;

  const masked = maskCardNumbers(args.text.slice(0, 4000));
  await db.insert(messages).values({ accountId: args.accountId, conversationId: conv.id, actor: "buyer", body: masked.text, language: lang });
  const say = async (body: string) => {
    const [m] = await db.insert(messages).values({ accountId: args.accountId, conversationId: conv.id, actor: "agent", body, language: lang, agentVersionId: version.id }).returning();
    return m;
  };

  if (lead.status === "opted_out") return { status: "opted_out" };
  if (conv.status === "closed") return { status: "closed" };
  if (isOptOut(masked.text)) {
    await optOutLead(db, { userId: null, actingAs: false }, args.accountId, lead.id);
    const m = await say(pick(OPT_OUT_REPLY, lang));
    await db.update(conversations).set({ status: "closed" }).where(eq(conversations.id, conv.id));
    return { status: "replied", messageId: m.id, text: m.body, calls: 0 };
  }
  if (conv.status === "human") return { status: "human" };
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

  const system: [string, string] = [
    stableSystemPrompt(version.playbook, { tradeName: account.tradeName, currency: account.currency, languages: account.languages }),
    "",
  ];
  const pending: { name: string; input: unknown; r: ToolResult }[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, model: version.model };
  let text = "";

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const deal = await getDealState(db, args.accountId, lead.id);
      system[1] = `${turnContext(version.playbook, deal)}\nConversation language: ${lang}.`;
      const res = await llm.create({ model: version.model, effort: version.effort, system, tools: TOOL_DEFS, messages: history });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cacheReadTokens += res.usage.cacheReadTokens;
      usage.model = res.model;

      if (res.stopReason === "refusal") {
        text = pick(HANDOFF_REPLY, lang);
        const r = await runTool("hand_off_to_human", { reason: "The model declined to continue", summary: "", suggested_reply: "" }, toolCtx(db, args.accountId, conv.id, lead.id, version.playbook, account.currency, "refusal"));
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
          r = await runTool(u.name, u.input, toolCtx(db, args.accountId, conv.id, lead.id, version.playbook, account.currency, u.id));
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
    console.error("[agent] turn failed", e);
    await db.insert(messages).values({ accountId: args.accountId, conversationId: conv.id, actor: "system", body: "The agent could not reply (model error). Try again.", language: "en" });
    return { status: "error", error: e instanceof Error ? e.name : "error" };
  }

  if (!text) text = pick(HANDOFF_REPLY, lang);
  const [m] = await db.insert(messages).values({
    accountId: args.accountId, conversationId: conv.id, actor: "agent", body: text, language: lang, agentVersionId: version.id, usage,
  }).returning();
  if (pending.length) {
    await db.insert(toolCalls).values(pending.map((p, i) => ({
      accountId: args.accountId, conversationId: conv.id, messageId: m.id, sequence: i + 1, name: p.name,
      input: (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>,
      result: p.r.result, outcome: p.r.outcome, rule: p.r.rule ?? null,
    })));
  }
  const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
  if (after.status === "open" && lead.status === "new") {
    await db.update(leads).set({ status: "agent_handling", lastActivityAt: new Date() }).where(eq(leads.id, lead.id));
  }
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conv.id));
  return { status: "replied", messageId: m.id, text, calls: pending.length };
}

function toolCtx(db: Db, accountId: string, conversationId: string, leadId: string, playbook: Parameters<typeof runTool>[2]["playbook"], currency: string, callId: string) {
  return { db, accountId, conversationId, leadId, playbook, currency, callId };
}


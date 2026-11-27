/**
 * The model behind the agent (decision D1), behind a small interface so tests
 * run a scripted fake and never call the API.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

export type ToolDef = Anthropic.Beta.BetaTool;

/** Content blocks the turn loop reads. Everything else is passed back unchanged. */
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string; [k: string]: unknown };

export type LlmRequest = {
  model: string;
  effort: string;
  /** [stable, per-turn]: the stable block is cached. */
  system: [string, string];
  tools: ToolDef[];
  messages: Anthropic.Beta.BetaMessageParam[];
  /**
   * The agent's turns (lib/agent/turn.ts): how many leading `messages` are the conversation's history (the earlier
   * messages and replayed tool calls, up to the buyer's latest message). When set, the per-turn block (system[1]) is
   * not sent as a system block: it goes, unchanged, as a text block right after the history (lib/agent/llm.ts
   * withTurnContext), so the history before it is read from cache on the next turn. Unset: two system blocks, as before.
   */
  historyLength?: number;
  /**
   * With `historyLength`: the index of the history message where the previous turn's history ended (its cache
   * breakpoint), so this turn reads it even when more than 20 blocks were added since. Optional.
   */
  previousHistoryEnd?: number;
  /** Max output tokens; default 16000 (the agent). Small jobs (automatic names) ask for less. */
  maxTokens?: number;
  /** Server-side refusal fallback; default on (the agent). Off for models that do not offer it (Haiku). */
  fallbacks?: boolean;
  /**
   * The tools' `strict` mode an earlier round of the same turn was sent with
   * (that round's `LlmResponse.strictTools`). Thinking blocks are bound to the
   * exact tool list they were made with, so every round of one turn must send
   * the same tools: false sends them without `strict` (never tries strict),
   * true sends them as given (never falls back). Unset on a turn's first call.
   */
  strictTools?: boolean;
};

export type LlmResponse = {
  /** Assistant content, to append to the conversation unchanged (thinking blocks included). */
  content: Block[];
  stopReason: string | null;
  model: string;
  /** `cacheWriteTokens`: 5-minute cache writes (the only TTL the agent uses). Optional for fakes. */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number };
  /** Whether the tools went out with their `strict` flags (true) or without (false): pass it to the turn's next round. Optional for fakes. */
  strictTools?: boolean;
};

export interface LlmClient {
  create(req: LlmRequest): Promise<LlmResponse>;
}

/** The API allows at most this many cache_control breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** Block types that may carry cache_control (thinking blocks may not). */
const CACHEABLE = new Set(["text", "tool_use", "tool_result", "image", "document"]);

/**
 * A copy of the history with one ephemeral cache breakpoint on its last
 * cacheable content block, so the next tool round reads the earlier history
 * from cache. Breakpoints on earlier blocks are removed (one moving breakpoint
 * for the history, plus the system one: well under MAX_CACHE_BREAKPOINTS).
 * A string-content last message becomes a text block array. Never mutates
 * its input.
 */
export function withHistoryCacheBreakpoint(history: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  type Loose = { type: string; text?: string; cache_control?: unknown; [k: string]: unknown };
  const strip = (b: Loose): Loose => {
    if (!b.cache_control) return b;
    const { cache_control: _drop, ...rest } = b;
    void _drop;
    return rest as Loose;
  };
  const out = history.map((m) =>
    Array.isArray(m.content) ? ({ ...m, content: (m.content as Loose[]).map(strip) } as Anthropic.Beta.BetaMessageParam) : { ...m },
  );
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role === "system") continue; // mid-conversation system messages are left as they are
    const blocks: Loose[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...((m.content ?? []) as Loose[])];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (!CACHEABLE.has(b.type)) continue;
      if (b.type === "text" && !b.text) continue; // empty text blocks cannot be cached
      blocks[j] = { ...b, cache_control: { type: "ephemeral" } };
      out[i] = { ...m, content: blocks } as Anthropic.Beta.BetaMessageParam;
      return out;
    }
  }
  return out;
}

type LooseBlock = { type: string; text?: string; cache_control?: unknown; [k: string]: unknown };
const blocksOf = (m: Anthropic.Beta.BetaMessageParam): LooseBlock[] =>
  typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...((m.content ?? []) as LooseBlock[])];

/** A copy of message `i` with a cache breakpoint on its last cacheable block before `before` (all blocks when unset). */
function markMessage(out: Anthropic.Beta.BetaMessageParam[], i: number, before?: number): void {
  const m = out[i];
  if (!m) return;
  const blocks = blocksOf(m);
  for (let j = Math.min(before ?? blocks.length, blocks.length) - 1; j >= 0; j--) {
    const b = blocks[j];
    if (!CACHEABLE.has(b.type) || (b.type === "text" && !b.text)) continue;
    if (b.cache_control) return;
    blocks[j] = { ...b, cache_control: { type: "ephemeral" } };
    out[i] = { ...m, content: blocks } as Anthropic.Beta.BetaMessageParam;
    return;
  }
}

/**
 * The messages of an agent turn with the per-turn context right after the history (pure, never mutates its input),
 * and the cache breakpoints (with the system one, at most MAX_CACHE_BREAKPOINTS):
 * - the moving one on the last block of the request (round 1: the per-turn context; later rounds: the last tool
 *   result), so the turn's next round reads everything before it;
 * - one on the last history block before the per-turn context (the buyer's latest message): the next turn's history
 *   starts with these same blocks, so it reads them from cache;
 * - one where the previous turn's history ended (`previousHistoryEnd`), written by that turn: read by this one.
 * The context is a text block added to the last history message when it is the user's, else a user message after it.
 */
export function withTurnContext(messages: Anthropic.Beta.BetaMessageParam[], context: string, historyLength: number, previousHistoryEnd?: number): Anthropic.Beta.BetaMessageParam[] {
  const end = Math.max(0, Math.min(historyLength, messages.length));
  const at = end - 1;
  const ctx: LooseBlock = { type: "text", text: context };
  let placed: Anthropic.Beta.BetaMessageParam[];
  let historyBlocks: number | undefined;
  if (at >= 0 && messages[at].role === "user") {
    const blocks = blocksOf(messages[at]);
    historyBlocks = blocks.length;
    placed = [...messages.slice(0, at), { ...messages[at], content: [...blocks, ctx] } as Anthropic.Beta.BetaMessageParam, ...messages.slice(end)];
  } else {
    placed = [...messages.slice(0, end), { role: "user", content: [ctx] } as Anthropic.Beta.BetaMessageParam, ...messages.slice(end)];
  }
  const out = withHistoryCacheBreakpoint(placed);
  if (at >= 0) markMessage(out, at, historyBlocks);
  if (previousHistoryEnd !== undefined && previousHistoryEnd >= 0 && previousHistoryEnd < at) markMessage(out, previousHistoryEnd);
  return out;
}

/** The request AnthropicLlm sends (pure, for tests). */
export function buildRequestParams(req: LlmRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
  // An agent turn: the per-turn context after the history (withTurnContext); otherwise the two system blocks.
  const turn = req.historyLength !== undefined;
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 16000,
    ...(req.fallbacks === false ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    output_config: { effort: req.effort as "low" | "medium" | "high" | "xhigh" | "max" },
    system: [
      { type: "text", text: req.system[0], cache_control: { type: "ephemeral" } },
      ...(turn ? [] : [{ type: "text" as const, text: req.system[1] }]),
    ],
    ...(req.tools.length ? { tools: req.tools } : {}),
    messages: turn ? withTurnContext(req.messages, req.system[1], req.historyLength!, req.previousHistoryEnd) : withHistoryCacheBreakpoint(req.messages),
  };
}

/** The API's 400 for strict tool schemas whose compiled grammar is too large. */
export function isGrammarTooLarge(e: unknown): boolean {
  const err = e as { status?: number; message?: string; error?: { error?: { message?: string } } };
  return err?.status === 400 && /compiled grammar is too large/i.test(String(err.error?.error?.message ?? err.message ?? ""));
}

/** The same request with `strict` removed from every tool (pure, for tests). */
export function withoutStrict<T extends { tools?: unknown[] }>(params: T): T {
  return { ...params, tools: params.tools?.map((t) => { const { strict: _s, ...rest } = t as { strict?: boolean }; void _s; return rest; }) };
}

/** Counts cache_control breakpoints in a request (system, tools and messages). */
export function countCacheBreakpoints(params: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, "system" | "tools" | "messages">): number {
  const has = (b: unknown) => !!(b && typeof b === "object" && (b as { cache_control?: unknown }).cache_control);
  let n = 0;
  if (Array.isArray(params.system)) n += params.system.filter(has).length;
  n += (params.tools ?? []).filter(has).length;
  for (const m of params.messages) if (Array.isArray(m.content)) n += (m.content as unknown[]).filter(has).length;
  return n;
}

/**
 * Tool lists (by hash) whose strict grammar the API found too large, in this
 * process: later calls with the same list go without `strict` straight away
 * (saves a failing round trip). The grammar depends only on the tool schemas.
 */
const grammarTooLargeTools = new Set<string>();
const toolsKey = (tools: readonly unknown[]) => createHash("sha256").update(JSON.stringify(tools)).digest("hex");

/** Tests only: forget which tool lists compiled too large. */
export function resetStrictToolsMemo(): void {
  grammarTooLargeTools.clear();
}

/**
 * Errors where the same request can succeed when sent again: no response or a
 * timeout, 408, 409, 429, any 5xx (529 overloaded included), and the 400 for
 * thinking blocks made with a different tool list (the list is stable per turn,
 * so it is not caused by the request). Auth, permission and other invalid
 * requests fail again and are not retried.
 */
export function isRetryableModelError(e: unknown): boolean {
  const err = e as { status?: number; name?: string; message?: string; error?: { error?: { message?: string } } } | null;
  if (!err || typeof err !== "object") return false;
  if (err.name === "APIConnectionError" || err.name === "APIConnectionTimeoutError") return true;
  const status = err.status;
  if (typeof status !== "number") return false;
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  return status === 400 && /tools.{0,40}differs/i.test(String(err.error?.error?.message ?? err.message ?? ""));
}

/**
 * Claude via the official SDK. Refusal fallbacks are on by default
 * ("default" routing): a declined request is retried server-side on a
 * fallback model inside the same call. Caching: one breakpoint on the stable
 * system block, one on the last block; on an agent turn also on the history's end
 * and the previous turn's history end (withTurnContext).
 */
export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }
  async create(req: LlmRequest): Promise<LlmResponse> {
    const params = buildRequestParams(req);
    const key = params.tools?.length ? toolsKey(params.tools) : null;
    // Pinned by an earlier round of this turn, else non-strict when this tool list is known to compile too large.
    let strict = req.strictTools ?? !(key && grammarTooLargeTools.has(key));
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(strict ? params : withoutStrict(params));
    } catch (e) {
      // A 400 costs nothing. If the strict tool schemas compile too large, send the
      // same request once without `strict` (tool inputs are checked in code anyway).
      // Not when an earlier round of the turn already went strict: its thinking blocks need the same tools.
      if (!strict || req.strictTools === true || !isGrammarTooLarge(e)) throw e;
      console.warn("[agent] strict tool grammar too large; retrying without strict");
      if (key) grammarTooLargeTools.add(key);
      strict = false;
      res = await this.client.beta.messages.create(withoutStrict(params));
    }
    return {
      content: res.content as unknown as Block[],
      stopReason: res.stop_reason,
      model: res.model,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      strictTools: strict,
    };
  }
}

/** True when the app can call the model (ANTHROPIC_API_KEY or another SDK credential is configured). */
export function llmConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Test double: returns scripted responses in order and records requests. */
export class ScriptedLlm implements LlmClient {
  requests: LlmRequest[] = [];
  constructor(private script: ((req: LlmRequest) => Partial<LlmResponse> & { content: Block[] })[]) {}
  async create(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedLlm: no more scripted responses");
    const r = step(req);
    return {
      stopReason: r.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      model: "scripted",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      ...r,
    };
  }
}

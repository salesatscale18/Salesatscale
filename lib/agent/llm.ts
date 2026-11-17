/**
 * The model behind the agent (decision D1), behind a small interface so tests
 * run a scripted fake and never call the API.
 */
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
};

export type LlmResponse = {
  /** Assistant content, to append to the conversation unchanged (thinking blocks included). */
  content: Block[];
  stopReason: string | null;
  model: string;
  /** `cacheWriteTokens`: 5-minute cache writes (the only TTL the agent uses). Optional for fakes. */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number };
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

/** The request AnthropicLlm sends (pure, for tests). */
export function buildRequestParams(req: LlmRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: req.effort as "low" | "medium" | "high" | "xhigh" | "max" },
    system: [
      { type: "text", text: req.system[0], cache_control: { type: "ephemeral" } },
      { type: "text", text: req.system[1] },
    ],
    tools: req.tools,
    messages: withHistoryCacheBreakpoint(req.messages),
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
 * Claude via the official SDK. Refusal fallbacks are on by default
 * ("default" routing): a declined request is retried server-side on a
 * fallback model inside the same call. Caching: one breakpoint on the stable
 * system block, one on the last history block.
 */
export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }
  async create(req: LlmRequest): Promise<LlmResponse> {
    const params = buildRequestParams(req);
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(params);
    } catch (e) {
      // A 400 costs nothing. If the strict tool schemas ever compile too large, send the
      // same request once without `strict` (tool inputs are checked in code anyway).
      if (!isGrammarTooLarge(e)) throw e;
      console.warn("[agent] strict tool grammar too large; retrying without strict");
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

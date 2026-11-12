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
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
};

export interface LlmClient {
  create(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Claude via the official SDK. Refusal fallbacks are on by default
 * ("default" routing): a declined request is retried server-side on a
 * fallback model inside the same call.
 */
export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }
  async create(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.beta.messages.create({
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
      messages: req.messages,
    });
    return {
      content: res.content as unknown as Block[],
      stopReason: res.stop_reason,
      model: res.model,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
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

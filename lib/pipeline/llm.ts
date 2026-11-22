/**
 * The model behind the knowledge pipeline, behind a small interface so tests
 * run a scripted fake (ScriptedPipelineLlm) and never call the API.
 *
 * Request layout (claude-api skill, prompt-caching "shared prefix, varying
 * suffix"): tools (fixed) -> system (fixed, breakpoint 1) -> first user block
 * = the corpus (breakpoint 2, 5-minute TTL: the stages run back to back) ->
 * the stage instruction (after the last breakpoint, varies per stage). Stage 1
 * writes the cache; stage 2 sends the same bytes up to breakpoint 2 and reads it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { PIPELINE_TOOLS, SYSTEM_PROMPT } from "./prompts/system";

export type PipelineEffort = "low" | "medium" | "high";

export type PipelineRequest = {
  model: string;
  effort: PipelineEffort;
  /** The corpus document (or one source of it). */
  corpus: string;
  /** Put a cache breakpoint on the corpus block (only when a later call reads it). */
  cacheCorpus: boolean;
  /**
   * Stage 1 only: original PDF files of sources (base64), sent as document
   * blocks after the corpus block and before the instruction: after the
   * corpus breakpoint, so stage 2 still reads the cached corpus (it does not
   * get the PDFs) and stage 1 writes the same cache as without them.
   */
  documents?: PipelineDocument[];
  /** The stage instruction and data, after the breakpoint. */
  instruction: string;
  maxTokens: number;
  /** Server-side refusal fallback ("default" routing). Not offered on Haiku. */
  fallbacks: boolean;
};

/** One source's original PDF. */
export type PipelineDocument = { sourceId: string; title: string; base64: string };

/** The document block of a source's PDF (pure). */
export function documentBlock(d: PipelineDocument): Anthropic.Beta.BetaRequestDocumentBlock {
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: d.base64 },
    title: d.title.slice(0, 200),
    context: `The original file of source ${d.sourceId}. Its text is in the corpus under that source id.`,
  };
}

export type PipelineUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type PipelineResponse = {
  /** The first tool call in the reply, if any. */
  tool: { name: string; input: unknown } | null;
  stopReason: string | null;
  /** The model that answered (a fallback model after a refusal). */
  model: string;
  usage: PipelineUsage;
};

export interface PipelineLlm {
  create(req: PipelineRequest): Promise<PipelineResponse>;
}

/** The request body the real client streams (pure, for tests). */
export function buildPipelineParams(req: PipelineRequest): Anthropic.Beta.MessageCreateParamsStreaming {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(req.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    output_config: { effort: req.effort },
    tools: PIPELINE_TOOLS,
    tool_choice: { type: "auto" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: [
        { type: "text", text: req.corpus, ...(req.cacheCorpus ? { cache_control: { type: "ephemeral" as const } } : {}) },
        ...(req.documents ?? []).map(documentBlock),
        { type: "text", text: req.instruction },
      ],
    }],
    stream: true,
  };
}

/** Claude via the official SDK, streamed (large max_tokens), final message only. */
export class AnthropicPipelineLlm implements PipelineLlm {
  private client: Anthropic;
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }
  async create(req: PipelineRequest): Promise<PipelineResponse> {
    const { stream: _stream, ...params } = buildPipelineParams(req);
    void _stream;
    const msg = await this.client.beta.messages.stream(params).finalMessage();
    const tool = msg.content.find((b) => b.type === "tool_use");
    return {
      tool: tool && tool.type === "tool_use" ? { name: tool.name, input: tool.input } : null,
      stopReason: msg.stop_reason,
      model: msg.model,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

type ScriptStep = (req: PipelineRequest, params: Anthropic.Beta.MessageCreateParamsStreaming) => Partial<PipelineResponse> & { tool: PipelineResponse["tool"] };

/**
 * Test double: returns scripted replies in order, and records each request
 * and the exact body the real client would send.
 */
export class ScriptedPipelineLlm implements PipelineLlm {
  requests: PipelineRequest[] = [];
  bodies: Anthropic.Beta.MessageCreateParamsStreaming[] = [];
  constructor(private script: ScriptStep[]) {}
  async create(req: PipelineRequest): Promise<PipelineResponse> {
    const params = buildPipelineParams(req);
    this.requests.push(structuredClone(req));
    this.bodies.push(structuredClone(params));
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedPipelineLlm: no more scripted responses");
    const r = step(req, params);
    return {
      stopReason: r.tool ? "tool_use" : "end_turn",
      model: req.model,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...r,
    };
  }
}

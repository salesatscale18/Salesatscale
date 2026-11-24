/**
 * The chat agent's turn (lib/agent/turn.ts, unchanged) on a Vercel AI Gateway
 * language model: the "pipeline" voice architecture's text model. The first
 * supported model is Gemini 3.8 Flash (PIPELINE_TEXT_MODEL).
 *
 * GatewayLlm implements the agent's LlmClient (lib/agent/llm.ts) with the `ai`
 * package's generateText, one model call per create() (no SDK tool loop: tools
 * go without execute, the turn runs them and calls again). The message, tool
 * and result mapping is pure and lives in ./gateway-llm-map.ts.
 *
 * Contract points the turn relies on:
 * - tool_use blocks with unique ids, answered by tool_result blocks next round;
 * - stopReason "refusal" means hand-off (a Gemini content filter maps to it);
 * - usage: uncached input, output, cache reads (+ writes, 0 here); `model` is
 *   the gateway model id, the key of the spend price table (lib/ai/models.ts);
 * - strictTools: Gemini has no strict mode, so the tools always go without it:
 *   every response says false and a pinned value is echoed back unchanged;
 * - errors: thrown as GatewayLlmError with `status` / `name` that the turn's
 *   isRetryableModelError reads (408/409/429/5xx and connection errors retry
 *   once after a tool round); never the request body, prompt or key.
 *
 * Streaming: the LlmClient has no streaming hook yet. A streaming variant only
 * replaces `run` below with streamText (same options, same mapping of the
 * final content).
 */
import { createGateway, generateText, type LanguageModel } from "ai";
import type { LlmClient, LlmRequest, LlmResponse } from "@/lib/agent/llm";
import type { ModelPrice } from "@/lib/ai/models";
import { schemaFamilyOf } from "@/lib/voice/tool-schema";
import { toBlocks, toInstructions, toModelMessages, toStopReason, toTools, toUsage, type ResultPart, type SchemaFlavour } from "./gateway-llm-map";

/** The pipeline's text model (owner decision: ElevenLabs + Gemini 3.8 Flash first). */
export const PIPELINE_TEXT_MODEL = "google/gemini-3.8-flash";

/** Env override of the pipeline's text model, for test-lab experiments: a gateway id `creator/model`. */
export const PIPELINE_TEXT_MODEL_ENV = "VOICE_PIPELINE_TEXT_MODEL";

/**
 * Gemini 3.8 Flash prices (USD per million tokens, from the product brief, 2026-11-24; not checked against
 * the gateway's price page). Spend tracking prices usage from lib/ai/models.ts DEFAULT_PRICES by model id, which
 * carries the same line for PIPELINE_TEXT_MODEL (tests/unit/ai-models.test.ts keeps the two equal).
 * Implicit caching has no write charge.
 */
export const PIPELINE_TEXT_PRICE: ModelPrice = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite5m: 0, cacheWrite1h: 0 };

/** Gateway ids: `creator/model`, e.g. google/gemini-3.8-flash. */
const GATEWAY_MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*$/i;
export const isGatewayModelId = (id: string) => GATEWAY_MODEL_ID.test(id);

/** The `ai` call option `reasoning` (the gateway maps it to the provider's thinking setting). */
export type Reasoning = "none" | "minimal" | "low" | "medium" | "high";

/**
 * The agent version's effort (a Claude scale, default "medium") as Gemini thinking, shifted toward speed:
 * the pipeline answers on a live call. low and medium (the default) → minimal, high → low, xhigh → medium,
 * max → high. Anything else → minimal.
 */
export function reasoningForEffort(effort: string | null | undefined): Reasoning {
  switch (effort) {
    case "high": return "low";
    case "xhigh": return "medium";
    case "max": return "high";
    default: return "minimal";
  }
}

/** A model call that failed: only what the turn needs (status, retryable name), never the request or the key. */
export class GatewayLlmError extends Error {
  constructor(message: string, readonly status?: number, name = "GatewayLlmError") {
    super(message);
    this.name = name;
  }
}

/**
 * Any error from the gateway, the provider or the SDK as a GatewayLlmError (pure). A RetryError is unwrapped
 * to its last error. `status` comes from statusCode / status; timeouts and connection failures get the names
 * isRetryableModelError (lib/agent/llm.ts) retries on. Messages are cut short and carry no request body.
 */
export function toGatewayLlmError(e: unknown): GatewayLlmError {
  if (e instanceof GatewayLlmError) return e;
  let err = e as { name?: string; message?: string; statusCode?: unknown; status?: unknown; lastError?: unknown; type?: unknown; cause?: unknown } | null;
  if (err && typeof err === "object" && err.name === "AI_RetryError" && err.lastError) err = err.lastError as typeof err;
  if (!err || typeof err !== "object") return new GatewayLlmError("Gateway model call failed");
  const status = typeof err.statusCode === "number" ? err.statusCode : typeof err.status === "number" ? err.status : undefined;
  const kind = typeof err.type === "string" ? err.type : err.name ?? "error";
  const short = String(err.message ?? "").replace(/\s+/g, " ").slice(0, 200);
  const message = `Gateway model call failed (${status ?? "no status"}, ${kind})${short ? `: ${short}` : ""}`;
  if (status !== undefined) return new GatewayLlmError(message, status);
  if (/timeout|timed out/i.test(`${err.name} ${short}`) || err.name === "AbortError") return new GatewayLlmError(message, undefined, "APIConnectionTimeoutError");
  if (/fetch failed|ECONN|ENOTFOUND|socket|network/i.test(`${err.name} ${short} ${String((err.cause as { code?: string } | undefined)?.code ?? "")}`)) {
    return new GatewayLlmError(message, undefined, "APIConnectionError");
  }
  return new GatewayLlmError(message);
}

export type GatewayLlmOptions = {
  /** Gateway model id; default PIPELINE_TEXT_MODEL. */
  modelId?: string;
  /** The model to call (tests: a MockLanguageModelV4). Default: the gateway's model, keyed by AI_GATEWAY_API_KEY. */
  model?: LanguageModel;
  /** Thinking: fixed for every call; default from each request's effort (reasoningForEffort). */
  reasoning?: Reasoning;
  /** Tool schema dialect; default from the model id (Gemini's restricted one for google/ models). */
  schema?: SchemaFlavour;
  /** Per-call timeout in ms (a live call cannot wait long); default 30 s. */
  timeoutMs?: number;
  /** SDK retries of a retryable error inside one create(); default 1 (the turn adds one after a tool round). */
  maxRetries?: number;
  env?: Record<string, string | undefined>;
};

/** The real gateway model. Refused under the test runner (tests inject a fake) and without AI_GATEWAY_API_KEY. */
function gatewayModel(modelId: string, env: Record<string, string | undefined>): LanguageModel {
  if (env.VITEST || env.NODE_ENV === "test") throw new GatewayLlmError("GatewayLlm: no real model under the test runner; inject one");
  const apiKey = env.AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) throw new GatewayLlmError("GatewayLlm: AI_GATEWAY_API_KEY is not set");
  return createGateway({ apiKey }).languageModel(modelId);
}

export class GatewayLlm implements LlmClient {
  readonly modelId: string;
  private model: LanguageModel | null;
  private readonly schema: SchemaFlavour;
  private calls = 0;

  constructor(private readonly opts: GatewayLlmOptions = {}) {
    this.modelId = opts.modelId ?? PIPELINE_TEXT_MODEL;
    this.model = opts.model ?? null;
    this.schema = opts.schema ?? (schemaFamilyOf(this.modelId) === "gemini" ? "gemini" : "json");
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    // Mapping errors (a malformed history) are programming errors: thrown as they are, not as model errors.
    const messages = toModelMessages(req.messages);
    const tools = req.tools.length ? toTools(req.tools, this.schema) : undefined;
    const call = ++this.calls;
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      this.model ??= gatewayModel(this.modelId, this.opts.env ?? process.env);
      result = await this.run({ model: this.model, instructions: toInstructions(req.system), messages, tools, req });
    } catch (e) {
      throw toGatewayLlmError(e);
    }
    if (result.finishReason === "error") throw new GatewayLlmError("Gateway model call failed (finish reason: error)", 502);
    const content = toBlocks(result.content as readonly ResultPart[], `gw${call}`);
    return {
      content,
      stopReason: toStopReason(result.finishReason, content.some((b) => b.type === "tool_use")),
      model: this.modelId,
      usage: toUsage(result.usage),
      // No strict mode on Gemini: the tools never go strict. A value pinned by an earlier round is echoed.
      strictTools: req.strictTools ?? false,
    };
  }

  /** One model call (the only place to change for streaming). */
  private run(a: { model: LanguageModel; instructions: string; messages: ReturnType<typeof toModelMessages>; tools: ReturnType<typeof toTools> | undefined; req: LlmRequest }) {
    return generateText({
      model: a.model,
      instructions: a.instructions,
      messages: a.messages,
      ...(a.tools ? { tools: a.tools } : {}),
      maxOutputTokens: a.req.maxTokens ?? 16000,
      reasoning: this.opts.reasoning ?? reasoningForEffort(a.req.effort),
      maxRetries: this.opts.maxRetries ?? 1,
      timeout: this.opts.timeoutMs ?? 30_000,
    });
  }
}

/** The pipeline's text model id: VOICE_PIPELINE_TEXT_MODEL when it is a `creator/model` id, else PIPELINE_TEXT_MODEL. */
export function pipelineTextModel(env: Record<string, string | undefined> = process.env): string {
  const raw = env[PIPELINE_TEXT_MODEL_ENV]?.trim();
  if (!raw) return PIPELINE_TEXT_MODEL;
  if (isGatewayModelId(raw)) return raw;
  console.warn(`[voice-pipeline] ${PIPELINE_TEXT_MODEL_ENV} is not a creator/model gateway id; using ${PIPELINE_TEXT_MODEL}`);
  return PIPELINE_TEXT_MODEL;
}

/** The pipeline's LlmClient for an agent version: the gateway text model, thinking from the version's effort. */
export function pipelineLlmFor(
  version: { effort: string | null },
  env: Record<string, string | undefined> = process.env,
  extra: Pick<GatewayLlmOptions, "model" | "timeoutMs" | "maxRetries"> = {},
): GatewayLlm {
  return new GatewayLlm({ modelId: pipelineTextModel(env), reasoning: reasoningForEffort(version.effort), env, ...extra });
}

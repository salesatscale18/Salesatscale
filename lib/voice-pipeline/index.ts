/**
 * The pipeline engines' parts for a call (lib/voice/socket.ts builds the engine with them):
 * - live (VOICE_REALTIME=live): the Gateway listener and speakers (lib/voice-pipeline/gateway.ts, paid; the speak
 *   attempts of models.ts in a SpeakerChain) and the
 *   thinking client, by engine:
 *   - "pipeline": Gemini 3.8 Flash through the AI Gateway (./gateway-llm.ts pipelineLlmFor: the version's effort as
 *     Gemini thinking; VOICE_PIPELINE_TEXT_MODEL overrides the model), with a per-call timeout for speech;
 *   - "pipeline_lite": the same on Gemini 3.5 Flash-Lite (PIPELINE_TEXT_MODEL_LITE; the env override does not apply);
 *   - "pipeline_chat": the chat's Anthropic client (the agent version's model and effort: the same paid chat turn as
 *     a typed message);
 *   A thinking client that cannot be built (no AI_GATEWAY_API_KEY) refuses the call (model_unavailable, logged by
 *   the socket): never a silent fall back to the other model.
 * - scripted (VOICE_REALTIME=scripted, the harness and tests): the scripted listener and speaker and a ScriptedLlm
 *   stand-in that answers every turn with a fixed line, for both engines. Free: no network, nothing paid.
 */
import { AnthropicLlm, ScriptedLlm, type LlmClient } from "@/lib/agent/llm";
import { isGatewayPipelineEngine, PIPELINE_ENGINE, PIPELINE_LITE_ENGINE, type PipelineEngineName } from "@/lib/voice-classic/engine-choice";
import type { Listener } from "./listener";
import { ScriptedListener } from "./listener";
import { ScriptedSpeaker, SpeakerChain, type Speaker } from "./speaker";
import { PIPELINE_LISTEN_MODEL_ENV, PIPELINE_SPEAK_ATTEMPTS, PIPELINE_VOICE, pipelineListenModelChoice } from "./models";
import { PIPELINE_TEXT_MODEL_LITE, pipelineLlmFor, pipelineTextModel } from "./gateway-llm";
import type { CallTurnFn } from "./turn";

export { PipelineVoiceEngine, type PipelineEngineDeps, type PipelineLimits } from "./engine";

/** What the thinking client is built for: the call's agent version (model for "pipeline_chat", effort for both). */
export type PipelineVersion = { model: string; effort: string | null };

/**
 * Builds a gateway pipeline engine's thinking client for a live call (default: liveGatewayLlm), on `modelId`
 * (pipelineThinkModelFor: the Flash model or its env override on "pipeline", Flash-Lite on "pipeline_lite"; unset:
 * pipelineTextModel(env)).
 */
export type GatewayLlmFactory = (version: PipelineVersion, env: Record<string, string | undefined>, modelId?: string) => LlmClient & { modelId?: string };

export type PipelineParts = {
  listener: () => Listener;
  speaker: Speaker;
  llm: LlmClient;
  turn?: CallTurnFn;
  /** The thinking model id this call uses (settings.pipeline.thinkModel, the trace); unset: the version's model. */
  thinkModel?: string;
};

/** A test's fakes: any part, or the gateway client factory (called with the version and model id, live "pipeline" / "pipeline_lite" calls only). */
export type PipelineOverrides = Partial<PipelineParts> & { gatewayLlm?: GatewayLlmFactory };

/** Per-call timeout of the gateway thinking call on a live call (speech cannot wait long), and its SDK retries. */
export const PIPELINE_THINK_TIMEOUT_MS = 15_000;
export const PIPELINE_THINK_MAX_RETRIES = 1;

/** The thinking model id of a scripted call (the ScriptedLlm stand-in). */
export const SCRIPTED_THINK_MODEL = "scripted";

/** The fixed reply of the scripted chat stand-in. */
export const SCRIPTED_PIPELINE_REPLY = "This is the scripted pipeline reply. In a live call the chat agent answers here.";

/** A ScriptedLlm that answers every turn with the fixed reply (no tokens counted). */
export function scriptedPipelineLlm(turns = 500): ScriptedLlm {
  return new ScriptedLlm(Array.from({ length: turns }, () => () => ({
    content: [{ type: "text" as const, text: SCRIPTED_PIPELINE_REPLY }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  })));
}

/** A thinking client that could not be built: the call is refused (the message says which model and why). */
export class PipelineThinkingUnavailable extends Error {
  constructor(readonly modelId: string, why: string) {
    super(`pipeline thinking model unavailable (${modelId}): ${why}`);
    this.name = "PipelineThinkingUnavailable";
  }
}

/**
 * The gateway text model a gateway pipeline engine thinks on: "pipeline_lite" → PIPELINE_TEXT_MODEL_LITE (no env
 * override); "pipeline" → pipelineTextModel(env) (VOICE_PIPELINE_TEXT_MODEL, else Gemini 3.8 Flash).
 */
export const pipelineThinkModelFor = (engine: PipelineEngineName, env: Record<string, string | undefined>): string =>
  engine === PIPELINE_LITE_ENGINE ? PIPELINE_TEXT_MODEL_LITE : pipelineTextModel(env);

/**
 * A gateway pipeline engine's live thinking client: GatewayLlm on `modelId`, 15 s per call, 1 SDK retry, thinking
 * from the version's effort (the same for "pipeline" and "pipeline_lite").
 * Throws PipelineThinkingUnavailable without AI_GATEWAY_API_KEY (GatewayLlm itself would only fail at the first
 * turn, after the opener was spoken).
 */
export const liveGatewayLlm: GatewayLlmFactory = (version, env, modelId = pipelineTextModel(env)) => {
  if (!env.AI_GATEWAY_API_KEY?.trim()) throw new PipelineThinkingUnavailable(modelId, "AI_GATEWAY_API_KEY is not set");
  return pipelineLlmFor(version, env, { modelId, timeoutMs: PIPELINE_THINK_TIMEOUT_MS, maxRetries: PIPELINE_THINK_MAX_RETRIES });
};

const modelIdOf = (llm: LlmClient): string | undefined => {
  const id = (llm as { modelId?: unknown }).modelId;
  return typeof id === "string" && id ? id : undefined;
};

/**
 * The parts for a call in this mode on this engine; `overrides`: a test's fakes. Live parts are built only for a
 * live call. `thinkModel` is the thinking client's own model id when it has one (GatewayLlm), else unset (the
 * version's chat model).
 */
export async function pipelinePartsFor(
  mode: "live" | "scripted", env: Record<string, string | undefined>, overrides: PipelineOverrides = {},
  call: { engine: PipelineEngineName; version: PipelineVersion } = { engine: PIPELINE_ENGINE, version: { model: "", effort: null } },
): Promise<PipelineParts> {
  const turn = overrides.turn ? { turn: overrides.turn } : {};
  if (mode === "scripted") {
    const llm = overrides.llm ?? scriptedPipelineLlm();
    // The model actually used: the scripted stand-in (shown as "Scripted"), whichever engine was picked.
    const thinkModel = overrides.thinkModel ?? modelIdOf(llm) ?? (overrides.llm ? undefined : SCRIPTED_THINK_MODEL);
    return {
      listener: overrides.listener ?? (() => new ScriptedListener()),
      speaker: overrides.speaker ?? new ScriptedSpeaker(),
      llm,
      ...turn,
      ...(thinkModel ? { thinkModel } : {}),
    };
  }
  // The thinking client first: a call that cannot think is refused before anything paid starts.
  let llm: LlmClient;
  if (overrides.llm) llm = overrides.llm;
  else if (isGatewayPipelineEngine(call.engine)) {
    const modelId = pipelineThinkModelFor(call.engine, env);
    try {
      llm = (overrides.gatewayLlm ?? liveGatewayLlm)(call.version, env, modelId);
    } catch (e) {
      if (e instanceof PipelineThinkingUnavailable) throw e;
      throw new PipelineThinkingUnavailable(modelId, e instanceof Error ? e.message : String(e));
    }
  } else llm = { create: (req) => new AnthropicLlm().create(req) };
  const thinkModel = overrides.thinkModel ?? modelIdOf(llm) ?? (call.version.model || undefined);
  const { GatewayListener, GatewaySpeaker } = await import("./gateway");
  // The listening model: VOICE_PIPELINE_LISTEN_MODEL when valid (the start log names it and its rate), else the default.
  const listen = pipelineListenModelChoice(env);
  if (listen.invalid) console.warn(`[voice-pipeline] ${PIPELINE_LISTEN_MODEL_ENV} ignored (${listen.invalid}); listening with ${listen.model}`);
  return {
    listener: overrides.listener ?? (() => new GatewayListener(listen.model, env)),
    // The speak attempts in order (models.ts PIPELINE_SPEAK_ATTEMPTS): the first that produces audio is kept.
    speaker: overrides.speaker ?? new SpeakerChain(PIPELINE_SPEAK_ATTEMPTS.map((a) => ({ ...a, speaker: new GatewaySpeaker(a.model, env, PIPELINE_VOICE, { dialogue: a.dialogue }) }))),
    llm,
    ...turn,
    ...(thinkModel ? { thinkModel } : {}),
  };
}

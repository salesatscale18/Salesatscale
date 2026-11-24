/**
 * The pipeline proof's parts for a call (lib/voice/socket.ts builds the engine with them):
 * - live (VOICE_REALTIME=live): the Gateway listener and speaker (lib/voice-pipeline/gateway.ts, paid) and the
 *   chat's Anthropic client (the agent version's model and effort: the same paid chat turn as a typed message);
 * - scripted (VOICE_REALTIME=scripted, the harness and tests): the scripted listener and speaker and a ScriptedLlm
 *   stand-in that answers every turn with a fixed line. Free: no network, nothing paid.
 */
import { AnthropicLlm, ScriptedLlm, type LlmClient } from "@/lib/agent/llm";
import type { Listener } from "./listener";
import { ScriptedListener } from "./listener";
import { ScriptedSpeaker, type Speaker } from "./speaker";
import { PIPELINE_LISTEN_MODEL, PIPELINE_SPEAK_MODEL } from "./models";
import type { CallTurnFn } from "./turn";

export { PipelineVoiceEngine, type PipelineEngineDeps, type PipelineLimits } from "./engine";

export type PipelineParts = { listener: () => Listener; speaker: Speaker; llm: LlmClient; turn?: CallTurnFn };

/** The fixed reply of the scripted chat stand-in. */
export const SCRIPTED_PIPELINE_REPLY = "This is the scripted pipeline reply. In a live call the chat agent answers here.";

/** A ScriptedLlm that answers every turn with the fixed reply (no tokens counted). */
export function scriptedPipelineLlm(turns = 500): ScriptedLlm {
  return new ScriptedLlm(Array.from({ length: turns }, () => () => ({
    content: [{ type: "text" as const, text: SCRIPTED_PIPELINE_REPLY }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  })));
}

/** The parts for a call in this mode; `overrides`: a test's fakes. Live parts are built only for a live call. */
export async function pipelinePartsFor(
  mode: "live" | "scripted", env: Record<string, string | undefined>, overrides: Partial<PipelineParts> = {},
): Promise<PipelineParts> {
  if (mode === "scripted") {
    return {
      listener: overrides.listener ?? (() => new ScriptedListener()),
      speaker: overrides.speaker ?? new ScriptedSpeaker(),
      llm: overrides.llm ?? scriptedPipelineLlm(),
      ...(overrides.turn ? { turn: overrides.turn } : {}),
    };
  }
  const { GatewayListener, GatewaySpeaker } = await import("./gateway");
  return {
    listener: overrides.listener ?? (() => new GatewayListener(PIPELINE_LISTEN_MODEL, env)),
    speaker: overrides.speaker ?? new GatewaySpeaker(PIPELINE_SPEAK_MODEL, env),
    llm: overrides.llm ?? { create: (req) => new AnthropicLlm().create(req) },
    ...(overrides.turn ? { turn: overrides.turn } : {}),
  };
}

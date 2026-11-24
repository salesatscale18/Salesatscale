/**
 * Which voice engine runs a call: "current" (lib/voice/engine.ts, the default and the only one for buyers),
 * "classic" (lib/voice-classic/engine.ts, the 20 Nov engine) or "guarded" ("Classic + guards": today's engine with
 * the Classic model side and today's guards, lib/voice-guarded) or "guarded_silent" (guarded plus, on Gemini, the
 * silent bookkeeping probe: lib/voice-guarded/silent-probe.ts), picked in the test lab by platform admins only; or a pipeline (lib/voice-pipeline: a transcription model listens, the
 * chat turn decides, ElevenLabs speaks; test lab only): "pipeline" thinks on Gemini 3.8 Flash through the AI Gateway,
 * "pipeline_lite" on Gemini 3.5 Flash-Lite through the AI Gateway, "pipeline_chat" on the agent version's own chat model.
 * Or a realtime model + ElevenLabs (lib/voice-rt-eleven, test lab only, owner 24 Nov 2026): today's engine with the
 * guarded profile, an OpenAI realtime model listening and deciding in TEXT, ElevenLabs speaking: "rt_eleven" on
 * GPT-Realtime 2.1, "rt_eleven_mini" on GPT-Realtime mini. They replace the pipeline options in the select: a new call
 * on a pipeline engine is refused (the start action); their ids stay valid so old calls keep their labels.
 * The choice is stored on the session (voice_sessions.settings.engine) and read from the row by the socket.
 * Pure and import-safe from client code.
 */
import { voiceLabAccess } from "@/lib/voice/lab";

export const VOICE_ENGINES = ["current", "classic", "guarded", "guarded_silent", "pipeline", "pipeline_lite", "pipeline_chat", "rt_eleven", "rt_eleven_mini"] as const;
export type VoiceEngineName = (typeof VOICE_ENGINES)[number];
export const CLASSIC_ENGINE = "classic" as const satisfies VoiceEngineName;
export const GUARDED_ENGINE = "guarded" as const satisfies VoiceEngineName;
export const GUARDED_SILENT_ENGINE = "guarded_silent" as const satisfies VoiceEngineName;
export const PIPELINE_ENGINE = "pipeline" as const satisfies VoiceEngineName;
export const PIPELINE_LITE_ENGINE = "pipeline_lite" as const satisfies VoiceEngineName;
export const PIPELINE_CHAT_ENGINE = "pipeline_chat" as const satisfies VoiceEngineName;
/**
 * The pipeline engines (lib/voice-pipeline): Gemini Flash thinking ("pipeline"), Gemini Flash-Lite thinking
 * ("pipeline_lite") or the chat model ("pipeline_chat").
 */
export type PipelineEngineName = typeof PIPELINE_ENGINE | typeof PIPELINE_LITE_ENGINE | typeof PIPELINE_CHAT_ENGINE;
export const isPipelineEngine = (e: unknown): e is PipelineEngineName => e === PIPELINE_ENGINE || e === PIPELINE_LITE_ENGINE || e === PIPELINE_CHAT_ENGINE;
/** The pipeline engines that think on a gateway text model (GatewayLlm): "pipeline" and "pipeline_lite". */
export const isGatewayPipelineEngine = (e: unknown): e is typeof PIPELINE_ENGINE | typeof PIPELINE_LITE_ENGINE => e === PIPELINE_ENGINE || e === PIPELINE_LITE_ENGINE;

export const RT_ELEVEN_ENGINE = "rt_eleven" as const satisfies VoiceEngineName;
export const RT_ELEVEN_MINI_ENGINE = "rt_eleven_mini" as const satisfies VoiceEngineName;
/** The realtime + ElevenLabs engines (lib/voice-rt-eleven). */
export type RtElevenEngineName = typeof RT_ELEVEN_ENGINE | typeof RT_ELEVEN_MINI_ENGINE;
export const isRtElevenEngine = (e: unknown): e is RtElevenEngineName => e === RT_ELEVEN_ENGINE || e === RT_ELEVEN_MINI_ENGINE;
/** The realtime model each realtime + ElevenLabs engine listens and decides with (fixed: not the version's model). */
export const RT_ELEVEN_MODELS: Readonly<Record<RtElevenEngineName, string>> = {
  rt_eleven: "openai/gpt-realtime-2.1",
  rt_eleven_mini: "openai/gpt-realtime-mini",
};

/**
 * Engines no new call may start on (the start action refuses them; their code and labels stay for old calls' cards):
 * the pipelines (owner, 24 Nov 2026), and since the rewiring of 24 Nov the realtime + ElevenLabs engines and the
 * silent probe. ElevenLabs is now a Voice settings choice ("Voice from", lib/voice-rt-eleven/rule.ts): the select
 * picks only the wiring.
 */
export const isRetiredEngine = (e: unknown): boolean => isPipelineEngine(e) || isRtElevenEngine(e) || e === GUARDED_SILENT_ENGINE;

/** The engines that run today's engine with the guarded profile (lib/voice-guarded/profile.ts). */
export const isGuardedEngine = (e: VoiceEngineName): e is typeof GUARDED_ENGINE | typeof GUARDED_SILENT_ENGINE => e === GUARDED_ENGINE || e === GUARDED_SILENT_ENGINE;

/** The i18n key of an engine's label (the select, the call card, the header pill). */
export const engineLabelKey = (engine: VoiceEngineName | null | undefined) =>
  engine === CLASSIC_ENGINE ? "lab.voice.engine.classic"
    : engine === GUARDED_ENGINE ? "lab.voice.engine.guarded"
      : engine === GUARDED_SILENT_ENGINE ? "lab.voice.engine.guarded_silent"
        : engine === PIPELINE_ENGINE ? "lab.voice.engine.pipeline"
          : engine === PIPELINE_LITE_ENGINE ? "lab.voice.engine.pipeline_lite"
          : engine === PIPELINE_CHAT_ENGINE ? "lab.voice.engine.pipeline_chat"
          : engine === RT_ELEVEN_ENGINE ? "lab.voice.engine.rt_eleven"
          : engine === RT_ELEVEN_MINI_ENGINE ? "lab.voice.engine.rt_eleven_mini"
          : "lab.voice.engine.current";

/**
 * The date each engine's label names ("Live for buyers (22 Nov)"): when that engine's code was set, written here by
 * hand (never computed). Change it together with the engine.
 */
export const ENGINE_DATES: Readonly<Record<VoiceEngineName, string>> = {
  current: "22 Nov", guarded: "23 Nov", guarded_silent: "23 Nov", classic: "20 Nov", pipeline: "24 Nov", pipeline_lite: "24 Nov", pipeline_chat: "24 Nov",
  rt_eleven: "24 Nov", rt_eleven_mini: "24 Nov",
};

/**
 * The test lab's "Voice engine" list: the WIRING only (owner, 24 Nov 2026: one rule; the version's Voice settings
 * decide the model and the voice). Live for buyers first, the old baseline last. The retired ids are not offered
 * (isRetiredEngine).
 */
export const ENGINE_ORDER: readonly VoiceEngineName[] = ["current", "guarded", "classic"];

/** An engine's label's values ({date}). */
export const engineLabelVars = (engine: VoiceEngineName | null | undefined) => ({ date: ENGINE_DATES[engine ?? "current"] ?? ENGINE_DATES.current });

/** The i18n key of the one helper line under the engine row: what the engine is based on and whether buyers get it. */
export const engineHelpKey = (engine: VoiceEngineName) => `lab.voice.engine_help.${engine}` as const;

/** An engine other than Current, as stored or posted ("classic", "guarded", "guarded_silent", a pipeline, "rt_eleven", "rt_eleven_mini"); null for anything else. */
export const otherEngine = (v: unknown): Exclude<VoiceEngineName, "current"> | null =>
  (v === CLASSIC_ENGINE || v === GUARDED_ENGINE || v === GUARDED_SILENT_ENGINE || isPipelineEngine(v) || isRtElevenEngine(v) ? v : null);

/** The engine a session runs on, from its settings JSON: another engine only when stored so; anything else is Current. */
export function sessionEngine(settings: unknown): VoiceEngineName {
  const stored = settings && typeof settings === "object" ? (settings as { engine?: unknown }).engine : null;
  return otherEngine(stored) ?? "current";
}

/**
 * The engine a test-lab call starts on: what the form posted, honoured only for a platform admin (the same check as
 * the voice model picker and the whole voice lab: lib/voice/lab.ts voiceLabAccess). Anyone else gets Current.
 */
export function labEngineChoice(user: { role: string } | null | undefined, posted: unknown, env: Record<string, string | undefined> = process.env): VoiceEngineName {
  if (voiceLabAccess(user, env) !== "ok") return "current";
  return otherEngine(posted) ?? "current";
}

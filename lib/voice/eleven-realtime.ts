/**
 * ElevenLabs Realtime as the call's voice model (the "elevenlabs" family, lib/voice/settings.ts): ElevenLabs end to end
 * (speech to speech) through the Gateway's OpenAI-compatible realtime protocol, on the Current engine. The parts that
 * differ from the OpenAI family: the buyer-call rule, the session-duration price, and what the first live calls log.
 * Pure (no server imports): unit-tested.
 */
import {
  realtimePriceTable, realtimeUsdPerMinute, voiceCallCost,
  type RealtimePrice, type RealtimeUsageAccumulator, type VoiceCallUsageRecord,
} from "@/lib/ai/models";
import { DEFAULT_VOICE_MODEL, ELEVEN_REALTIME_FOR_BUYER_CALLS, isElevenRealtimeModel, voiceModelId } from "./settings";

/**
 * USD per CONNECTED second of an ElevenLabs Realtime session (Vercel AI Gateway model page, 24 Nov 2026: $0.0013334 a
 * second on both, about $0.08 a minute), billed on top of the tokens (lib/ai/models.ts DEFAULT_REALTIME_PRICES).
 */
export const ELEVEN_REALTIME_SESSION_USD_PER_SEC: Readonly<Record<string, number>> = {
  "elevenlabs/eleven-realtime-v1-mini": 0.0013334,
  "elevenlabs/eleven-realtime-v1-max": 0.0013334,
};

/** USD per connected second of a model's session (0: the model is billed on tokens only). */
export function sessionUsdPerSecond(modelId: string): number {
  return ELEVEN_REALTIME_SESSION_USD_PER_SEC[modelId] ?? 0;
}

/** The session part of a call's cost in USD micros: model-connected seconds × the per-second rate (0 for other models). */
export function sessionCostMicros(modelId: string, activeSec: number): number {
  const s = Number.isFinite(activeSec) && activeSec > 0 ? activeSec : 0;
  return Math.round(s * sessionUsdPerSecond(modelId) * 1_000_000);
}

/** The usage record of a call with a session price: the session seconds and their cost are kept next to the tokens'. */
export type SessionPricedUsage = VoiceCallUsageRecord & { sessionSec?: number; sessionCostMicros?: number };

/**
 * A live call's cost on the realtime engine: lib/ai/models.ts voiceCallCost (the larger of the usage-based and the
 * duration-floor token estimate), plus, for a model with a session price, model-connected seconds × that price. Other
 * models: exactly voiceCallCost.
 */
export function realtimeCallCost(
  modelId: string, acc: RealtimeUsageAccumulator, activeSec: number, prices: Record<string, RealtimePrice> = realtimePriceTable(),
): { costMicros: number; usage: SessionPricedUsage } {
  const base = voiceCallCost(modelId, acc, activeSec, prices);
  const session = sessionCostMicros(modelId, activeSec);
  if (!sessionUsdPerSecond(modelId)) return base;
  return {
    costMicros: base.costMicros + session,
    usage: { ...base.usage, sessionSec: Math.max(0, Math.round(activeSec)), sessionCostMicros: session },
  };
}

/**
 * Estimated USD a minute of call: the duration estimate's tokens (lib/ai/models.ts realtimeUsdPerMinute) plus a minute
 * of session where the model has a session price. Null without a token price.
 */
export function voiceUsdPerMinute(modelId: string, prices?: Record<string, RealtimePrice>): number | null {
  const tokens = realtimeUsdPerMinute(modelId, prices);
  return tokens === null ? null : tokens + sessionUsdPerSecond(modelId) * 60;
}

/** The model picker's cost line for a model with a session price ("about $0.08 a minute for the session plus tokens"). */
export function sessionCostHint(modelId: string, prices?: Record<string, RealtimePrice>): string | null {
  const perSec = sessionUsdPerSecond(modelId);
  if (!perSec) return null;
  const tokens = realtimeUsdPerMinute(modelId, prices);
  const session = `$${(perSec * 60).toFixed(2)}`;
  return tokens === null
    ? `About ${session} a minute of call for the session, plus tokens (no token price on file).`
    : `About ${session} a minute of call for the session, plus tokens (about $${tokens.toFixed(3)} a minute at the usual estimate).`;
}

// ---------------------------------------------------------------------------
// Buyer calls
// ---------------------------------------------------------------------------

/**
 * The model a new call runs on. ElevenLabs Realtime only on TEST calls while ELEVEN_REALTIME_FOR_BUYER_CALLS is off: a
 * buyer call on a version set to it runs on the platform default (VOICE_MODEL, else Gemini; Gemini when VOICE_MODEL is
 * itself ElevenLabs Realtime), and `ignored` says so for the log.
 */
export function callModelFor(
  modelId: string, isTest: boolean, env: Record<string, string | undefined> = process.env, forBuyers: boolean = ELEVEN_REALTIME_FOR_BUYER_CALLS,
): { modelId: string; ignored: string | null } {
  if (!isElevenRealtimeModel(modelId) || isTest || forBuyers) return { modelId, ignored: null };
  const platform = voiceModelId(env);
  const fallback = isElevenRealtimeModel(platform) ? DEFAULT_VOICE_MODEL : platform;
  return { modelId: fallback, ignored: `model ${modelId} ignored on a buyer call (ElevenLabs Realtime is for test calls only): ${fallback} instead` };
}

/** True when the call ran without tools (its session snapshot's `toolsOff`, lib/voice/engine.ts settingsSnapshot). */
export function callToolsOff(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && (settings as { toolsOff?: unknown }).toolsOff === true;
}

// ---------------------------------------------------------------------------
// What the first live calls log (the unknowns: voice, tools, turn detection)
// ---------------------------------------------------------------------------

const SECRETISH = /secret|key|token|auth|password|credential/i;

const clipText = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** A value for the log: short JSON, keys that may hold a secret dropped, long strings cut. */
function brief(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== "object") return typeof v === "string" ? clipText(v, 40) : v;
  if (depth > 2) return Array.isArray(v) ? `[${v.length}]` : "{…}";
  if (Array.isArray(v)) return v.slice(0, 4).map((x) => brief(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRETISH.test(k)).map(([k, x]) => [k, brief(x, depth + 1)]));
}

const pick = (o: Record<string, unknown>, ...paths: string[][]): unknown => {
  for (const p of paths) {
    let cur: unknown = o;
    for (const k of p) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    if (cur !== undefined) return cur;
  }
  return undefined;
};

/**
 * The session-created / session-updated acknowledgement as the provider returned it, for the log (clipped to 300
 * characters; never the instructions, never a key that may hold a secret): the voice it took, how many tools, its turn
 * detection, modalities, audio formats and transcription, and the other field names it returned. Reads the OpenAI
 * shape (`{ session: { voice, tools, turn_detection, … } }`, GA `audio.output.voice` / `audio.input.turn_detection`)
 * and a flat one; anything missing reads "-". It ends with what the provider echoes for parallel tool calls and
 * reasoning effort (`parallel=true reasoning=low`, "-" when absent), never clipped away.
 */
export function sessionAckSummary(raw: unknown): string {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const s = (r.session && typeof r.session === "object" ? r.session : r) as Record<string, unknown>;
  const tools = pick(s, ["tools"]);
  const show = (v: unknown) => (v === undefined ? "-" : JSON.stringify(brief(v)));
  const parts = [
    `voice=${show(pick(s, ["voice"], ["audio", "output", "voice"]))}`,
    `tools=${Array.isArray(tools) ? tools.length : tools === undefined ? "-" : "?"}`,
    `turnDetection=${show(pick(s, ["turn_detection"], ["turnDetection"], ["audio", "input", "turn_detection"]))}`,
    `modalities=${show(pick(s, ["output_modalities"], ["modalities"], ["outputModalities"]))}`,
    `transcription=${show(pick(s, ["input_audio_transcription"], ["audio", "input", "transcription"], ["inputAudioTranscription"]))}`,
    `model=${show(pick(s, ["model"]))}`,
    `fields=${Object.keys(s).filter((k) => !SECRETISH.test(k)).join(",") || "-"}`,
  ];
  // Always kept at the end, whatever is clipped before it: what runs for parallel tool calls and reasoning effort.
  // The turn detection that runs (server_vad / semantic_vad) and its eagerness (Turn ending: Smart), then the rest.
  const td = pick(s, ["audio", "input", "turn_detection"], ["turn_detection"], ["turnDetection"]);
  const tdo = td && typeof td === "object" ? (td as Record<string, unknown>) : null;
  const tail = `turn=${tdo ? echoed(tdo.type) : td === null ? "none" : "-"} eagerness=${tdo ? echoed(tdo.eagerness) : "-"} `
    + `parallel=${echoed(pick(s, ["parallel_tool_calls"], ["parallelToolCalls"]))} reasoning=${echoed(pick(s, ["reasoning", "effort"], ["reasoning_effort"], ["reasoningEffort"]))}`;
  return `${clipText(parts.join(" "), 300 - tail.length - 1)} ${tail}`;
}

/** A scalar the provider echoed, as a bare value for the log ("true", "low"); "-" when absent, "?" when not a scalar. */
function echoed(v: unknown): string {
  if (v === undefined || v === null) return "-";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return clipText(v, 20).replace(/\s+/g, "_") || "-";
  return "?";
}

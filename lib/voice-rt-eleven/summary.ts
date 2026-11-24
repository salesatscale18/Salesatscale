/**
 * What the test lab shows about a call where ElevenLabs spoke (text output) ("This call": the listening-and-thinking model, the
 * speaking model, the median answer time), read from the session's settings and usage JSON
 * (voice_sessions.settings.rtEleven, usage.rtEleven; no schema change). Pure and import-safe from client code.
 */
import { isRtElevenEngine } from "@/lib/voice-classic/engine-choice";
import {
  DEFAULT_ELEVEN_CHOICE, ELEVEN_STABILITY_LABELS, elevenModelInfo, elevenVoiceLabel, isElevenModel, isElevenStability, isElevenVoice, type ElevenChoice,
} from "./catalog";

/** Written at go-live (settings.rtEleven): the realtime model, the first speech model tried and the voice. */
export type RtElevenSettings = { realtimeModel: string; speakModel: string; voice: string };

/** Written with the call's figures (usage.rtEleven): what the speech side used and the per-turn medians. */
export type RtElevenUsage = {
  realtimeModel: string;
  /** The speech model the call kept (the first attempt that produced audio; the first in the list if none did). */
  speakModel: string;
  /** Characters whose synthesis produced audio (what ElevenLabs bills). */
  spokenChars: number;
  /** The realtime model's estimated cost (its usage, text output; never below the listening floor). */
  realtimeCostMicros: number;
  /** spokenChars × the speech model's rate (lib/voice-pipeline/models.ts SPEAK_MICROS_PER_CHAR); 0 when scripted. */
  speakCostMicros: number;
  /** False when the speech model has no rate (its characters count 0). */
  speakRateKnown: boolean;
  /** Spoken replies to a buyer turn (with think/speak/total times). */
  turns: number;
  medianAnswerMs: number | null;
  medianThinkMs: number | null;
  medianSpeakMs: number | null;
  /** Tool rounds (responses that called tools) per answered turn, median. */
  medianToolRounds: number | null;
  /** Texts of responses with a tool call, never spoken (`rt text before tool dropped`). */
  droppedTexts: number;
  bargeIns: number;
};

export type RtElevenCallInfo = {
  realtimeModel: string; speakModel: string; medianAnswerMs: number | null; medianThinkMs: number | null;
  /** The ElevenLabs voice heard ("Sarah (ElevenLabs)"): what applied (settings.elevenApplied, after the call), else the version's choice. */
  voice: string;
  /** The version's choice (elevenApplied.chosen, else the go-live snapshot's elevenModel/elevenVoice/elevenStability; defaults for older calls). */
  chosen: ElevenChoice;
  /** The chosen model/voice failed and the fallback spoke: the reason; null otherwise. */
  fallback: string | null;
  /** Languages the substitute model (v4 Turbo) spoke because the chosen model does not speak them. */
  substituted: string[];
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The text-output + ElevenLabs info of a session (its settings and usage JSON): a call on a retired rt_eleven engine,
 * or any call where ElevenLabs actually spoke (settings.speech "elevenlabs" / settings.rtEleven, written at go-live
 * from what applied). Null for every other call.
 */
export function rtElevenCallInfo(settings: unknown, usage: unknown): RtElevenCallInfo | null {
  const s = settings && typeof settings === "object" ? (settings as { engine?: unknown; speech?: unknown; rtEleven?: Record<string, unknown> }) : null;
  if (!isRtElevenEngine(s?.engine) && s?.speech !== "elevenlabs" && !(s?.rtEleven && typeof s.rtEleven === "object")) return null;
  const p = s?.rtEleven ?? {};
  const u = usage && typeof usage === "object" ? ((usage as { rtEleven?: Record<string, unknown> }).rtEleven ?? {}) : {};
  const all = (s ?? {}) as Record<string, unknown>;
  const applied = all.elevenApplied && typeof all.elevenApplied === "object" ? (all.elevenApplied as Record<string, unknown>) : null;
  const c = applied?.chosen && typeof applied.chosen === "object" ? (applied.chosen as Record<string, unknown>) : null;
  const askedModel = c ? c.model : all.elevenModel;
  const askedVoice = c ? c.voice : all.elevenVoice;
  const askedStability = c ? c.stability : all.elevenStability;
  const chosen: ElevenChoice = {
    model: isElevenModel(askedModel) ? askedModel : DEFAULT_ELEVEN_CHOICE.model,
    voice: isElevenVoice(askedVoice) ? askedVoice : DEFAULT_ELEVEN_CHOICE.voice,
    stability: isElevenStability(askedStability) ? askedStability : DEFAULT_ELEVEN_CHOICE.stability,
  };
  return {
    realtimeModel: str(u.realtimeModel) || str(p.realtimeModel),
    // Speaking: the model the call kept (usage, written at the end), else what applied, else the first one tried (go-live).
    speakModel: str(u.speakModel) || str(applied?.model) || str(p.speakModel),
    medianAnswerMs: num(u.medianAnswerMs), medianThinkMs: num(u.medianThinkMs),
    voice: elevenVoiceLabel(str(applied?.voice) || chosen.voice), chosen,
    fallback: str(applied?.fallback) || null,
    substituted: Array.isArray(applied?.substituted) ? (applied.substituted as unknown[]).filter((x): x is string => typeof x === "string") : [],
  };
}

/** The call card's voice row for a call where ElevenLabs spoke (no fillers: ElevenLabs says none); null otherwise. */
export function rtElevenVoiceUsed(settings: unknown, usage: unknown): { voice: string; fillers: boolean } | null {
  const info = rtElevenCallInfo(settings, usage);
  return info ? { voice: info.voice, fillers: false } : null;
}

/**
 * The call card's "Speaking" value: "ElevenLabs v4 Turbo · Steady" (the steadiness only when a dialogue-mode model spoke
 * with the version's choice), the raw id for anything else ("scripted").
 */
export function rtSpeakText(info: Pick<RtElevenCallInfo, "speakModel" | "chosen" | "fallback">): string {
  const m = elevenModelInfo(info.speakModel);
  if (!m) return info.speakModel;
  const own = !info.fallback && m.dialogue ? ` · ${ELEVEN_STABILITY_LABELS[String(info.chosen.stability)]}` : "";
  return `${m.name}${own}`;
}

/** The median of a list (null when empty), rounded. */
export function medianOf(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

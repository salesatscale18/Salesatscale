/**
 * What the test lab shows about a realtime + ElevenLabs call ("This call": the listening-and-thinking model, the
 * speaking model, the median answer time), read from the session's settings and usage JSON
 * (voice_sessions.settings.rtEleven, usage.rtEleven; no schema change). Pure and import-safe from client code.
 */
import { isRtElevenEngine } from "@/lib/voice-classic/engine-choice";

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

export type RtElevenCallInfo = { realtimeModel: string; speakModel: string; medianAnswerMs: number | null; medianThinkMs: number | null };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The realtime + ElevenLabs info of a session (its settings and usage JSON), or null for any other engine. */
export function rtElevenCallInfo(settings: unknown, usage: unknown): RtElevenCallInfo | null {
  const s = settings && typeof settings === "object" ? (settings as { engine?: unknown; rtEleven?: Record<string, unknown> }) : null;
  if (!isRtElevenEngine(s?.engine)) return null;
  const p = s?.rtEleven ?? {};
  const u = usage && typeof usage === "object" ? ((usage as { rtEleven?: Record<string, unknown> }).rtEleven ?? {}) : {};
  return {
    realtimeModel: str(u.realtimeModel) || str(p.realtimeModel),
    // Speaking: the model the call kept (usage, written at the end), else the first one tried (settings, at go-live).
    speakModel: str(u.speakModel) || str(p.speakModel),
    medianAnswerMs: num(u.medianAnswerMs), medianThinkMs: num(u.medianThinkMs),
  };
}

/** The median of a list (null when empty), rounded. */
export function medianOf(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

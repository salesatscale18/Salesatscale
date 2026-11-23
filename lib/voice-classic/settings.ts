/**
 * CLASSIC (20 Nov) settings bits: the parts of lib/voice/settings.ts at commit af85493 (20 Nov 2026) the Classic
 * engine reads (resolved settings, turn-taking, pace line, call length), frozen. Left out: validation and the
 * voice modes (the settings UI and the socket use today's). Added: the Classic model rule (Gemini only).
 *
 * Original header (20 Nov):
 * Voice call settings and modes (live voice). Pure and import-safe from
 * server code and client code alike (no server imports): the call screen and
 * the settings UI read the same defaults, capabilities and validation.
 */
import type { VoiceSettings } from "@/db/schema";
import { CALL_RULES } from "./call-rules";

export type { VoiceSettings };

/** The platform's longest call. A version's setting can only lower it. */
export const PLATFORM_MAX_CALL_SEC: number = CALL_RULES.platformMaxCallSec;
/** A call's longest length unless the version sets another (standby counts too): lib/voice/call-rules.ts. */
export const DEFAULT_MAX_CALL_SEC: number = CALL_RULES.defaultMaxCallSec;
/** The shortest maximum a seller may set. */
export const MIN_CALL_SEC = 60;

export const VOICE_PACES = ["slower", "normal", "faster"] as const;
export const VOICE_STYLES = ["patient", "balanced", "quick"] as const;

/** The default realtime model (VOICE_MODEL overrides it). */
export const DEFAULT_VOICE_MODEL = "google/gemini-3.8-live";

/**
 * Classic: the only model a Classic call runs on. OpenAI realtime models did not exist on this platform on 20 Nov
 * 2026, so a version set to another model is called on this one (the test lab says so).
 */
export const CLASSIC_VOICE_MODEL = DEFAULT_VOICE_MODEL;

/** Classic: the model a Classic call uses for a version whose model is `modelId` (Gemini as it is, else Gemini). */
export function classicModelId(modelId: string | null | undefined): string {
  return modelId && /^google\/|gemini/i.test(modelId) ? modelId : CLASSIC_VOICE_MODEL;
}

/**
 * Gemini Live prebuilt voices. Taken from Google's published list for earlier
 * Live models; MUST be verified against gemini-3.8-live in the first live test
 * (an unknown voice name may be rejected at session start).
 */
export const GEMINI_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"] as const;
/** OpenAI realtime voices (for gpt-realtime models). */
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const;

export type VoiceCapabilities = {
  voices: string[];
  /** The speaking pace can be set (through the instructions: no provider takes a numeric rate). */
  pace: boolean;
  /** Turn-taking style (patient / balanced / quick) changes the provider's turn detection. */
  style: boolean;
  /** Silence before the model answers can be tuned in ms. */
  pauseMs: boolean;
  /** How easily the buyer can interrupt can be tuned. */
  interruptSensitivity: boolean;
  /** Short spoken fillers before a tool (instructions only). */
  fillers: boolean;
};

/**
 * What a realtime model lets a seller change, so the UI shows only those.
 * Gemini 3.8 Live has server voice activity detection always on, with no
 * tuning through the normalized session config: style and pause are not offered.
 */
export function voiceCapabilities(modelId: string): VoiceCapabilities {
  if (/^google\/|gemini/i.test(modelId)) {
    return { voices: [...GEMINI_VOICES], pace: true, style: false, pauseMs: false, interruptSensitivity: false, fillers: true };
  }
  if (/^openai\/|gpt-realtime/i.test(modelId)) {
    return { voices: [...OPENAI_VOICES], pace: true, style: true, pauseMs: true, interruptSensitivity: true, fillers: true };
  }
  // The scripted model and unknown models: nothing provider-specific.
  return { voices: [], pace: true, style: false, pauseMs: false, interruptSensitivity: false, fillers: true };
}

// Classic: today's VoiceSettings has later keys (model, pauseMs, interrupt) the 20 Nov resolution does not read.
export type ResolvedVoiceSettings = Required<Omit<VoiceSettings, "voice" | "model" | "pauseMs" | "interrupt">> & { voice: string | null };

export const DEFAULT_VOICE_SETTINGS: ResolvedVoiceSettings = {
  voice: null, pace: "normal", style: "balanced", fillers: true, maxCallSec: DEFAULT_MAX_CALL_SEC,
};

/** A version's stored settings with the defaults filled in (anything invalid falls back to the default). */
export function resolveVoiceSettings(s: VoiceSettings | null | undefined): ResolvedVoiceSettings {
  const pace = s?.pace && (VOICE_PACES as readonly string[]).includes(s.pace) ? s.pace : DEFAULT_VOICE_SETTINGS.pace;
  const style = s?.style && (VOICE_STYLES as readonly string[]).includes(s.style) ? s.style : DEFAULT_VOICE_SETTINGS.style;
  const max = typeof s?.maxCallSec === "number" && Number.isFinite(s.maxCallSec)
    ? Math.min(PLATFORM_MAX_CALL_SEC, Math.max(MIN_CALL_SEC, Math.round(s.maxCallSec)))
    : DEFAULT_MAX_CALL_SEC;
  return {
    voice: typeof s?.voice === "string" && s.voice.trim() ? s.voice.trim().slice(0, 40) : null,
    pace, style, fillers: typeof s?.fillers === "boolean" ? s.fillers : DEFAULT_VOICE_SETTINGS.fillers, maxCallSec: max,
  };
}

/**
 * Turn-taking values for a style, for providers that take them (OpenAI server
 * VAD). Gemini: none (its VAD is not tunable through the normalized config).
 */
export function turnTakingFor(style: ResolvedVoiceSettings["style"], modelId: string): { silenceMs: number; threshold: number; prefixPaddingMs: number } | null {
  if (!voiceCapabilities(modelId).style) return null;
  if (style === "patient") return { silenceMs: 900, threshold: 0.6, prefixPaddingMs: 300 };
  if (style === "quick") return { silenceMs: 350, threshold: 0.45, prefixPaddingMs: 300 };
  return { silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 };
}

/** The instruction line for a pace (every provider: there is no numeric speaking rate). */
export function paceInstruction(pace: ResolvedVoiceSettings["pace"]): string {
  if (pace === "slower") return "- Speak a little slower than usual, with clear pauses between sentences.";
  if (pace === "faster") return "- Speak at a brisk pace, without rushing the numbers.";
  return "";
}

/**
 * The longest call allowed now: the platform maximum, the version's setting,
 * VOICE_MAX_CALL_SECONDS and the transport's hard deadline (seconds left in
 * the function), whichever is smallest.
 */
export function maxCallSeconds(o: { settings?: VoiceSettings | null; deadlineSec?: number | null; env?: Record<string, string | undefined> }): number {
  const env = o.env ?? process.env;
  const fromEnv = Number(env.VOICE_MAX_CALL_SECONDS);
  const limits = [
    PLATFORM_MAX_CALL_SEC,
    resolveVoiceSettings(o.settings).maxCallSec,
    Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : PLATFORM_MAX_CALL_SEC,
    typeof o.deadlineSec === "number" && Number.isFinite(o.deadlineSec) && o.deadlineSec > 0 ? Math.floor(o.deadlineSec) : PLATFORM_MAX_CALL_SEC,
  ];
  return Math.max(1, Math.min(...limits));
}

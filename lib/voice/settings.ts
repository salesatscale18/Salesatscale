/**
 * Voice call settings and modes (live voice). Pure and import-safe from
 * server code and client code alike (no server imports): the call screen and
 * the settings UI read the same defaults, capabilities and validation.
 */
import type { VoiceSettings } from "@/db/schema";

export type { VoiceSettings };

/** The platform's longest call. A version's setting can only lower it. */
export const PLATFORM_MAX_CALL_SEC = 600;
/** The shortest maximum a seller may set. */
export const MIN_CALL_SEC = 60;

export const VOICE_PACES = ["slower", "normal", "faster"] as const;
export const VOICE_STYLES = ["patient", "balanced", "quick"] as const;

/** The default realtime model (VOICE_MODEL overrides it). */
export const DEFAULT_VOICE_MODEL = "google/gemini-3.8-live";

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

export type ResolvedVoiceSettings = Required<Omit<VoiceSettings, "voice">> & { voice: string | null };

export const DEFAULT_VOICE_SETTINGS: ResolvedVoiceSettings = {
  voice: null, pace: "normal", style: "balanced", fillers: true, maxCallSec: PLATFORM_MAX_CALL_SEC,
};

/** A version's stored settings with the defaults filled in (anything invalid falls back to the default). */
export function resolveVoiceSettings(s: VoiceSettings | null | undefined): ResolvedVoiceSettings {
  const pace = s?.pace && (VOICE_PACES as readonly string[]).includes(s.pace) ? s.pace : DEFAULT_VOICE_SETTINGS.pace;
  const style = s?.style && (VOICE_STYLES as readonly string[]).includes(s.style) ? s.style : DEFAULT_VOICE_SETTINGS.style;
  const max = typeof s?.maxCallSec === "number" && Number.isFinite(s.maxCallSec)
    ? Math.min(PLATFORM_MAX_CALL_SEC, Math.max(MIN_CALL_SEC, Math.round(s.maxCallSec)))
    : PLATFORM_MAX_CALL_SEC;
  return {
    voice: typeof s?.voice === "string" && s.voice.trim() ? s.voice.trim().slice(0, 40) : null,
    pace, style, fillers: typeof s?.fillers === "boolean" ? s.fillers : DEFAULT_VOICE_SETTINGS.fillers, maxCallSec: max,
  };
}

export type VoiceSettingsErrors = Partial<Record<keyof VoiceSettings, string>>;

/**
 * Validates settings a seller saves (untrusted form input) for a model.
 * Returns the clean settings or the errors per key.
 */
export function validateVoiceSettings(input: unknown, modelId: string = DEFAULT_VOICE_MODEL): { ok: true; value: VoiceSettings } | { ok: false; errors: VoiceSettingsErrors } {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const caps = voiceCapabilities(modelId);
  const errors: VoiceSettingsErrors = {};
  const value: VoiceSettings = {};
  if (o.voice !== undefined && o.voice !== null && o.voice !== "") {
    if (typeof o.voice !== "string" || (caps.voices.length > 0 && !caps.voices.includes(o.voice))) errors.voice = "Pick one of the voices offered.";
    else value.voice = o.voice;
  }
  if (o.pace !== undefined && o.pace !== null && o.pace !== "") {
    if (!(VOICE_PACES as readonly unknown[]).includes(o.pace)) errors.pace = "Pace is slower, normal or faster.";
    else value.pace = o.pace as VoiceSettings["pace"];
  }
  if (o.style !== undefined && o.style !== null && o.style !== "") {
    if (!(VOICE_STYLES as readonly unknown[]).includes(o.style)) errors.style = "Style is patient, balanced or quick.";
    else value.style = o.style as VoiceSettings["style"];
  }
  if (o.fillers !== undefined && o.fillers !== null) {
    if (typeof o.fillers !== "boolean") errors.fillers = "Fillers is on or off.";
    else value.fillers = o.fillers;
  }
  if (o.maxCallSec !== undefined && o.maxCallSec !== null && o.maxCallSec !== "") {
    const n = Number(o.maxCallSec);
    if (!Number.isInteger(n) || n < MIN_CALL_SEC || n > PLATFORM_MAX_CALL_SEC) errors.maxCallSec = `Between ${MIN_CALL_SEC} and ${PLATFORM_MAX_CALL_SEC} seconds.`;
    else value.maxCallSec = n;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
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

// ---------------------------------------------------------------------------
// Modes (env VOICE_REALTIME)
// ---------------------------------------------------------------------------

export type VoiceMode = "off" | "scripted" | "live";

/**
 * The voice mode: VOICE_REALTIME unset or "off" = no calls; "scripted" = the
 * free fake model (no cost); "live" = the paid realtime model, which also
 * needs AI_GATEWAY_API_KEY (without it: off). Spending in development needs the
 * owner's approval first (CLAUDE.md).
 */
export function voiceMode(env: Record<string, string | undefined> = process.env): VoiceMode {
  const v = env.VOICE_REALTIME?.trim().toLowerCase();
  if (v === "scripted") return "scripted";
  if (v === "live") return env.AI_GATEWAY_API_KEY?.trim() ? "live" : "off";
  return "off";
}

/** The realtime model id: VOICE_MODEL, else the default. */
export function voiceModelId(env: Record<string, string | undefined> = process.env): string {
  return env.VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL;
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

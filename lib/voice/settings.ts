/**
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
 * The realtime models a version may pick (Versions and test lab › Voice settings). `proven`: it has run a real
 * live call on this platform (a constant: Gemini since 20 Nov 2026, both GPT-Realtime models since the live
 * calls of 21-22 Nov 2026); a model added later starts unproven, and the picker and the logs say so. One list:
 * validation, the picker and the price hint read it.
 */
export const VOICE_MODELS = [
  { id: "google/gemini-3.8-live", label: "Gemini 3.8 Live", family: "gemini", proven: true, note: "Its own turn detection (not tunable); Gemini voices." },
  { id: "openai/gpt-realtime-2.1", label: "GPT-Realtime 2.1", family: "openai", proven: true, note: "Tunable turn-taking (style, pause, interruptions); OpenAI voices." },
  { id: "openai/gpt-realtime-mini", label: "GPT-Realtime mini", family: "openai", proven: true, note: "The smaller OpenAI model: cheaper, tunable turn-taking; OpenAI voices." },
] as const satisfies readonly { id: string; label: string; family: "gemini" | "openai"; proven: boolean; note: string }[];

export type VoiceModelId = (typeof VOICE_MODELS)[number]["id"];
export type VoiceModelInfo = (typeof VOICE_MODELS)[number];

/** True for a model a version may pick. */
export function isVoiceModel(id: unknown): id is VoiceModelId {
  return typeof id === "string" && VOICE_MODELS.some((m) => m.id === id);
}

/** A model's entry in VOICE_MODELS, or null (the scripted model, an env override not in the list). */
export function voiceModelInfo(id: string | null | undefined): VoiceModelInfo | null {
  return VOICE_MODELS.find((m) => m.id === id) ?? null;
}

/** A model's label for people ("Gemini 3.8 Live"); the id itself when it is not in the list ("scripted"). */
export function voiceModelLabel(id: string | null | undefined): string {
  return voiceModelInfo(id)?.label ?? (id || "");
}

/** True when the model has run a real live call (a constant for now: VOICE_MODELS `proven`). */
export function isProvenVoiceModel(id: string): boolean {
  return voiceModelInfo(id)?.proven === true;
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

/**
 * The version's voice, else the model family's default (the one the picker shows as "(default)": Puck for
 * Gemini, alloy for OpenAI). Null for the scripted model (it has no voices). The engine sends the default only to
 * OpenAI; Gemini with no choice gets no voice field (owner, 22 Nov), see VoiceEngine.voiceInEffect.
 */
export function callVoice(chosen: string | null | undefined, modelId: string): string | null {
  if (typeof chosen === "string" && chosen.trim()) return chosen.trim();
  const voices = voiceCapabilities(modelId).voices;
  if (voices.includes("Puck")) return "Puck";
  if (voices.includes("alloy")) return "alloy";
  return null;
}

/**
 * The voice a call sends the model: the version's choice, else the family default for OpenAI; Gemini with no choice
 * gets no voice field (null: the model's own default). As VoiceEngine.voiceInEffect on a first connection.
 */
export function sentCallVoice(chosen: string | null | undefined, modelId: string): string | null {
  if (typeof chosen === "string" && chosen.trim()) return chosen.trim();
  if (/^google\/|gemini/i.test(modelId)) return null;
  return callVoice(null, modelId);
}

/** The session snapshot's word for "no voice sent: the model's own default" (voice_sessions.settings.voice). */
export const MODEL_DEFAULT_VOICE = "model default";

/**
 * The voice and fillers a call ran with, from its session snapshot (voice_sessions.settings, written at go-live):
 * `voice` the preset name, "default" (none sent), or null when the call did not record it (older calls); `fillers`
 * on/off, or null when not recorded.
 */
export type CallVoiceInfo = { voice: string | "default" | null; fillers: boolean | null };

export function callVoiceInfo(settings: unknown): CallVoiceInfo {
  const s = settings && typeof settings === "object" ? (settings as { voice?: unknown; fillers?: unknown }) : {};
  const voice = typeof s.voice === "string" && s.voice.trim() ? (s.voice.trim() === MODEL_DEFAULT_VOICE ? "default" : s.voice.trim().slice(0, 40)) : null;
  return { voice, fillers: typeof s.fillers === "boolean" ? s.fillers : null };
}

/** `model` null: the platform default (VOICE_MODEL, else Gemini). `pauseMs` / `interrupt` null: the style's values. */
export type ResolvedVoiceSettings = Required<Omit<VoiceSettings, "voice" | "model" | "pauseMs" | "interrupt">> & {
  voice: string | null; model: VoiceModelId | null; pauseMs: number | null; interrupt: NonNullable<VoiceSettings["interrupt"]> | null;
};

export const DEFAULT_VOICE_SETTINGS: ResolvedVoiceSettings = {
  voice: null, pace: "normal", style: "balanced", fillers: true, maxCallSec: DEFAULT_MAX_CALL_SEC, model: null, pauseMs: null, interrupt: null,
};

/** The silence before answering a seller may set, in ms (models with tunable turn detection). */
export const PAUSE_MS_RANGE = { min: 200, max: 1500, step: 100 } as const;
export const INTERRUPT_LEVELS = ["low", "medium", "high"] as const;
/** The turn-detection threshold for each interruption level: a higher threshold needs louder speech to cut in. */
const INTERRUPT_THRESHOLD: Record<(typeof INTERRUPT_LEVELS)[number], number> = { low: 0.7, medium: 0.5, high: 0.35 };

/** The model a version's calls use: its own choice when it is one of VOICE_MODELS, else the platform default. */
export function versionModelId(s: VoiceSettings | null | undefined, env: Record<string, string | undefined> = process.env): string {
  return isVoiceModel(s?.model) ? s.model : voiceModelId(env);
}

/** A version's stored settings with the defaults filled in (anything invalid falls back to the default). */
export function resolveVoiceSettings(s: VoiceSettings | null | undefined): ResolvedVoiceSettings {
  const pace = s?.pace && (VOICE_PACES as readonly string[]).includes(s.pace) ? s.pace : DEFAULT_VOICE_SETTINGS.pace;
  const style = s?.style && (VOICE_STYLES as readonly string[]).includes(s.style) ? s.style : DEFAULT_VOICE_SETTINGS.style;
  const max = typeof s?.maxCallSec === "number" && Number.isFinite(s.maxCallSec)
    ? Math.min(PLATFORM_MAX_CALL_SEC, Math.max(MIN_CALL_SEC, Math.round(s.maxCallSec)))
    : DEFAULT_MAX_CALL_SEC;
  const pause = typeof s?.pauseMs === "number" && Number.isFinite(s.pauseMs)
    ? Math.min(PAUSE_MS_RANGE.max, Math.max(PAUSE_MS_RANGE.min, Math.round(s.pauseMs / 100) * 100)) : null;
  return {
    voice: typeof s?.voice === "string" && s.voice.trim() ? s.voice.trim().slice(0, 40) : null,
    pace, style, fillers: typeof s?.fillers === "boolean" ? s.fillers : DEFAULT_VOICE_SETTINGS.fillers, maxCallSec: max,
    model: isVoiceModel(s?.model) ? s.model : null,
    pauseMs: pause,
    interrupt: s?.interrupt && (INTERRUPT_LEVELS as readonly string[]).includes(s.interrupt) ? s.interrupt : null,
  };
}

export type VoiceSettingsErrors = Partial<Record<keyof VoiceSettings, string>>;

/**
 * Validates settings a seller saves (untrusted form input). `modelId`: the model the version uses now; an input
 * `model` (one of VOICE_MODELS) switches it, and the rest is checked against the new model. A voice the new
 * model does not have is dropped when the model changes (the call then uses that model's default voice), and is
 * an error otherwise. Turn-taking values are kept only for a model that takes them.
 * Returns the clean settings or the errors per key.
 */
export function validateVoiceSettings(input: unknown, modelId: string = DEFAULT_VOICE_MODEL): { ok: true; value: VoiceSettings } | { ok: false; errors: VoiceSettingsErrors } {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const errors: VoiceSettingsErrors = {};
  const value: VoiceSettings = {};
  let target = modelId;
  if (o.model !== undefined && o.model !== null && o.model !== "") {
    if (!isVoiceModel(o.model)) errors.model = "Pick one of the models offered.";
    else {
      value.model = o.model;
      target = o.model;
    }
  }
  const switched = target !== modelId;
  const caps = voiceCapabilities(target);
  if (o.voice !== undefined && o.voice !== null && o.voice !== "") {
    if (typeof o.voice !== "string" || (caps.voices.length > 0 && !caps.voices.includes(o.voice))) {
      if (!switched) errors.voice = "Pick one of the voices offered.";
    } else value.voice = o.voice;
  }
  if (caps.pauseMs && o.pauseMs !== undefined && o.pauseMs !== null && o.pauseMs !== "") {
    const n = Number(o.pauseMs);
    if (!Number.isInteger(n) || n < PAUSE_MS_RANGE.min || n > PAUSE_MS_RANGE.max) errors.pauseMs = `Between ${PAUSE_MS_RANGE.min} and ${PAUSE_MS_RANGE.max} ms.`;
    else value.pauseMs = Math.round(n / 100) * 100;
  }
  if (caps.interruptSensitivity && o.interrupt !== undefined && o.interrupt !== null && o.interrupt !== "") {
    if (!(INTERRUPT_LEVELS as readonly unknown[]).includes(o.interrupt)) errors.interrupt = "Interruptions are low, medium or high.";
    else value.interrupt = o.interrupt as VoiceSettings["interrupt"];
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
 * VAD: silence before the turn ends, activation threshold, prefix padding).
 * The version's own pause and interruption level, when set, replace the style's.
 * Gemini: none (its VAD is not tunable through the normalized config).
 */
export function turnTakingFor(
  style: ResolvedVoiceSettings["style"], modelId: string, own: { pauseMs?: number | null; interrupt?: ResolvedVoiceSettings["interrupt"] } = {},
): { silenceMs: number; threshold: number; prefixPaddingMs: number } | null {
  if (!voiceCapabilities(modelId).style) return null;
  const base = style === "patient" ? { silenceMs: 900, threshold: 0.6, prefixPaddingMs: 300 }
    : style === "quick" ? { silenceMs: 350, threshold: 0.45, prefixPaddingMs: 300 }
    : { silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 };
  return {
    ...base,
    ...(typeof own.pauseMs === "number" ? { silenceMs: own.pauseMs } : {}),
    ...(own.interrupt ? { threshold: INTERRUPT_THRESHOLD[own.interrupt] } : {}),
  };
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

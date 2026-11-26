/**
 * Voice call settings and modes (live voice). Pure and import-safe from
 * server code and client code alike (no server imports): the call screen and
 * the settings UI read the same defaults, capabilities and validation.
 */
import type { VoiceSettings as StoredVoiceSettings } from "@/db/schema";
import { CALL_RULES } from "./call-rules";
import {
  DEFAULT_ELEVEN_MODEL, DEFAULT_ELEVEN_STABILITY, DEFAULT_ELEVEN_VOICE, isElevenModel, isElevenStability, isElevenVoice,
  type ElevenModelId, type ElevenStability, type ElevenVoiceId,
} from "@/lib/voice-rt-eleven/catalog";

/**
 * A version's voice settings (agent_versions.voice_settings JSON) with `speech` ("Voice from", see VOICE_SPEECH).
 * `speech` lives in the JSON only (no column, no migration); it is not in db/schema.ts's VoiceSettings because the
 * frozen Classic engine's settings type is derived from that one (every key there is required in its resolution).
 */
export type VoiceSettings = StoredVoiceSettings & {
  speech?: "model" | "elevenlabs";
  /**
   * With "Voice from: ElevenLabs" (platform admins only, as `speech`; JSON only, no migration): the speaking model, the
   * voice id and the steadiness (stability, sent to dialogue-mode models only). Catalog: lib/voice-rt-eleven/catalog.ts.
   */
  elevenModel?: string;
  elevenVoice?: string;
  elevenStability?: number;
  /**
   * Voice settings › Conversation › More options (JSON only, no migration; test calls only for now, see the
   * *_FOR_BUYER_CALLS constants below). A missing key is the default: `turnEnd` "pause" (fixed pause, server VAD),
   * `thinking` "default" (nothing sent), `openerProtected` true. Only non-default values are stored.
   */
  turnEnd?: "pause" | "smart";
  thinking?: Exclude<ThinkingLevel, "default">;
  openerProtected?: boolean;
};

/** The valid ElevenLabs fields of a version's settings JSON (anything not in the catalog is left out). */
export function storedEleven(s: StoredVoiceSettings | null | undefined): Pick<VoiceSettings, "elevenModel" | "elevenVoice" | "elevenStability"> {
  const v = (s ?? {}) as VoiceSettings;
  return {
    ...(isElevenModel(v.elevenModel) ? { elevenModel: v.elevenModel } : {}),
    ...(isElevenVoice(v.elevenVoice) ? { elevenVoice: v.elevenVoice } : {}),
    ...(isElevenStability(v.elevenStability) ? { elevenStability: v.elevenStability } : {}),
  };
}

/** The stored "Voice from" of a version's settings JSON (unvalidated: resolveVoiceSettings checks it). */
export function storedSpeech(s: StoredVoiceSettings | null | undefined): VoiceSettings["speech"] {
  const v = (s as VoiceSettings | null | undefined)?.speech;
  return v === "elevenlabs" || v === "model" ? v : undefined;
}

/** The platform's longest call. A version's setting can only lower it. */
export const PLATFORM_MAX_CALL_SEC: number = CALL_RULES.platformMaxCallSec;
/** A call's longest length unless the version sets another (standby counts too): lib/voice/call-rules.ts. */
export const DEFAULT_MAX_CALL_SEC: number = CALL_RULES.defaultMaxCallSec;
/** The shortest maximum a seller may set. */
export const MIN_CALL_SEC = 60;

export const VOICE_PACES = ["slower", "normal", "faster"] as const;
export const VOICE_STYLES = ["patient", "balanced", "quick"] as const;
/** "Turn ending" (GPT-Realtime): a fixed pause (server VAD, today's) or smart (OpenAI semantic VAD). */
export const TURN_ENDS = ["pause", "smart"] as const;
export type TurnEnd = (typeof TURN_ENDS)[number];
/** "Thinking effort" (GPT-Realtime 2.1, a reasoning realtime model): "default" sends nothing (the provider's own, low). */
export const THINKING_LEVELS = ["default", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/** The models "Thinking effort" is offered for (OpenAI's reasoning realtime models). */
export const THINKING_MODELS: readonly string[] = ["openai/gpt-realtime-2.1"];

/** The model list's hint line for both ElevenLabs Realtime models. */
const ELEVEN_REALTIME_NOTE = "ElevenLabs listens, decides and speaks as one system. Test calls only for now.";

/** The default realtime model (VOICE_MODEL overrides it). */
export const DEFAULT_VOICE_MODEL = "google/gemini-3.8-live";

/**
 * The realtime models a version may pick (Versions and test lab › Voice settings). `proven`: it has run a real
 * live call on this platform (a constant: Gemini since 20 Nov 2026, both GPT-Realtime models since the live
 * calls of 21-22 Nov 2026); a model added later starts unproven, and the picker and the logs say so. One list:
 * validation, the picker and the price hint read it.
 */
export const VOICE_MODELS = [
  { id: "google/gemini-3.8-live", label: "Gemini 3.8 Live", family: "gemini", proven: true, note: "Google's own turn-taking, tunable on test calls; Gemini voices." },
  { id: "openai/gpt-realtime-2.1", label: "GPT-Realtime 2.1", family: "openai", proven: true, note: "Tunable turn-taking (style, pause, interruptions); OpenAI voices." },
  { id: "openai/gpt-realtime-mini", label: "GPT-Realtime mini", family: "openai", proven: true, note: "The smaller OpenAI model: cheaper, tunable turn-taking; OpenAI voices." },
  // ElevenLabs end to end (speech to speech, no GPT in the middle), through the Gateway's OpenAI-compatible realtime
  // protocol. Not tried live yet; test calls only (ELEVEN_REALTIME_FOR_BUYER_CALLS below; lib/voice/eleven-realtime.ts).
  { id: "elevenlabs/eleven-realtime-v1-mini", label: "ElevenLabs Realtime mini (testing)", family: "elevenlabs", proven: false, note: ELEVEN_REALTIME_NOTE },
  { id: "elevenlabs/eleven-realtime-v1-max", label: "ElevenLabs Realtime max (testing)", family: "elevenlabs", proven: false, note: ELEVEN_REALTIME_NOTE },
] as const satisfies readonly { id: string; label: string; family: VoiceFamily; proven: boolean; note: string }[];

export type VoiceModelId = (typeof VOICE_MODELS)[number]["id"];

/**
 * A realtime model's family: how the engine talks to it. "elevenlabs" (ElevenLabs Realtime through the Gateway) is
 * OpenAI-COMPATIBLE: the same normalized session config, client events, tool schema and one response request per tool
 * batch as "openai"; it differs in what its first connect sends (no voice unless the version stores one for it, no turn
 * detection), in its retries (a last one without tools) and in its session-duration price (lib/voice/eleven-realtime.ts).
 */
export type VoiceFamily = "gemini" | "openai" | "elevenlabs";

/** Ids that are ElevenLabs Realtime (the Gateway's elevenlabs/eleven-realtime-*). */
export function isElevenRealtimeModel(id: string | null | undefined): boolean {
  return typeof id === "string" && /^elevenlabs\/eleven-realtime/i.test(id);
}

/** The family of a model id ("scripted" and unknown ids: "openai", as the tool schema has always treated them). */
export function voiceFamilyOf(id: string | null | undefined): VoiceFamily {
  if (isElevenRealtimeModel(id)) return "elevenlabs";
  return typeof id === "string" && /^google\/|gemini/i.test(id) ? "gemini" : "openai";
}

/**
 * ElevenLabs Realtime on BUYER calls. Off: a version set to it runs its buyer calls on the platform default model
 * (lib/voice/eleven-realtime.ts callModelFor, logged); test calls use it. Turn on once live test calls proved it.
 */
export const ELEVEN_REALTIME_FOR_BUYER_CALLS: boolean = false;

/**
 * Who speaks on a call (Voice settings › "Voice from"): "model" (default) the realtime model with its own voice;
 * "elevenlabs" the model answers in TEXT and ElevenLabs speaks (lib/voice-rt-eleven). ElevenLabs only with an OpenAI
 * (GPT-Realtime) model: Gemini Live has no text-output path here. The engine select (test lab) decides only the wiring.
 */
export const VOICE_SPEECH = ["model", "elevenlabs"] as const;
export type VoiceSpeech = (typeof VOICE_SPEECH)[number];

/** True for a GPT-Realtime model (the only ones "elevenlabs" speech works with). */
export function isOpenAiVoiceModel(id: string | null | undefined): boolean {
  return typeof id === "string" && /^openai\/|gpt-realtime/i.test(id);
}

/** The message a save gets for ElevenLabs with a model it does not work with. */
export const SPEECH_NEEDS_OPENAI = "ElevenLabs works with the GPT-Realtime models only. Pick GPT-Realtime 2.1 or mini, or the model's own voice.";
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
  /** "Turn ending": fixed pause or smart (OpenAI semantic VAD). GPT-Realtime only. */
  turnEnd: boolean;
  /** "Thinking effort" (reasoning effort). GPT-Realtime 2.1 only. */
  thinking: boolean;
  /** "Protect the opening line" (the engine's own, model-independent): every model. */
  openerProtect: boolean;
};

/**
 * What a realtime model lets a seller change, so the UI shows only those (one panel for every model: a control a
 * model does not have is not shown). Gemini 3.8 Live: style, pause and interruptions map to Google's own
 * automaticActivityDetection (test calls only for now: GEMINI_TURN_TAKING_FOR_BUYER_CALLS, geminiActivityDetectionFor).
 */
export function voiceCapabilities(modelId: string): VoiceCapabilities {
  if (/^google\/|gemini/i.test(modelId)) {
    return { voices: [...GEMINI_VOICES], pace: true, style: true, pauseMs: true, interruptSensitivity: true, fillers: true, turnEnd: false, thinking: false, openerProtect: true };
  }
  if (/^openai\/|gpt-realtime/i.test(modelId)) {
    return { voices: [...OPENAI_VOICES], pace: true, style: true, pauseMs: true, interruptSensitivity: true, fillers: true, turnEnd: true, thinking: THINKING_MODELS.includes(modelId), openerProtect: true };
  }
  // ElevenLabs Realtime: no voice list known (none is sent unless the version stores one for it) and no turn-detection
  // tuning sent (its own turn-taking, "tuned as one system"): only what the instructions carry, and the engine's own.
  if (isElevenRealtimeModel(modelId)) {
    return { voices: [], pace: true, style: false, pauseMs: false, interruptSensitivity: false, fillers: true, turnEnd: false, thinking: false, openerProtect: true };
  }
  // The scripted model and unknown models: nothing provider-specific.
  return { voices: [], pace: true, style: false, pauseMs: false, interruptSensitivity: false, fillers: true, turnEnd: false, thinking: false, openerProtect: true };
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
  // ElevenLabs Realtime: only a voice stored for it (never another family's preset left from an earlier model).
  if (isElevenRealtimeModel(modelId)) return elevenRealtimeVoice(chosen);
  if (typeof chosen === "string" && chosen.trim()) return chosen.trim();
  if (/^google\/|gemini/i.test(modelId)) return null;
  return callVoice(null, modelId);
}

/**
 * The voice an ElevenLabs Realtime call sends: the version's stored voice when it is one for this family, else none
 * (the provider's default; which voice names it accepts is unknown until a live call). A Gemini or OpenAI preset name
 * (left from the version's earlier model) is not one.
 */
export function elevenRealtimeVoice(chosen: string | null | undefined): string | null {
  const v = typeof chosen === "string" ? chosen.trim().slice(0, 40) : "";
  if (!v) return null;
  if ((GEMINI_VOICES as readonly string[]).includes(v) || (OPENAI_VOICES as readonly string[]).includes(v)) return null;
  return v;
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

/**
 * `model` null: the platform default (VOICE_MODEL, else Gemini). `pauseMs` / `interrupt` null: the style's values.
 * `speech`: "elevenlabs" only with a GPT-Realtime model (else "model").
 */
export type ResolvedVoiceSettings = Required<Omit<VoiceSettings, "voice" | "model" | "pauseMs" | "interrupt" | "speech" | "elevenModel" | "elevenVoice" | "elevenStability" | "turnEnd" | "thinking" | "openerProtected">> & {
  voice: string | null; model: VoiceModelId | null; pauseMs: number | null; interrupt: NonNullable<VoiceSettings["interrupt"]> | null;
  /** Always set by resolveVoiceSettings; optional in the type so the frozen Classic settings (lib/voice-classic) still build. */
  speech?: VoiceSpeech;
  /** ElevenLabs' speaking model, voice and steadiness (defaults: v4 Turbo, Rachel, 1). Optional for the same reason. */
  elevenModel?: ElevenModelId;
  elevenVoice?: ElevenVoiceId;
  elevenStability?: ElevenStability;
  /** "Turn ending", "Thinking effort", "Protect the opening line" (defaults "pause", "default", true). Optional for the same reason. */
  turnEnd?: TurnEnd;
  thinking?: ThinkingLevel;
  openerProtected?: boolean;
};

export const DEFAULT_VOICE_SETTINGS: ResolvedVoiceSettings = {
  voice: null, pace: "normal", style: "balanced", fillers: true, maxCallSec: DEFAULT_MAX_CALL_SEC, model: null, pauseMs: null, interrupt: null, speech: "model",
  elevenModel: DEFAULT_ELEVEN_MODEL, elevenVoice: DEFAULT_ELEVEN_VOICE, elevenStability: DEFAULT_ELEVEN_STABILITY,
  turnEnd: "pause", thinking: "default", openerProtected: true,
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

/**
 * A version's stored settings with the defaults filled in (anything invalid falls back to the default). `modelId`:
 * the model the version runs on when it stores none (the platform default; default Gemini): "elevenlabs" speech
 * with a model that is not GPT-Realtime falls back to "model".
 */
export function resolveVoiceSettings(s: VoiceSettings | null | undefined, modelId: string = DEFAULT_VOICE_MODEL): ResolvedVoiceSettings {
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
    speech: s?.speech === "elevenlabs" && isOpenAiVoiceModel(isVoiceModel(s?.model) ? s.model : modelId) ? "elevenlabs" : "model",
    elevenModel: isElevenModel(s?.elevenModel) ? s.elevenModel : DEFAULT_ELEVEN_MODEL,
    elevenVoice: isElevenVoice(s?.elevenVoice) ? s.elevenVoice : DEFAULT_ELEVEN_VOICE,
    elevenStability: isElevenStability(s?.elevenStability) ? s.elevenStability : DEFAULT_ELEVEN_STABILITY,
    turnEnd: s?.turnEnd === "smart" ? "smart" : "pause",
    thinking: s?.thinking && (THINKING_LEVELS as readonly string[]).includes(s.thinking) ? s.thinking : "default",
    // A version that never stored it: on (UX review, 25 Nov). Test calls only for now (OPENER_PROTECTION_FOR_BUYER_CALLS).
    openerProtected: s?.openerProtected !== false,
  };
}

export type VoiceSettingsErrors = Partial<Record<keyof VoiceSettings, string>>;

/**
 * Validates settings a seller saves (untrusted form input). `modelId`: the model the version uses now; an input
 * `model` (one of VOICE_MODELS) switches it, and the rest is checked against the new model. A voice the new
 * model does not have is dropped when the model changes (the call then uses that model's default voice), and is
 * an error otherwise. Turn-taking values are kept only for a model that takes them.
 * `speech` ("Voice from"): the same access rule as the model picker (platform admins). With `canPickSpeech` the
 * posted value is checked ("elevenlabs" with a model that is not GPT-Realtime is an error); without it the posted
 * value is ignored and `storedSpeech` (the version's) is kept, while the model still allows it.
 * `elevenModel` / `elevenVoice` / `elevenStability` (ElevenLabs' speaking model, voice, steadiness): the same access
 * rule. With `canPickSpeech` a posted value is checked (an id not in the catalog is an error) and a default value is
 * not stored (no key = the default); a field not posted keeps the version's (`storedEleven`). Without it the posted
 * values are ignored and the version's are kept.
 * Returns the clean settings or the errors per key.
 */
export function validateVoiceSettings(
  input: unknown, modelId: string = DEFAULT_VOICE_MODEL,
  opts: {
    canPickSpeech?: boolean; storedSpeech?: VoiceSettings["speech"]; storedEleven?: Pick<VoiceSettings, "elevenModel" | "elevenVoice" | "elevenStability">;
    /** The version's stored "Protect the opening line": kept when the input does not carry the field. */
    storedOpenerProtected?: boolean;
  } = {},
): { ok: true; value: VoiceSettings } | { ok: false; errors: VoiceSettingsErrors } {
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
  if (opts.canPickSpeech) {
    if (o.speech !== undefined && o.speech !== null && o.speech !== "") {
      if (!(VOICE_SPEECH as readonly unknown[]).includes(o.speech)) errors.speech = "Voice from is the model's own voice or ElevenLabs.";
      else if (o.speech === "elevenlabs" && !isOpenAiVoiceModel(target)) errors.speech = SPEECH_NEEDS_OPENAI;
      // Only ElevenLabs is stored: no key is the model's own voice (the default).
      else if (o.speech === "elevenlabs") value.speech = "elevenlabs";
    }
  } else if (opts.storedSpeech === "elevenlabs" && isOpenAiVoiceModel(target)) {
    // Not the caller's to change: the version's own value stays (a model it does not work with drops it).
    value.speech = "elevenlabs";
  }
  const kept = storedEleven(opts.storedEleven as StoredVoiceSettings | undefined);
  const posted = (x: unknown) => x !== undefined && x !== null && x !== "";
  if (opts.canPickSpeech && posted(o.elevenModel)) {
    if (!isElevenModel(o.elevenModel)) errors.elevenModel = "Pick one of the ElevenLabs models offered.";
    else if (o.elevenModel !== DEFAULT_ELEVEN_MODEL) value.elevenModel = o.elevenModel;
  } else if (kept.elevenModel) value.elevenModel = kept.elevenModel;
  if (opts.canPickSpeech && posted(o.elevenVoice)) {
    if (!isElevenVoice(o.elevenVoice)) errors.elevenVoice = "Pick one of the ElevenLabs voices offered.";
    else if (o.elevenVoice !== DEFAULT_ELEVEN_VOICE) value.elevenVoice = o.elevenVoice;
  } else if (kept.elevenVoice) value.elevenVoice = kept.elevenVoice;
  if (opts.canPickSpeech && posted(o.elevenStability)) {
    const raw = o.elevenStability;
    const n = typeof raw === "number" ? raw : typeof raw === "string" && ["0", "0.5", "1"].includes(raw.trim()) ? Number(raw) : NaN;
    if (!isElevenStability(n)) errors.elevenStability = "Steadiness is Expressive, Natural or Steady.";
    else if (n !== DEFAULT_ELEVEN_STABILITY) value.elevenStability = n;
  } else if (kept.elevenStability !== undefined) value.elevenStability = kept.elevenStability;
  // "Turn ending", "Thinking effort": kept only for a model that has them (a model switch drops them); defaults not stored.
  if (caps.turnEnd && posted(o.turnEnd)) {
    if (!(TURN_ENDS as readonly unknown[]).includes(o.turnEnd)) errors.turnEnd = "Turn ending is a fixed pause or smart.";
    else if (o.turnEnd === "smart") value.turnEnd = "smart";
  }
  if (caps.thinking && posted(o.thinking)) {
    if (!(THINKING_LEVELS as readonly unknown[]).includes(o.thinking)) errors.thinking = "Thinking effort is default, minimal, low, medium or high.";
    else if (o.thinking !== "default") value.thinking = o.thinking as VoiceSettings["thinking"];
  }
  // "Protect the opening line" (every model): only "off" is stored (no key = on). Not in the input: the version's kept.
  if (o.openerProtected !== undefined && o.openerProtected !== null) {
    if (typeof o.openerProtected !== "boolean") errors.openerProtected = "Protect the opening line is on or off.";
    else if (!o.openerProtected) value.openerProtected = false;
  } else if (opts.storedOpenerProtected === false) value.openerProtected = false;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/**
 * Turn-taking values for a style, for providers that take them (OpenAI server
 * VAD: silence before the turn ends, activation threshold, prefix padding).
 * The version's own pause and interruption level, when set, replace the style's.
 * Gemini: none here (its normalized turn detection is ignored by the SDK; its own block: geminiActivityDetectionFor).
 */
export function turnTakingFor(
  style: ResolvedVoiceSettings["style"], modelId: string, own: { pauseMs?: number | null; interrupt?: ResolvedVoiceSettings["interrupt"] } = {},
): { silenceMs: number; threshold: number; prefixPaddingMs: number } | null {
  if (!voiceCapabilities(modelId).style || voiceFamilyOf(modelId) !== "openai") return null;
  return {
    ...styleTurnTaking(style),
    ...(typeof own.pauseMs === "number" ? { silenceMs: own.pauseMs } : {}),
    ...(own.interrupt ? { threshold: INTERRUPT_THRESHOLD[own.interrupt] } : {}),
  };
}

/** A conversation style's turn-taking preset (the pause before answering, threshold, prefix padding), for every model. */
export function styleTurnTaking(style: ResolvedVoiceSettings["style"]): { silenceMs: number; threshold: number; prefixPaddingMs: number } {
  return style === "patient" ? { silenceMs: 900, threshold: 0.6, prefixPaddingMs: 300 }
    : style === "quick" ? { silenceMs: 350, threshold: 0.45, prefixPaddingMs: 300 }
    : { silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 };
}

// ---------------------------------------------------------------------------
// New turn-taking and call controls (test calls only for now). Each has ONE constant for buyer calls; a buyer call
// sends exactly what it sent before while the constant is false.
// ---------------------------------------------------------------------------

/** Gemini's own turn-taking block (style, pause, interruptions) on BUYER calls. Off: test calls only. */
export const GEMINI_TURN_TAKING_FOR_BUYER_CALLS: boolean = false;
/** "Turn ending: Smart" (OpenAI semantic VAD with eagerness) on BUYER calls. Off: test calls only. */
export const SMART_TURN_END_FOR_BUYER_CALLS: boolean = false;
/** "Thinking effort" (OpenAI reasoning.effort) on BUYER calls. Off: test calls only. */
export const THINKING_EFFORT_FOR_BUYER_CALLS: boolean = false;
/** "Protect the opening line" (the engine holds the buyer's mic audio during the opener) on BUYER calls. Off: test calls only. */
export const OPENER_PROTECTION_FOR_BUYER_CALLS: boolean = false;

/**
 * Google's automaticActivityDetection (Gemini Live `realtimeInputConfig.automaticActivityDetection`, sent raw through
 * providerOptions: @ai-sdk/google 4.0.122 buildGoogleSessionConfig copies every providerOptions key but `google` into
 * the setup as is).
 */
export type GeminiActivityDetection = {
  startOfSpeechSensitivity?: "START_SENSITIVITY_LOW" | "START_SENSITIVITY_HIGH";
  endOfSpeechSensitivity?: "END_SENSITIVITY_LOW" | "END_SENSITIVITY_HIGH";
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
};

/**
 * A version's style, pause and interruption level as Gemini's activity detection. Interruptions: low → start
 * sensitivity LOW + prefix 300 ms; medium → no start sensitivity (Google's default); high → HIGH + prefix 40 ms. The
 * pause (or the style's preset, the same table as GPT) → silenceDurationMs. Style: patient → end sensitivity LOW,
 * quick → HIGH, balanced → none. The default style with no pause and no interruption level: null (nothing is sent:
 * the behaviour before 25 Nov).
 */
export function geminiActivityDetectionFor(s: Pick<ResolvedVoiceSettings, "style" | "pauseMs" | "interrupt">): GeminiActivityDetection | null {
  if (s.style === "balanced" && s.pauseMs === null && s.interrupt === null) return null;
  return {
    ...(s.interrupt === "low" ? { startOfSpeechSensitivity: "START_SENSITIVITY_LOW" as const } : s.interrupt === "high" ? { startOfSpeechSensitivity: "START_SENSITIVITY_HIGH" as const } : {}),
    ...(s.style === "patient" ? { endOfSpeechSensitivity: "END_SENSITIVITY_LOW" as const } : s.style === "quick" ? { endOfSpeechSensitivity: "END_SENSITIVITY_HIGH" as const } : {}),
    ...(s.interrupt === "low" ? { prefixPaddingMs: 300 } : s.interrupt === "high" ? { prefixPaddingMs: 40 } : {}),
    silenceDurationMs: s.pauseMs ?? styleTurnTaking(s.style).silenceMs,
  };
}

/** "Smart" turn ending's eagerness (OpenAI semantic VAD) from the conversation style. */
export const SMART_EAGERNESS: Record<ResolvedVoiceSettings["style"], "low" | "medium" | "high"> = { patient: "low", balanced: "medium", quick: "high" };

/** What a call's session adds for the new controls (RealtimeSessionConfig fields); nothing when none applies. */
export type CallTurnExtras = {
  geminiActivity?: GeminiActivityDetection;
  semanticVad?: { eagerness: "low" | "medium" | "high" };
  reasoningEffort?: Exclude<ThinkingLevel, "default">;
};

/**
 * The new controls a call on `modelId` (the model it really runs on) sends: test calls only unless the feature's
 * *_FOR_BUYER_CALLS constant is on (`forBuyers` overrides them in tests). Default settings: nothing on any model.
 */
export function callTurnExtras(
  s: ResolvedVoiceSettings, modelId: string, isTest: boolean,
  forBuyers: { gemini?: boolean; smart?: boolean; thinking?: boolean } = {},
): CallTurnExtras {
  const on = (buyers: boolean) => isTest || buyers;
  const caps = voiceCapabilities(modelId);
  const family = voiceFamilyOf(modelId);
  const out: CallTurnExtras = {};
  if (family === "gemini" && caps.style && on(forBuyers.gemini ?? GEMINI_TURN_TAKING_FOR_BUYER_CALLS)) {
    const g = geminiActivityDetectionFor(s);
    if (g) out.geminiActivity = g;
  }
  if (caps.turnEnd && s.turnEnd === "smart" && on(forBuyers.smart ?? SMART_TURN_END_FOR_BUYER_CALLS)) out.semanticVad = { eagerness: SMART_EAGERNESS[s.style] };
  if (caps.thinking && s.thinking && s.thinking !== "default" && on(forBuyers.thinking ?? THINKING_EFFORT_FOR_BUYER_CALLS)) out.reasoningEffort = s.thinking;
  return out;
}

/** Whether the engine protects the opening line on this call ("Protect the opening line", test calls only for now). */
export function openerProtectionFor(s: Pick<ResolvedVoiceSettings, "openerProtected">, isTest: boolean, forBuyers: boolean = OPENER_PROTECTION_FOR_BUYER_CALLS): boolean {
  return s.openerProtected !== false && (isTest || forBuyers);
}

/** The longest the opening line is protected (from the call's start), whatever the opener's audio does. */
export const OPENER_PROTECT_CAP_MS = 20_000;

/**
 * The new fields of the panel's form (FormData): what the save action adds to its input. "Protect the opening line"
 * is a checkbox with a marker field (`openerProtectedShown`), so an unchecked box posts "off" and a form without it
 * keeps the version's value.
 */
export function voiceFormExtras(form: { get(name: string): unknown }): { turnEnd?: string; thinking?: string; openerProtected?: boolean } {
  const str = (k: string) => { const v = form.get(k); return typeof v === "string" && v ? v : undefined; };
  return {
    ...(str("turnEnd") ? { turnEnd: str("turnEnd") } : {}),
    ...(str("thinking") ? { thinking: str("thinking") } : {}),
    ...(str("openerProtectedShown") ? { openerProtected: form.get("openerProtected") === "on" } : {}),
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

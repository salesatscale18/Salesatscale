/**
 * Shared, import-safe helpers for the call screens and the voice settings
 * panel (live voice): who may see voice in the test lab, the voice picker's
 * plain labels and the time texts. No server imports: client components use
 * them too, and constants live here, never in a "use client" file.
 */
import {
  DEFAULT_VOICE_SETTINGS, GEMINI_TURN_TAKING_FOR_BUYER_CALLS, isOpenAiVoiceModel, MIN_CALL_SEC, OPENER_PROTECTION_FOR_BUYER_CALLS, PLATFORM_MAX_CALL_SEC, SMART_TURN_END_FOR_BUYER_CALLS,
  THINKING_EFFORT_FOR_BUYER_CALLS, voiceCapabilities, voiceFamilyOf, voiceMode, voiceModelLabel, type ResolvedVoiceSettings, type VoiceCapabilities,
} from "./settings";
import { PIPELINE_VOICE_NAME } from "@/lib/voice-pipeline/models";
import { DEFAULT_ELEVEN_MODEL, DEFAULT_ELEVEN_STABILITY, DEFAULT_ELEVEN_VOICE, elevenChoiceText } from "@/lib/voice-rt-eleven/catalog";

export type VoiceLabAccess = "ok" | "not_admin" | "voice_off";

/**
 * Release 1: test-lab calls are for platform admins only (role super_admin,
 * also when acting as an account), and only while VOICE_REALTIME is not off.
 * Checked on the server (page and actions); hiding the UI is not the control.
 */
export function voiceLabAccess(user: { role: string } | null | undefined, env: Record<string, string | undefined> = process.env): VoiceLabAccess {
  if (!user || user.role !== "super_admin") return "not_admin";
  if (voiceMode(env) === "off") return "voice_off";
  return "ok";
}

/**
 * "Name · two or three plain words" for the voices we know. The words follow
 * the providers' own short descriptions; Gemini's MUST be checked against
 * the live model in the first paid test.
 */
export const VOICE_WORDS: Record<string, string> = {
  Puck: "upbeat, lively",
  Charon: "calm, informative",
  Kore: "firm, clear",
  Fenrir: "energetic, excitable",
  Aoede: "breezy, relaxed",
  Leda: "youthful, light",
  Orus: "firm, steady",
  Zephyr: "bright, warm",
  alloy: "neutral, balanced",
  ash: "clear, direct",
  ballad: "soft, melodic",
  coral: "warm, friendly",
  echo: "calm, even",
  sage: "calm, thoughtful",
  shimmer: "bright, clear",
  verse: "expressive, lively",
  marin: "natural, warm",
  cedar: "natural, steady",
};

/** The voice a model uses when none is set (no voice sent). Gemini Live: Puck; OpenAI realtime: alloy. */
export function defaultVoiceOf(caps: VoiceCapabilities): string | null {
  // The same default the call sends (lib/voice/settings.ts callVoice).
  if (caps.voices.includes("Puck")) return "Puck";
  if (caps.voices.includes("alloy")) return "alloy";
  return null;
}

export const MAX_VOICE_OPTIONS = 8;

export type VoiceOption = { value: string; label: string; isDefault: boolean };

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One voice as the picker shows it: "Puck · upbeat, lively". */
export function voiceLabel(name: string): string {
  const words = VOICE_WORDS[name];
  return words ? `${titleCase(name)} · ${words}` : titleCase(name);
}

/**
 * The picker's options (at most MAX_VOICE_OPTIONS): the model's default voice
 * first as the empty value (no voice stored), marked "(default)", then the others.
 */
/**
 * A model change and the chosen voice: when the new model does not have it, the voice it changes to (that
 * model's default, what the call then sends) and the one it replaces, as names ("Alloy", "Kore"); null when the
 * voice carries over or none was chosen. The same rule as saving (validateVoiceSettings drops it, callVoice
 * pins the default).
 */
export function voiceChangeOnModel(chosen: string | null, next: VoiceCapabilities): { from: string; to: string } | null {
  if (!chosen || next.voices.includes(chosen)) return null;
  const to = defaultVoiceOf(next);
  return to ? { from: titleCase(chosen), to: titleCase(to) } : null;
}

export function voiceOptions(caps: VoiceCapabilities): VoiceOption[] {
  const def = defaultVoiceOf(caps);
  const rest = caps.voices.filter((v) => v !== def);
  const out: VoiceOption[] = def ? [{ value: "", label: voiceLabel(def), isDefault: true }] : [];
  for (const v of rest) out.push({ value: v, label: voiceLabel(v), isDefault: false });
  return out.slice(0, MAX_VOICE_OPTIONS);
}

// ---------------------------------------------------------------------------
// The Voice settings panel's rows (one panel for every model; owner, 25 Nov 2026)
// ---------------------------------------------------------------------------

/** The panel's optional rows: the ones a model may not have, or that sit in a "More options" fold. */
export type PanelRow = "stability" | "fillers" | "style" | "pause" | "interrupt" | "turnEnd" | "thinking" | "opener";
/** VOICE › More options, in order. */
export const VOICE_FOLD: readonly PanelRow[] = ["stability", "fillers"];
/** CONVERSATION's optional rows in order (style is outside its fold, the rest inside). */
export const CONVERSATION_ROWS: readonly PanelRow[] = ["style", "turnEnd", "pause", "interrupt", "thinking", "opener"];
/** CONVERSATION › More options, in order. */
export const CONVERSATION_FOLD: readonly PanelRow[] = ["turnEnd", "pause", "interrupt", "thinking", "opener"];
export const ALL_ROWS: readonly PanelRow[] = [...VOICE_FOLD, ...CONVERSATION_ROWS];

/** Each row's label (the "Not on this model" and "set aside" lines name rows by it). */
export const ROW_LABEL = {
  stability: "voice.settings.eleven_stability", fillers: "voice.settings.fillers", style: "voice.settings.style", pause: "voice.settings.pause",
  interrupt: "voice.settings.interrupt", turnEnd: "voice.settings.turn_end", thinking: "voice.settings.thinking", opener: "voice.settings.opener",
} as const satisfies Record<PanelRow, string>;

/** The optional rows the panel shows for a model (and "Voice from": `eleven`, its speaking model in dialogue mode). */
export function panelRows(caps: VoiceCapabilities, o: { eleven: boolean; elevenDialogue: boolean }): Set<PanelRow> {
  const out = new Set<PanelRow>();
  if (o.eleven && o.elevenDialogue) out.add("stability");
  if (caps.fillers) out.add("fillers");
  if (caps.style) out.add("style");
  if (caps.pauseMs) out.add("pause");
  if (caps.interruptSensitivity) out.add("interrupt");
  if (caps.turnEnd) out.add("turnEnd");
  if (caps.thinking) out.add("thinking");
  if (caps.openerProtect) out.add("opener");
  return out;
}

/** Whether a row's value differs from its default (the fold's "N changed", opening it, the set-aside line). */
export function rowChanged(r: PanelRow, v: ResolvedVoiceSettings): boolean {
  switch (r) {
    case "stability": return (v.elevenStability ?? DEFAULT_ELEVEN_STABILITY) !== DEFAULT_ELEVEN_STABILITY;
    case "fillers": return v.fillers !== DEFAULT_VOICE_SETTINGS.fillers;
    case "style": return v.style !== DEFAULT_VOICE_SETTINGS.style;
    case "pause": return v.pauseMs !== null;
    case "interrupt": return v.interrupt !== null;
    case "turnEnd": return v.turnEnd === "smart";
    case "thinking": return !!v.thinking && v.thinking !== "default";
    case "opener": return v.openerProtected === false;
  }
}

/**
 * After a switch of the model (or "Voice from"): the rows the new choice does not show whose value is not the default.
 * Their values stay in the form (switching back restores them) and are not posted, so a save does not store them.
 */
export function setAsideRows(shown: ReadonlySet<PanelRow>, v: ResolvedVoiceSettings): PanelRow[] {
  return ALL_ROWS.filter((r) => !shown.has(r) && rowChanged(r, v));
}

/** The fold's summary: "More options", and while it is closed with changed values inside, "· 2 changed" (one unit). */
export function moreOptionsCount(changed: number, open: boolean): number | null {
  return !open && changed > 0 ? changed : null;
}

/** The rows that run on test calls only for now on this model (their *_FOR_BUYER_CALLS constants are off). */
export function testOnlyRows(modelId: string): PanelRow[] {
  const out: PanelRow[] = [];
  if (voiceFamilyOf(modelId) === "gemini" && !GEMINI_TURN_TAKING_FOR_BUYER_CALLS) out.push("style", "pause", "interrupt");
  if (!SMART_TURN_END_FOR_BUYER_CALLS) out.push("turnEnd");
  if (!THINKING_EFFORT_FOR_BUYER_CALLS) out.push("thinking");
  if (!OPENER_PROTECTION_FOR_BUYER_CALLS) out.push("opener");
  return out;
}

/** "0:38", "12:05": time in a call. */
export function callClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "10 minutes", "1 minute", "4 minutes 30 seconds": a call limit in words. */
export function callLimitText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const min = m === 1 ? "1 minute" : `${m} minutes`;
  if (!r) return min;
  const secs = r === 1 ? "1 second" : `${r} seconds`;
  return m ? `${min} ${secs}` : secs;
}

/** "10 min", "4 min 30 s", "45 s": a call limit where space is short (the Ready line, hints). */
export function callLimitShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** "0.9 s": an answer time. */
export function answerSpeedText(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

const PACE_WORD: Record<ResolvedVoiceSettings["pace"], string> = { slower: "Slower pace", normal: "Normal pace", faster: "Faster pace" };
const STYLE_WORD: Record<ResolvedVoiceSettings["style"], string> = { patient: "Patient", balanced: "Balanced", quick: "Quick" };

/** "Rachel (ElevenLabs)": the ElevenLabs voice test calls hear ("Voice from: ElevenLabs"). */
export const ELEVEN_VOICE_LABEL = PIPELINE_VOICE_NAME;

/**
 * "Voice from" after a model change: ElevenLabs on a model it does not work with (Gemini) goes back to the model's own
 * voice, and `reset` says so (the form shows one line: never a silent change). Anything else is kept.
 */
export function speechAfterModelSwitch(speech: ResolvedVoiceSettings["speech"], nextModelId: string): { speech: NonNullable<ResolvedVoiceSettings["speech"]>; reset: boolean } {
  if (speech === "elevenlabs" && !isOpenAiVoiceModel(nextModelId)) return { speech: "model", reset: true };
  return { speech: speech ?? "model", reset: false };
}

/** True when the settings have ElevenLabs speak on this model (GPT-Realtime only). */
export function elevenChosen(s: Pick<ResolvedVoiceSettings, "speech">, modelId: string): boolean {
  return s.speech === "elevenlabs" && isOpenAiVoiceModel(modelId);
}

/**
 * The read-only line under "Call the agent": "Gemini 3.8 Live · Puck · upbeat, lively · Normal pace" (only what the
 * model supports). "Voice from: ElevenLabs" (the test lab's calls are test calls): "GPT-Realtime mini · Sarah ·
 * ElevenLabs Flash v2.5 · …", the voice and speaking model test calls hear.
 */
export function voiceSettingsSummary(s: ResolvedVoiceSettings, modelId: string): string {
  const caps = voiceCapabilities(modelId);
  const parts: string[] = [];
  const model = voiceModelLabel(modelId);
  if (model && model !== modelId) parts.push(model);
  const voice = s.voice ?? defaultVoiceOf(caps);
  if (elevenChosen(s, modelId)) parts.push(elevenChoiceText({ model: s.elevenModel ?? DEFAULT_ELEVEN_MODEL, voice: s.elevenVoice ?? DEFAULT_ELEVEN_VOICE }));
  else if (caps.voices.length && voice) parts.push(voiceLabel(voice));
  if (caps.pace) parts.push(PACE_WORD[s.pace]);
  if (caps.style) parts.push(STYLE_WORD[s.style]);
  if (!parts.length) parts.push(PACE_WORD[DEFAULT_VOICE_SETTINGS.pace]);
  return parts.join(" · ");
}

/** "Longest call" choices: whole minutes up to the deployment's cap, plus the cap itself (e.g. 1, 2, 3, 4 min and 4 min 30 s). */
export function limitOptions(capSec: number | null): number[] {
  const cap = capSec ? Math.max(MIN_CALL_SEC, Math.min(PLATFORM_MAX_CALL_SEC, Math.floor(capSec))) : PLATFORM_MAX_CALL_SEC;
  const out: number[] = [];
  for (let x = MIN_CALL_SEC; x <= cap; x += 60) out.push(x);
  if (!out.includes(cap)) out.push(cap);
  return out;
}

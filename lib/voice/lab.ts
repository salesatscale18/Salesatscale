/**
 * Shared, import-safe helpers for the call screens and the voice settings
 * panel (live voice): who may see voice in the test lab, the voice picker's
 * plain labels and the time texts. No server imports: client components use
 * them too, and constants live here, never in a "use client" file.
 */
import { DEFAULT_VOICE_SETTINGS, MIN_CALL_SEC, PLATFORM_MAX_CALL_SEC, voiceCapabilities, voiceMode, type ResolvedVoiceSettings, type VoiceCapabilities } from "./settings";

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
export function voiceOptions(caps: VoiceCapabilities): VoiceOption[] {
  const def = defaultVoiceOf(caps);
  const rest = caps.voices.filter((v) => v !== def);
  const out: VoiceOption[] = def ? [{ value: "", label: voiceLabel(def), isDefault: true }] : [];
  for (const v of rest) out.push({ value: v, label: voiceLabel(v), isDefault: false });
  return out.slice(0, MAX_VOICE_OPTIONS);
}

/** Whether the panel has anything beyond "Filler phrases" and "Longest call" to fold under "Advanced". */
export function hasAdvancedTuning(caps: VoiceCapabilities): boolean {
  return caps.pauseMs || caps.interruptSensitivity;
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

/** The read-only line under "Call the agent": "Voice: Puck · upbeat, lively · Normal pace · Balanced" (only what the model supports). */
export function voiceSettingsSummary(s: ResolvedVoiceSettings, modelId: string): string {
  const caps = voiceCapabilities(modelId);
  const parts: string[] = [];
  const voice = s.voice ?? defaultVoiceOf(caps);
  if (caps.voices.length && voice) parts.push(voiceLabel(voice));
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

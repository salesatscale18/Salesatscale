/**
 * The voice model picker's choices (Versions and test lab › Voice settings), with what each model offers and a
 * per-minute cost hint against Gemini from the price table (lib/ai/models.ts). Server-side: the panel gets the
 * result as plain data (no server import in client code).
 */
import { realtimeUsdPerMinute } from "@/lib/ai/models";
import { DEFAULT_VOICE_MODEL, VOICE_MODELS, voiceCapabilities, type VoiceCapabilities } from "./settings";

export type VoiceModelChoice = { id: string; label: string; note: string; proven: boolean; costHint: string; caps: VoiceCapabilities };

/** "About 7.1× the cost per minute of Gemini (estimate)": relative, from the audio prices of the duration estimate. */
export function modelCostHint(id: string, prices?: Parameters<typeof realtimeUsdPerMinute>[1]): string {
  const base = realtimeUsdPerMinute(DEFAULT_VOICE_MODEL, prices);
  const own = realtimeUsdPerMinute(id, prices);
  if (own === null || base === null || base <= 0) return "No price on file.";
  if (id === DEFAULT_VOICE_MODEL) return "About " + "$" + own.toFixed(3) + " a minute of call (estimate).";
  const x = own / base;
  const times = x >= 10 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString();
  return `About ${times}× the cost per minute of Gemini (estimate).`;
}

/** Every model a version may pick, in the list's order, with its capabilities (the panel re-renders from these). */
export function voiceModelChoices(prices?: Parameters<typeof realtimeUsdPerMinute>[1]): VoiceModelChoice[] {
  return VOICE_MODELS.map((m) => ({ id: m.id, label: m.label, note: m.note, proven: m.proven, costHint: modelCostHint(m.id, prices), caps: voiceCapabilities(m.id) }));
}

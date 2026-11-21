/**
 * The voice model picker's choices (Versions and test lab › Voice settings), with what each model offers and a
 * per-minute cost hint against Gemini from the price table (lib/ai/models.ts). Server-side: the panel gets the
 * result as plain data (no server import in client code).
 */
import { realtimeUsdPerMinute } from "@/lib/ai/models";
import { DEFAULT_VOICE_MODEL, VOICE_MODELS, voiceCapabilities, type VoiceCapabilities } from "./settings";

/** `short`: the cost next to the name in the select ("~7× cost", "lowest cost"); `costHint`: the fuller line under it. */
export type VoiceModelChoice = { id: string; label: string; note: string; proven: boolean; costHint: string; short: string; caps: VoiceCapabilities };

/** The cost in a few words for the select option, from the same price table: "~7× cost" against Gemini, "lowest cost" for the cheapest. */
export function modelCostShort(id: string, prices?: Parameters<typeof realtimeUsdPerMinute>[1]): string {
  const own = realtimeUsdPerMinute(id, prices);
  const all = VOICE_MODELS.map((m) => realtimeUsdPerMinute(m.id, prices)).filter((x): x is number => x !== null);
  const base = realtimeUsdPerMinute(DEFAULT_VOICE_MODEL, prices);
  if (own === null || base === null || base <= 0) return "no price";
  if (own <= Math.min(...all)) return "lowest cost";
  return `~${Math.round(own / base)}× cost`;
}

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
  return VOICE_MODELS.map((m) => ({
    id: m.id, label: m.label, note: m.note, proven: m.proven, costHint: modelCostHint(m.id, prices), short: modelCostShort(m.id, prices), caps: voiceCapabilities(m.id),
  }));
}

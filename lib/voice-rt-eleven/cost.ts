/**
 * The cost of a realtime + ElevenLabs call (lib/voice-rt-eleven): the realtime model's usage as the engine records
 * it (per response on OpenAI), now with TEXT output tokens instead of audio output, priced from the realtime price
 * table (lib/ai/models.ts DEFAULT_REALTIME_PRICES: GPT-Realtime 2.1 text out $24/M, mini $2.40/M), plus ElevenLabs
 * characters × the speech model's rate (lib/voice-pipeline/models.ts SPEAK_MICROS_PER_CHAR).
 *
 * The duration floor of the audio engines (lib/ai/models.ts voiceCallCost: the model hears the whole call and SPEAKS
 * half of it, in audio tokens) does not fit a model that answers in text: here the floor is the listening only
 * (audio in for the model-connected time), so a call is never priced below what the model surely heard.
 */
import {
  audioTokensPerSecond, estimateRealtimeCostMicros, realtimePriceTable, type RealtimePrice, type RealtimeUsageAccumulator, type VoiceCallUsageRecord,
} from "@/lib/ai/models";
import { SPEAK_MICROS_PER_CHAR } from "@/lib/voice-pipeline/models";

/** The realtime model's part: max(usage, listening floor), with the record the session stores. */
export function rtRealtimeCost(
  model: string, acc: RealtimeUsageAccumulator, activeSec: number, prices: Record<string, RealtimePrice> = realtimePriceTable(),
): { costMicros: number; usage: VoiceCallUsageRecord } {
  const usageCost = acc.events > 0 ? estimateRealtimeCostMicros(model, acc.total, prices) : null;
  const heard = Math.round(Math.max(0, activeSec) * audioTokensPerSecond(model));
  const floor = estimateRealtimeCostMicros(model, { audioInTokens: heard, audioOutTokens: 0, textInTokens: 0, textOutTokens: 0, cachedInTokens: 0 }, prices) ?? 0;
  const basis = usageCost !== null && usageCost >= floor ? "usage" : "duration";
  return {
    costMicros: Math.max(usageCost ?? 0, floor),
    usage: {
      ...acc.total, ...(basis === "duration" ? { estimated: true } : {}),
      usageCostMicros: usageCost, durationCostMicros: floor, basis, usageEvents: acc.events, firstSnapshot: acc.first, lastSnapshot: acc.last,
    },
  };
}

/** ElevenLabs' part: characters × the kept speech model's rate (unknown rate: 0, `known` false). */
export function rtSpeakCost(speakModel: string, chars: number): { costMicros: number; known: boolean } {
  const rate = SPEAK_MICROS_PER_CHAR[speakModel];
  return { costMicros: Math.round((rate ?? 0) * Math.max(0, chars)), known: rate !== undefined };
}

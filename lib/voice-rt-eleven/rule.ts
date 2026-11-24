/**
 * THE rule for who speaks on a call (owner, 24 Nov 2026: "make sure they are not contradicting each other and which is
 * actually the one that picks the wiring"):
 * - the agent version's Voice settings decide the MODEL and the VOICE ("Voice from": the model's own voice, or
 *   ElevenLabs: the model answers in text and ElevenLabs speaks);
 * - the test lab's engine select decides only the WIRING (Current, New/guarded, Old baseline/Classic).
 *
 * ElevenLabs applies when the version says so AND the call's model is a GPT-Realtime one AND the wiring is not Classic
 * (Classic is Gemini-only and frozen) AND the call is a test call (buyer calls: ELEVEN_FOR_BUYER_CALLS). Anything else
 * is the model's own voice, and why ElevenLabs was not used is said once in the call's log. Used by
 * lib/voice/service.ts createVoiceSession (stored on the session) and lib/voice/socket.ts (applied, checked again).
 * Pure and import-safe from client code.
 */
import { isOpenAiVoiceModel, type VoiceSpeech } from "@/lib/voice/settings";

/**
 * ElevenLabs speech on BUYER calls. Off for now: a buyer call whose version says "ElevenLabs" uses the model's own
 * voice (logged once per call). The owner switches this later (then the Voice settings form stops showing the
 * "Buyers hear" row: the server passes this constant to it).
 */
export const ELEVEN_FOR_BUYER_CALLS = false;

/** Why ElevenLabs was not used although the version asks for it (the log line's words). */
export type SpeechIgnored = "buyer_call" | "classic" | "not_openai";

export type SpeechDecision = { speech: VoiceSpeech; ignored: SpeechIgnored | null };

/**
 * What speaks on a call: `wanted` is the version's resolved "Voice from", `modelId` the call's realtime model,
 * `engine` the wiring ("current", "guarded", "classic", or an older stored id), `isTest` a test-lab call.
 */
export function speechFor(a: { wanted: VoiceSpeech | null | undefined; modelId: string | null | undefined; engine: string; isTest: boolean; buyerCalls?: boolean }): SpeechDecision {
  if (a.wanted !== "elevenlabs") return { speech: "model", ignored: null };
  if (!a.isTest && !(a.buyerCalls ?? ELEVEN_FOR_BUYER_CALLS)) return { speech: "model", ignored: "buyer_call" };
  if (a.engine === "classic") return { speech: "model", ignored: "classic" };
  if (!isOpenAiVoiceModel(a.modelId)) return { speech: "model", ignored: "not_openai" };
  return { speech: "elevenlabs", ignored: null };
}

/** The once-per-call log line when the version asked for ElevenLabs and the call does not use it. */
export function speechIgnoredLine(why: SpeechIgnored): string {
  return why === "buyer_call" ? "speech=elevenlabs ignored on a buyer call (ELEVEN_FOR_BUYER_CALLS is off): the model's own voice"
    : why === "classic" ? "speech=elevenlabs ignored on the Old baseline (Classic, Gemini only): the model's own voice"
      : "speech=elevenlabs ignored: the call's model is not GPT-Realtime: the model's own voice";
}

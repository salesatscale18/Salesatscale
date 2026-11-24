/**
 * Text output + ElevenLabs (test calls only for now; owner 24 Nov 2026): today's engine (lib/voice/engine.ts) on the
 * wiring the test lab picked (Current, or New = the guarded profile), an OpenAI realtime model (the version's
 * GPT-Realtime 2.1 or mini) listening and deciding with TEXT output, and ElevenLabs speaking the replies (./player.ts,
 * one speech stream per reply, through lib/voice-pipeline's speaker chain). Whether it applies: ./rule.ts (the
 * version's Voice settings "Voice from"). The retired engine ids "rt_eleven"/"rt_eleven_mini" (./profile.ts) still
 * run their old sessions.
 *
 * Word timings: the installed SDK's speech stream parts (@ai-sdk/provider SpeechModelV4StreamPart: stream-start,
 * audio {audio, audioFormat, providerMetadata?}, response-metadata, finish {usage?, providerMetadata?}, raw, error;
 * the Gateway's speech-stream envelope in @ai-sdk/provider-utils carries exactly these) have NO alignment or
 * timestamp fields. ElevenLabs' own alignment could only arrive inside the untyped `providerMetadata`; nothing
 * reads it. What the buyer heard after a barge-in is therefore estimated (player.ts heardEstimate).
 *
 * The speaker of a call:
 * - live (VOICE_REALTIME=live): the version's chosen speaking model, voice and steadiness first, then the pipeline's
 *   speak attempts with Rachel (./speaker.ts ElevenSpeaker over the Gateway, paid);
 * - scripted (VOICE_REALTIME=scripted, the harness and tests): the free ScriptedSpeaker (a tone, no network), named
 *   after the chosen voice.
 */
import { ScriptedSpeaker, type Speaker } from "@/lib/voice-pipeline/speaker";
import { PIPELINE_VOICE_NAME } from "@/lib/voice-pipeline/models";
import { DEFAULT_ELEVEN_CHOICE, elevenVoiceLabel, type ElevenChoice } from "./catalog";
import { ElevenSpeaker } from "./speaker";

export { rtElevenProfile } from "./profile";
export { SpeechPlayer, type SpeechJob } from "./player";

/** The scripted speaker's voice as the call card shows it (the live voice's name: what a live call would use). */
export const RT_SCRIPTED_VOICE = PIPELINE_VOICE_NAME;

/**
 * The speaker for a call in this mode (`override`: a test's fake), speaking the version's `choice` (Voice settings ›
 * Voice). Live parts are built only for a live call.
 */
export async function rtElevenSpeakerFor(
  mode: "live" | "scripted", env: Record<string, string | undefined>, override?: Speaker, choice: ElevenChoice = DEFAULT_ELEVEN_CHOICE,
): Promise<Speaker> {
  if (override) return override;
  if (mode === "scripted") return new ScriptedSpeaker("scripted", { voice: elevenVoiceLabel(choice.voice) });
  const { GatewaySpeaker } = await import("@/lib/voice-pipeline/gateway");
  return new ElevenSpeaker(choice, (l) => new GatewaySpeaker(l.model, env, l.voice, { dialogue: l.dialogue, stability: l.stability }));
}

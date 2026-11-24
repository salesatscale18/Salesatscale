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
 * - live (VOICE_REALTIME=live): the pipeline's speak attempts in order (lib/voice-pipeline/models.ts
 *   PIPELINE_SPEAK_ATTEMPTS: eleven-v4-turbo in dialogue mode first) in a SpeakerChain over the Gateway (paid);
 * - scripted (VOICE_REALTIME=scripted, the harness and tests): the free ScriptedSpeaker (a tone, no network).
 */
import { ScriptedSpeaker, SpeakerChain, type Speaker } from "@/lib/voice-pipeline/speaker";
import { PIPELINE_SPEAK_ATTEMPTS, PIPELINE_VOICE, PIPELINE_VOICE_NAME } from "@/lib/voice-pipeline/models";

export { rtElevenProfile } from "./profile";
export { SpeechPlayer, type SpeechJob } from "./player";

/** The scripted speaker's voice as the call card shows it (the live voice's name: what a live call would use). */
export const RT_SCRIPTED_VOICE = PIPELINE_VOICE_NAME;

/** The speaker for a call in this mode (`override`: a test's fake). Live parts are built only for a live call. */
export async function rtElevenSpeakerFor(mode: "live" | "scripted", env: Record<string, string | undefined>, override?: Speaker): Promise<Speaker> {
  if (override) return override;
  if (mode === "scripted") return new ScriptedSpeaker("scripted", { voice: RT_SCRIPTED_VOICE });
  const { GatewaySpeaker } = await import("@/lib/voice-pipeline/gateway");
  return new SpeakerChain(PIPELINE_SPEAK_ATTEMPTS.map((a) => ({ ...a, speaker: new GatewaySpeaker(a.model, env, PIPELINE_VOICE, { dialogue: a.dialogue }) })));
}

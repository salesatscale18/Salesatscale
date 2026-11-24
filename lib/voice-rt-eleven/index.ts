/**
 * The realtime + ElevenLabs engines (test lab only, platform admins; owner 24 Nov 2026): today's engine
 * (lib/voice/engine.ts) with the guarded profile (./profile.ts), an OpenAI realtime model (GPT-Realtime 2.1 or mini,
 * lib/voice-classic/engine-choice.ts RT_ELEVEN_MODELS) listening and deciding with TEXT output, and ElevenLabs
 * speaking the replies (./player.ts, through lib/voice-pipeline's speaker chain).
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

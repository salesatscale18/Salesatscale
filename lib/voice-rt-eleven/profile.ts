/**
 * The realtime + ElevenLabs engines' model side (test lab "GPT-Realtime 2.1 + ElevenLabs" and "GPT-Realtime mini +
 * ElevenLabs", owner 24 Nov 2026): exactly the guarded profile (lib/voice-guarded/profile.ts: its instructions, tools,
 * result shaping, guards, the server-written price summary, plain objection notes, no transcript cleaning), under its
 * own engine name. The engine runs it with the model answering in text and a speaker (lib/voice/engine.ts `speaker`).
 */
import type { VoiceProfile } from "@/lib/voice/engine";
import { GUARDED_PROFILE } from "@/lib/voice-guarded/profile";
import type { RtElevenEngineName } from "@/lib/voice-classic/engine-choice";

export function rtElevenProfile(engine: RtElevenEngineName): VoiceProfile {
  return { ...GUARDED_PROFILE, engine };
}

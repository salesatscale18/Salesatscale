/**
 * The once-per-call log line of the text-output + ElevenLabs path: how replies are spoken (one speech stream per
 * reply, lib/voice-rt-eleven/player.ts) and the stability sent (dialogue mode only). Pure, no imports beyond constants.
 */
import { PIPELINE_VOICE_STABILITY } from "@/lib/voice-pipeline/models";

export const RT_SPEECH_STREAM_LINE = `rt speech one stream per reply stability=${PIPELINE_VOICE_STABILITY} (dialogue mode only)`;

/**
 * The pipeline proof's models, voice, rates and timings (test lab "Pipeline: listen, think, speak", platform admins
 * only). The only file with model ids for the pipeline: change them here. Thinking is not set here: it is the call's
 * agent version's own chat model and effort (agent_versions.model / effort), exactly as a chat turn.
 *
 * Every id below is a Gateway model id (Vercel AI Gateway, reached with AI_GATEWAY_API_KEY over its streaming
 * WebSocket surfaces: lib/voice-pipeline/gateway.ts).
 */

/**
 * LISTENING: the streaming transcription model ("websocket-transcription" on the Gateway).
 * Alternatives the installed @ai-sdk/gateway (4.0.150) lists for streaming: "openai/gpt-transcribe",
 * "openai/gpt-live-transcribe", "openai/gpt-realtime-whisper", "elevenlabs/scribe-v2-realtime", "spacexai/grok-stt",
 * "microsoft/mai-transcribe-2-streaming".
 */
export const PIPELINE_LISTEN_MODEL = "google/gemini-3.5-transcribe-live";

/**
 * SPEAKING: the streaming speech model ("websocket-speech" on the Gateway), Hebrew and English.
 * Alternatives: "elevenlabs/eleven-flash-v2.5" (faster, lighter), "elevenlabs/eleven-v3-conversational", "elevenlabs/eleven-v4".
 */
export const PIPELINE_SPEAK_MODEL = "elevenlabs/eleven-v4-turbo";

/**
 * The voice the speech model speaks with: an ElevenLabs voice id. Default: the premade "Rachel" voice
 * (21m00Tcm4TlvDq8ikWAM), a calm neutral conversational voice from ElevenLabs' public premade list. NOT verified
 * through the Gateway yet (first paid call): if the speech stream refuses it, the call logs
 * "pipeline speech failed … set PIPELINE_VOICE in lib/voice-pipeline/models.ts" and says nothing.
 */
export const PIPELINE_VOICE = "21m00Tcm4TlvDq8ikWAM";
/** The voice's name for people (the "This call" card). */
export const PIPELINE_VOICE_NAME = "Rachel (ElevenLabs)";

/** What the listener is sent: PCM16 mono at this rate (the browser's 24 kHz mic audio is resampled on the server). */
export const LISTEN_INPUT_RATE = 16_000;
/** What the speaker is asked for: raw PCM16 mono 24 kHz, what the browser plays (anything else is converted or refused). */
export const SPEAK_OUTPUT_RATE = 24_000;

// ---------------------------------------------------------------------------
// Rates (USD micros), for the session's cost estimate. Thinking is priced by the chat turn itself.
// ---------------------------------------------------------------------------

/** Speech: $0.04 per 1,000 characters (eleven-v4-turbo) = 40 micros per character. */
export const SPEAK_MICROS_PER_CHAR: Readonly<Record<string, number>> = {
  "elevenlabs/eleven-v4-turbo": 40,
};
/** Transcription per second of audio sent: gemini-3.5-transcribe-live $0.00015/s, gpt-transcribe $0.000075/s. */
export const LISTEN_MICROS_PER_SEC: Readonly<Record<string, number>> = {
  "google/gemini-3.5-transcribe-live": 150,
  "openai/gpt-transcribe": 75,
};

// ---------------------------------------------------------------------------
// Turn-taking (the proof's values)
// ---------------------------------------------------------------------------

export const PIPELINE_TIMING = {
  /** The local speech detector (lib/voice/vad.ts, the standby detector's values): quiet this long ends the buyer's speech. */
  vad: { threshold: 0.02, minSpeechMs: 250, endSilenceMs: 700, floorFactor: 3, floorRiseMs: 4_000, floorFallMs: 300 },
  /** After the buyer's speech ends, the final transcript is awaited this long; then the partial text (if any) is the turn. */
  finalWaitMs: 1_500,
  /** Barge-in while the agent speaks: buyer speech this long (local detector), or a partial transcript of 2+ words. */
  bargeInSpeechMs: 300,
  bargeInWords: 2,
  /** A transcript shorter than this (characters, trimmed) is noise and ignored. */
  minTurnChars: 2,
  /** Agent audio is sent at most this far ahead of real time (the browser queues it; a barge-in flush drops it). */
  leadMs: 1_000,
  /** Agent audio frames to the browser: at most 100 ms each (PCM16 24 kHz). */
  frameBytes: 4_800,
  /** The opening line waits at most this long for the browser's `ready`. */
  clientReadyMs: 3_000,
} as const;

/** Text-only usage of a pipeline call, stored under voice_sessions.usage.pipeline (no schema change). */
export type PipelineUsage = {
  listenModel: string;
  thinkModel: string;
  speakModel: string;
  /** Seconds of buyer audio sent to the transcription model. */
  listenSec: number;
  /** Characters sent to the speech model. */
  spokenChars: number;
  listenCostMicros: number;
  speakCostMicros: number;
  turns: number;
  medianAnswerMs: number | null;
  medianListenMs: number | null;
  medianThinkMs: number | null;
  medianSpeakMs: number | null;
  bargeIns: number;
};

/** Estimated cost of what the pipeline itself used (listening + speaking); null rates count 0 and are logged. */
export function pipelineCostMicros(listenModel: string, listenSec: number, speakModel: string, spokenChars: number): { listen: number; speak: number; known: boolean } {
  const l = LISTEN_MICROS_PER_SEC[listenModel];
  const s = SPEAK_MICROS_PER_CHAR[speakModel];
  return { listen: Math.round((l ?? 0) * listenSec), speak: Math.round((s ?? 0) * spokenChars), known: l !== undefined && s !== undefined };
}

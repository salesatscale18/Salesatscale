/**
 * The pipeline engines' listening and speaking models, voice, rates and timings (test lab "Pipeline: Gemini Flash +
 * ElevenLabs" and "Pipeline: chat model + ElevenLabs", platform admins only). Thinking is not set here: Gemini 3.8
 * Flash (lib/voice-pipeline/gateway-llm.ts) or the call's agent version's own chat model.
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
 * The streaming transcription models a call may listen with (VOICE_PIPELINE_LISTEN_MODEL picks one without a code
 * change; anything else is refused with a warning and the default is used). Each needs a rate in
 * LISTEN_MICROS_PER_SEC, or it counts 0 and the call logs "rate unknown".
 */
export const PIPELINE_LISTEN_MODELS = [
  PIPELINE_LISTEN_MODEL,
  "openai/gpt-transcribe",
  "openai/gpt-live-transcribe",
  "openai/gpt-realtime-whisper",
  "elevenlabs/scribe-v2-realtime",
  "spacexai/grok-stt",
  "microsoft/mai-transcribe-2-streaming",
] as const;

/** Env override of the listening model (test-lab experiments): one of PIPELINE_LISTEN_MODELS, `creator/model`. */
export const PIPELINE_LISTEN_MODEL_ENV = "VOICE_PIPELINE_LISTEN_MODEL";

/**
 * The call's listening model: VOICE_PIPELINE_LISTEN_MODEL when it is one of PIPELINE_LISTEN_MODELS (case and
 * whitespace ignored), else PIPELINE_LISTEN_MODEL (`invalid` says why, for the start log).
 */
export function pipelineListenModelChoice(env: Record<string, string | undefined> = process.env): { model: string; fromEnv: boolean; invalid?: string } {
  const raw = env[PIPELINE_LISTEN_MODEL_ENV]?.trim().toLowerCase();
  if (!raw) return { model: PIPELINE_LISTEN_MODEL, fromEnv: false };
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*$/.test(raw)) return { model: PIPELINE_LISTEN_MODEL, fromEnv: false, invalid: "not a creator/model id" };
  if (!(PIPELINE_LISTEN_MODELS as readonly string[]).includes(raw)) {
    return { model: PIPELINE_LISTEN_MODEL, fromEnv: false, invalid: "not a streaming transcription model listed in lib/voice-pipeline/models.ts" };
  }
  return { model: raw, fromEnv: true };
}

/**
 * SPEAKING: the streaming speech models ("websocket-speech" on the Gateway), tried in this order the first time a
 * call needs speech; the first that produces audio is kept for the rest of the call (lib/voice-pipeline/speaker.ts
 * SpeakerChain, logged "pipeline speech using <model> <mode>"). A failed attempt is logged and the next one says the
 * SAME text at once.
 *
 * `dialogue`: stream through ElevenLabs Text-to-Dialogue (`providerOptions.elevenlabs.dialogue = { voices: [voice] }`,
 * lib/voice-pipeline/gateway.ts). The ElevenLabs provider the Gateway runs (@ai-sdk/elevenlabs 3.0.x,
 * elevenlabs-speech-model.ts doStream) refuses a v3/v4 model on the text-to-speech WebSocket without it ("The
 * ElevenLabs text-to-speech WebSocket does not serve eleven_v4_turbo. Set providerOptions.elevenlabs.dialogue …",
 * the first live call, 24 Nov) and refuses the option on any other model; eleven_v3_conversational takes exactly
 * one dialogue voice. `englishOnly`: skipped on a Hebrew call.
 */
export type SpeakAttempt = { model: string; dialogue: boolean; englishOnly?: boolean };
export const PIPELINE_SPEAK_ATTEMPTS: readonly SpeakAttempt[] = [
  { model: "elevenlabs/eleven-v4-turbo", dialogue: true },
  { model: "elevenlabs/eleven-v3-conversational", dialogue: false },
  { model: "elevenlabs/eleven-v3-conversational", dialogue: true },
  { model: "elevenlabs/eleven-flash-v2.5", dialogue: false, englishOnly: true },
  { model: "elevenlabs/eleven-multilingual-v2", dialogue: false },
];
/** The first speech model tried (the call card's line before the call has spoken). */
export const PIPELINE_SPEAK_MODEL = PIPELINE_SPEAK_ATTEMPTS[0].model;
/** "dialogue" / "speech" (the logs). */
export const speakModeName = (a: Pick<SpeakAttempt, "dialogue">) => (a.dialogue ? "dialogue" : "speech");
/** An attempt that cannot speak this language (flash v2.5 in the list is English only). */
export const attemptSkipped = (a: SpeakAttempt, language: string) => !!a.englishOnly && /^he|^iw/i.test(language);

/**
 * The voice the speech model speaks with: an ElevenLabs voice id. Default: the premade "Rachel" voice
 * (21m00Tcm4TlvDq8ikWAM), a calm neutral conversational voice from ElevenLabs' public premade list. NOT verified
 * through the Gateway yet (first paid call): if the speech stream refuses it, the call logs
 * "pipeline speech failed … set PIPELINE_VOICE in lib/voice-pipeline/models.ts" and says nothing.
 */
export const PIPELINE_VOICE = "21m00Tcm4TlvDq8ikWAM";
/** The voice's name for people (the "This call" card). */
export const PIPELINE_VOICE_NAME = "Rachel (ElevenLabs)";

/**
 * The voice's stability, sent in dialogue mode only (providerOptions.elevenlabs.dialogue.voiceSettings.stability,
 * lib/voice-pipeline/gateway.ts speakProviderOptions; text-to-speech attempts get nothing new). ElevenLabs v3/v4
 * dialogue accepts 0, 0.5 and 1: 0 = most expressive, 0.5 = natural, 1 = most stable. Default 1 (owner, 24 Nov: the
 * voice changed mid-answer).
 */
export const PIPELINE_VOICE_STABILITY = 1;

/** What the listener is sent: PCM16 mono at this rate (the browser's 24 kHz mic audio is resampled on the server). */
export const LISTEN_INPUT_RATE = 16_000;
/** What the speaker is asked for: raw PCM16 mono 24 kHz, what the browser plays (anything else is converted or refused). */
export const SPEAK_OUTPUT_RATE = 24_000;

// ---------------------------------------------------------------------------
// Rates (USD micros), for the session's cost estimate. Thinking is priced by the chat turn itself.
// ---------------------------------------------------------------------------

/**
 * Speech per character: $0.04 per 1,000 characters (eleven-v4-turbo, eleven-v3-conversational, eleven-flash-v2.5)
 * = 40 micros; $0.08 per 1,000 (eleven-multilingual-v2) = 80 micros. Charged on the model the call kept.
 */
export const SPEAK_MICROS_PER_CHAR: Readonly<Record<string, number>> = {
  "elevenlabs/eleven-v4-turbo": 40,
  "elevenlabs/eleven-v3-conversational": 40,
  "elevenlabs/eleven-flash-v2.5": 40,
  "elevenlabs/eleven-multilingual-v2": 80,
};
/**
 * Transcription per second of audio sent: gemini-3.5-transcribe-live $0.00015/s, gpt-transcribe $0.000075/s,
 * grok-stt $0.000028/s. elevenlabs/scribe-v2-realtime (and the other listed models): rate unknown, counts 0 and
 * the call logs "rate unknown".
 */
export const LISTEN_MICROS_PER_SEC: Readonly<Record<string, number>> = {
  "google/gemini-3.5-transcribe-live": 150,
  "openai/gpt-transcribe": 75,
  "spacexai/grok-stt": 28,
};

/** "150 micros/s" or "rate unknown (counts 0)" (the start log). */
export function listenRateText(model: string): string {
  const r = LISTEN_MICROS_PER_SEC[model];
  return r === undefined ? "rate unknown (counts 0)" : `${r} micros/s`;
}

// ---------------------------------------------------------------------------
// Turn-taking (the proof's values)
// ---------------------------------------------------------------------------

export const PIPELINE_TIMING = {
  /** The local speech detector (lib/voice/vad.ts, the standby detector's values): quiet this long ends the buyer's speech. */
  vad: { threshold: 0.02, minSpeechMs: 250, endSilenceMs: 550, floorFactor: 3, floorRiseMs: 4_000, floorFallMs: 300 },
  /**
   * After the local detector hears the buyer's speech end, the listener is asked to finalise the utterance
   * (Listener.endUtterance) and a final transcript is taken at once when it comes. Without one, the partial text is
   * the line once it has been unchanged for `stableMs` after the speech end, and in any case after `capMs`.
   * Both run from the detector's report (after `vad.endSilenceMs` of quiet), not from the buyer's last word.
   * Calls 1-2 (24 Nov) ran with 350 / 1,000 ms and an end silence of 700 ms.
   */
  lineWait: { stableMs: 250, capMs: 800 },
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

/**
 * THINKING on a call: the most output tokens one model round may produce (GatewayLlm's maxOutputTokens cap for the
 * pipeline). A spoken reply is a few sentences and tool-call arguments fit; a round cut here finishes with "length"
 * and is logged as a warning ("pipeline think round=… finish=length").
 */
export const PIPELINE_MAX_OUTPUT_TOKENS = 700;

/**
 * "One moment": when a turn has been thinking `afterMs` (from its final transcript) with no reply yet, the engine
 * says ONE short filler in the call's language (at most once per turn, never while the buyer speaks); the reply
 * follows once the filler has played. Not on two answered turns in a row: when the previous answered turn had one,
 * the filler waits for `afterPreviousMs` instead (logged "pipeline filler skipped (previous turn had one)" at
 * `afterMs`). Not stored as a chat message; its characters count as speech. The call of 24 Nov ran with 2,500 ms and
 * no consecutive rule: the filler fired on all four turns.
 */
export const PIPELINE_FILLER = { afterMs: 3_000, afterPreviousMs: 6_000, text: { en: "One moment.", he: "רגע אחד." } } as const;
export const fillerTextFor = (language: string) => (/^(he|iw)/i.test(language) ? PIPELINE_FILLER.text.he : PIPELINE_FILLER.text.en);

/**
 * The per-turn context line of a call turn (replyToBuyer's `callContextLine`, passed by lib/voice-pipeline/turn.ts
 * makeCallTurn). The wording is PROVISIONAL (test lab only, awaiting the owner's
 * confirmation). An empty string switches it off. One line, under 600 characters.
 */
export const PIPELINE_CALL_CONTEXT_LINE =
  "This is a live call. When recording what the buyer said is all you need to do this turn, call update_deal_state and put what you say to the buyer in its spoken_reply argument: one response, no second step. When you need another tool or its result first, leave spoken_reply null and answer after the results.";

/**
 * The description of update_deal_state's optional `spoken_reply` argument on a call turn (replyToBuyer's
 * `callReplyArgDescription`, passed by lib/voice-pipeline/turn.ts makeCallTurn; capped at 400 characters there). With it, a
 * response that is only update_deal_state call(s) with a non-empty spoken_reply ends the turn in one round with that
 * text. The wording is PROVISIONAL (test lab only, awaiting the owner's confirmation). An empty string switches it off.
 */
export const PIPELINE_CALL_REPLY_ARG_DESCRIPTION =
  "What you say to the buyer now, when recording is all you need to do this turn. Leave null when you need another tool or its result first.";

/** Text-only usage of a pipeline call, stored under voice_sessions.usage.pipeline (no schema change). */
export type PipelineUsage = {
  listenModel: string;
  /** The thinking model actually used (Gemini Flash or the chat model). */
  thinkModel: string;
  /** The speech model the call kept (the first attempt that produced audio; the first in the list if none did). */
  speakModel: string;
  /** Seconds of buyer audio sent to the transcription model. */
  listenSec: number;
  /** Characters sent to the speech model. */
  spokenChars: number;
  listenCostMicros: number;
  speakCostMicros: number;
  /** Answered turns (a reply came), spoken or not: their listen and think times count even when speech failed. */
  turns: number;
  /** Turns whose reply was heard (audio sent): only these have speak and total (answer) times. */
  spokenTurns?: number;
  medianAnswerMs: number | null;
  medianListenMs: number | null;
  medianThinkMs: number | null;
  medianSpeakMs: number | null;
  bargeIns: number;
  /** Thinking rounds (model calls) per answered turn, median; null when the thinking client reports no rounds. */
  medianRounds?: number | null;
  /** Answered turns whose rounds were reported, and those of them answered in ONE model round (the summary's oneRound=K/N). */
  roundTurns?: number;
  oneRoundTurns?: number;
  /** Time per thinking round, median over every round of the call. */
  medianRoundMs?: number | null;
  /** Think time outside the model rounds per turn (tools, DB, overhead), median. */
  medianOtherMs?: number | null;
  /** Cached share of the input tokens per round, median, in percent. */
  medianCachedPct?: number | null;
  /** Speech synthesis start → its first audio chunk (every spoken text: replies, opener, fillers), median. */
  medianSpeakFirstAudioMs?: number | null;
  /** "One moment" fillers said. */
  fillers?: number;
};

/** Estimated cost of what the pipeline itself used (listening + speaking); null rates count 0 and are logged. */
export function pipelineCostMicros(listenModel: string, listenSec: number, speakModel: string, spokenChars: number): { listen: number; speak: number; known: boolean } {
  const l = LISTEN_MICROS_PER_SEC[listenModel];
  const s = SPEAK_MICROS_PER_CHAR[speakModel];
  return { listen: Math.round((l ?? 0) * listenSec), speak: Math.round((s ?? 0) * spokenChars), known: l !== undefined && s !== undefined };
}

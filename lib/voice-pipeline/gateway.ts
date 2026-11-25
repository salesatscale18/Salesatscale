/**
 * The live (paid) listener and speaker of the pipeline proof, over the Vercel AI Gateway with AI_GATEWAY_API_KEY.
 * Uses the installed SDK's own streaming interfaces (ai 7.0.177, @ai-sdk/gateway 4.0.150), nothing hand-rolled:
 *
 * - LISTENING: `experimental_streamTranscribe` with `gateway.experimental_transcription(model)`, one stream per
 *   buyer utterance (GatewayListener below). The SDK opens
 *   `wss://ai-gateway.vercel.sh/v4/ai/transcription-model?ai-model-id=<model>` with the subprotocols
 *   ["ai-gateway-transcription.v1", "ai-gateway-auth.<key>"], sends the TEXT frame
 *   `{type:"transcription-stream.start", inputAudioFormat:{type:"audio/pcm", rate}}`, then the audio as BINARY frames
 *   (≤ 64 KiB) and `{type:"transcription-stream.audio-done"}` at the end; the server sends JSON parts:
 *   transcript-delta / transcript-partial / transcript-final / error / finish.
 * - SPEAKING: `experimental_streamSpeech` with `gateway.experimental_speech(model)`: `…/speech-model?ai-model-id=…`,
 *   subprotocols ["ai-gateway-speech.v1", "ai-gateway-auth.<key>"], TEXT frames `speech-stream.start` (voice,
 *   outputFormat, language, providerOptions: the ElevenLabs dialogue option for the v3/v4 models),
 *   `speech-stream.text-delta`, `speech-stream.text-done`; the server sends `audio` parts
 *   (base64 audio with its `audioFormat`), then `finish`.
 *
 * Built only for a live call (assertLiveAllowed: never under the test runner, VOICE_REALTIME=live, a Gateway key).
 * The SDK modules and `ws` are imported only here, on the first live call.
 */
import { assertLiveAllowed } from "@/lib/voice/gateway-realtime";
import { ListenerBase, type Listener } from "./listener";
import type { Speaker } from "./speaker";
import { LISTEN_INPUT_RATE, PIPELINE_VOICE, PIPELINE_VOICE_STABILITY, SPEAK_OUTPUT_RATE } from "./models";
import { Resampler } from "./pcm";
import { VOICE_SAMPLE_RATE } from "@/lib/voice/protocol";

type Sdk = {
  ai: typeof import("ai");
  gateway: ReturnType<typeof import("@ai-sdk/gateway").createGateway>;
};

async function loadSdk(apiKey: string): Promise<Sdk> {
  const [ai, { createGateway }, { WebSocket }] = await Promise.all([import("ai"), import("@ai-sdk/gateway"), import("ws")]);
  // `ws` takes (url, protocols, { headers }) like the SDK's WebSocketConstructor; auth rides the subprotocols anyway.
  const webSocket = WebSocket as unknown as NonNullable<Parameters<typeof createGateway>[0]>["webSocket"];
  return { ai, gateway: createGateway({ apiKey, webSocket }) };
}

const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e).replace(/\s+/g, " ").slice(0, 200);

/** Audio kept for a transcription stream that is still connecting (and replayed on a new one): 2 s at most. */
export const LISTEN_REPLAY_MS = 2_000;
/** A finalised (retired) stream is aborted this long after its audio-done if the provider has not finished it. */
const RETIRED_STREAM_MS = 5_000;
/** Consecutive streams that fail before any transcript: then the listener gives up (reported once). */
const MAX_STREAM_FAILURES = 3;

/**
 * The audio of one transcription stream, read by the SDK as it can: chunks queue while the stream connects (at most
 * `maxBytes`, the oldest dropped) and `end()` makes the SDK send `transcription-stream.audio-done`.
 */
export class AudioPipe {
  readonly stream: ReadableStream<Uint8Array>;
  private queue: Uint8Array[] = [];
  private bytes = 0;
  private ended = false;
  private wake: (() => void) | null = null;
  dropped = 0;
  /**
   * When the SDK first read the audio (performance.now), null until then. The gateway transcription stream
   * (@ai-sdk/gateway 4.0.150 createGatewayTranscriptionStream) takes its reader in the socket's onOpen, after the
   * start frame: this is when the stream connected.
   */
  firstReadAt: number | null = null;

  constructor(private readonly maxBytes: number) {
    this.stream = new ReadableStream<Uint8Array>({
      pull: async (c) => {
        this.firstReadAt ??= performance.now();
        for (;;) {
          const next = this.queue.shift();
          if (next) {
            this.bytes -= next.byteLength;
            c.enqueue(next);
            return;
          }
          if (this.ended) {
            c.close();
            return;
          }
          await new Promise<void>((r) => (this.wake = r));
        }
      },
      cancel: () => {
        this.ended = true;
        this.queue = [];
        this.bytes = 0;
        this.notify();
      },
    }, { highWaterMark: 0 });
  }

  private notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  push(chunk: Uint8Array) {
    if (this.ended || !chunk.byteLength) return;
    this.queue.push(chunk);
    this.bytes += chunk.byteLength;
    while (this.bytes > this.maxBytes && this.queue.length > 1) {
      const old = this.queue.shift()!;
      this.bytes -= old.byteLength;
      this.dropped += old.byteLength;
    }
    this.notify();
  }

  /** No more audio: the SDK sends audio-done once it has read what is queued. */
  end() {
    this.ended = true;
    this.notify();
  }

  get queuedBytes() {
    return this.bytes;
  }
}

/** One Gateway transcription stream (one buyer utterance, or the rest of the call). */
type ListenStream = { n: number; pipe: AudioPipe; abort: AbortController; retired: boolean; heard: boolean; deltas: Map<string, string>; openedAt: number };

/**
 * Streaming transcription, one Gateway stream per buyer utterance. The buyer's audio is resampled from 24 kHz to
 * LISTEN_INPUT_RATE and pushed to the current stream. Partial text: the latest transcript-partial, or the deltas of
 * the utterance so far; final: each transcript-final.
 *
 * Why per utterance (the first live call, 24 Nov: "no final transcript within 1500ms" on every turn): the stream
 * protocol has no commit or flush frame (@ai-sdk/provider-utils transcription-stream envelope: start, binary audio,
 * audio-done); google/gemini-3.5-transcribe-live (@ai-sdk/google google-transcription-model.ts) finalises a
 * segment only on the server's own pause detection (`generationComplete`), or when the audio stream ends
 * (audio-done → `audioStreamEnd`: the interim text becomes the segment's final). So `endUtterance()` (the engine's
 * speech detector heard the buyer stop) ends the current stream's audio, which makes the provider finalise it, and
 * opens a fresh stream at once for the next utterance; audio arriving while it connects is queued (2 s at most)
 * and sent when it is open. A retired stream still delivers its trailing partials and final; it is aborted after
 * RETIRED_STREAM_MS. A stream that fails is replaced (the last 2 s of audio replayed when it failed before any
 * transcript); after MAX_STREAM_FAILURES such failures in a row the listener reports the error and stops.
 */
export class GatewayListener extends ListenerBase implements Listener {
  private readonly resampler = new Resampler(VOICE_SAMPLE_RATE, LISTEN_INPUT_RATE);
  private readonly apiKey: string;
  private readonly maxBytes = Math.round((LISTEN_INPUT_RATE * 2 * LISTEN_REPLAY_MS) / 1000);
  private sdk: Promise<Sdk> | null = null;
  private current: ListenStream;
  private seq = 0;
  private recent: Uint8Array[] = [];
  private recentBytes = 0;
  private failures = 0;
  private closed = false;
  /** Streams opened (the logs, tests). */
  streams = 0;
  /** Connect time of the stream the last endUtterance retired (null: unknown, or it never connected). */
  lastConnectMs: number | null = null;

  constructor(readonly modelId: string, env: Record<string, string | undefined> = process.env) {
    super();
    assertLiveAllowed(env);
    this.apiKey = env.AI_GATEWAY_API_KEY!.trim();
    this.current = this.open([]);
  }

  private open(replay: Uint8Array[]): ListenStream {
    const st: ListenStream = { n: ++this.seq, pipe: new AudioPipe(this.maxBytes), abort: new AbortController(), retired: false, heard: false, deltas: new Map(), openedAt: performance.now() };
    for (const b of replay) st.pipe.push(b);
    this.streams++;
    void this.run(st);
    return st;
  }

  private async run(st: ListenStream) {
    try {
      this.sdk ??= loadSdk(this.apiKey);
      const { ai, gateway } = await this.sdk;
      const result = ai.experimental_streamTranscribe({
        model: gateway.experimental_transcription(this.modelId),
        audio: st.pipe.stream,
        inputAudioFormat: { type: "audio/pcm", rate: LISTEN_INPUT_RATE },
        abortSignal: st.abort.signal,
      });
      for await (const part of result.fullStream) {
        if (this.closed) return;
        if (part.type === "transcript-delta") {
          st.heard = true;
          const id = part.id ?? "_";
          const text = (st.deltas.get(id) ?? "") + part.delta;
          st.deltas.set(id, text);
          this.emitPartial(text);
        } else if (part.type === "transcript-partial") {
          st.heard = true;
          this.emitPartial(part.text);
        } else if (part.type === "transcript-final") {
          st.heard = true;
          st.deltas.delete(part.id ?? "_");
          this.emitFinal(part.text);
        } else if (part.type === "error") {
          throw part.error instanceof Error ? part.error : new Error(errText(part.error));
        }
      }
      if (st.heard) this.failures = 0;
      // A retired stream ends here once its utterance is final: normal. The current one ending is not.
      if (!st.retired && !this.closed) this.replace(st, "transcription stream ended");
    } catch (e) {
      if (this.closed || (st.retired && st.abort.signal.aborted)) return;
      if (st.retired) return; // its utterance is over; a late error changes nothing
      this.replace(st, `transcription failed: ${errText(e)}`);
    }
  }

  /** The current stream failed or ended: a new one takes over (the last 2 s replayed if nothing was heard yet). */
  private replace(st: ListenStream, why: string) {
    if (st !== this.current || this.closed) return;
    st.abort.abort();
    this.failures = st.heard ? 0 : this.failures + 1;
    if (this.failures >= MAX_STREAM_FAILURES) {
      this.closed = true;
      this.emitError(`${why} (${this.failures} streams in a row without a transcript; listening stopped)`);
      return;
    }
    this.emitError(`${why}; stream ${st.n} replaced`);
    this.current = this.open(st.heard ? [] : this.recent);
  }

  /**
   * The buyer stopped speaking (the engine's detector): the current stream's audio ends (the provider finalises the
   * utterance) and a fresh stream takes the next audio.
   */
  endUtterance() {
    if (this.closed) return;
    const old = this.current;
    this.lastConnectMs = old.pipe.firstReadAt === null ? null : Math.round(old.pipe.firstReadAt - old.openedAt);
    old.retired = true;
    old.pipe.end();
    const t = setTimeout(() => old.abort.abort(), RETIRED_STREAM_MS);
    (t as { unref?: () => void }).unref?.();
    this.recent = [];
    this.recentBytes = 0;
    this.current = this.open([]);
  }

  pushAudio(pcm: Uint8Array) {
    if (this.closed) return;
    const out = this.resampler.push(pcm);
    if (!out.byteLength) return;
    this.sentMs += (out.byteLength / 2 / LISTEN_INPUT_RATE) * 1000;
    this.current.pipe.push(out);
    this.recent.push(out);
    this.recentBytes += out.byteLength;
    while (this.recentBytes > this.maxBytes && this.recent.length > 1) this.recentBytes -= this.recent.shift()!.byteLength;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.current.pipe.end();
    this.current.abort.abort();
  }
}

/**
 * The provider options of an ElevenLabs speak attempt in dialogue mode:
 * `{ elevenlabs: { dialogue: { voices: [voice], voiceSettings: { stability } } } }` (stability: models.ts
 * PIPELINE_VOICE_STABILITY, 24 Nov: the expressive v4 model changed its delivery within a reply).
 * The shape is @ai-sdk/elevenlabs's (3.0.88, elevenlabs-speech-model-options.ts: `dialogue: { voices: string[1..10],
 * voiceSettings?: { stability } }`); the Gateway passes `providerOptions` through verbatim in the
 * `speech-stream.start` frame (@ai-sdk/gateway gateway-speech-model.ts doStream). In dialogue mode the call's `voice`
 * must be one of `voices` (else the provider refuses it), each text part is spoken by `voice`, and `language` still
 * goes as the stream's `language_code`.
 */
export function speakProviderOptions(voice: string, stability: number = PIPELINE_VOICE_STABILITY): { elevenlabs: { dialogue: { voices: string[]; voiceSettings: { stability: number } } } } {
  return { elevenlabs: { dialogue: { voices: [voice], voiceSettings: { stability } } } };
}

/**
 * What a speak attempt adds to the speech stream's start: the dialogue options (with the stability) in dialogue mode;
 * nothing for a text-to-speech attempt (the provider refuses the dialogue option there, and nothing new is sent).
 */
export function speakRequestOptions(voice: string, dialogue: boolean, stability: number = PIPELINE_VOICE_STABILITY): { providerOptions?: ReturnType<typeof speakProviderOptions> } {
  return dialogue ? { providerOptions: speakProviderOptions(voice, stability) } : {};
}

/**
 * The speaking rate of a text-to-speech attempt: the AI SDK's `speed` call option (ai 7.0.177 streamSpeech; the
 * Gateway passes it on; @ai-sdk/elevenlabs 3.0.88 getStreamInitMessage sends it as `voice_settings.speed`). Nothing in
 * dialogue mode (Text-to-Dialogue ignores it) or without a rate (normal pace: nothing new is sent).
 */
export function speakSpeedOption(dialogue: boolean, speed: number | undefined): { speed?: number } {
  return !dialogue && typeof speed === "number" ? { speed } : {};
}

/**
 * Streaming speech, one Gateway stream per text (the realtime path: a whole reply): raw PCM 24 kHz is asked for; PCM at another rate is
 * resampled; any other format fails with a clear error (the engine logs it). `cancel` aborts every stream in progress.
 */
export class GatewaySpeaker implements Speaker {
  readonly voice: string;
  private sdk: Promise<Sdk> | null = null;
  private readonly active = new Set<AbortController>();
  private readonly apiKey: string;

  /** Streams through ElevenLabs Text-to-Dialogue (one voice) instead of text-to-speech: see speakProviderOptions. */
  readonly dialogue: boolean;
  /** The stability sent in dialogue mode (the version's "Steadiness" on the realtime path; else PIPELINE_VOICE_STABILITY). */
  readonly stability: number;
  /** The speaking rate sent to a text-to-speech model (the version's pace; lib/voice-rt-eleven/catalog.ts elevenSpeedFor); never in dialogue mode. */
  readonly speed: number | undefined;

  constructor(
    readonly modelId: string, env: Record<string, string | undefined> = process.env, voice: string = PIPELINE_VOICE,
    opts: { dialogue?: boolean; stability?: number; speed?: number } = {},
  ) {
    assertLiveAllowed(env);
    this.apiKey = env.AI_GATEWAY_API_KEY!.trim();
    this.voice = voice;
    this.dialogue = opts.dialogue === true;
    this.stability = opts.stability ?? PIPELINE_VOICE_STABILITY;
    this.speed = this.dialogue ? undefined : opts.speed;
  }

  async *speak(text: string, opts: { language: string }): AsyncIterable<Uint8Array> {
    const abort = new AbortController();
    this.active.add(abort);
    try {
      this.sdk ??= loadSdk(this.apiKey);
      const { ai, gateway } = await this.sdk;
      if (abort.signal.aborted) return;
      let speechError: unknown = null;
      const result = ai.experimental_streamSpeech({
        model: gateway.experimental_speech(this.modelId),
        text,
        voice: this.voice,
        outputFormat: { type: "audio/pcm", rate: SPEAK_OUTPUT_RATE },
        language: opts.language,
        ...speakRequestOptions(this.voice, this.dialogue, this.stability),
        ...speakSpeedOption(this.dialogue, this.speed),
        abortSignal: abort.signal,
        onError: ({ error }) => void (speechError = error),
      });
      let resampler: Resampler | null = null;
      for await (const part of result.fullStream) {
        if (abort.signal.aborted) return;
        if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(errText(part.error ?? speechError));
        if (part.type !== "audio" || !part.audio.byteLength) continue;
        const fmt = part.audioFormat;
        if (!/pcm|l16|raw/i.test(fmt.type)) throw new Error(`speech model returned ${fmt.type}, not raw PCM (asked for audio/pcm ${SPEAK_OUTPUT_RATE})`);
        const rate = fmt.rate ?? SPEAK_OUTPUT_RATE;
        if (rate !== SPEAK_OUTPUT_RATE) resampler ??= new Resampler(rate, SPEAK_OUTPUT_RATE);
        yield resampler ? resampler.push(part.audio) : part.audio;
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      throw e;
    } finally {
      this.active.delete(abort);
    }
  }

  cancel() {
    for (const a of this.active) a.abort();
    this.active.clear();
  }
}

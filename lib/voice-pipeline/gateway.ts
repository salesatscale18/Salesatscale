/**
 * The live (paid) listener and speaker of the pipeline proof, over the Vercel AI Gateway with AI_GATEWAY_API_KEY.
 * Uses the installed SDK's own streaming interfaces (ai 7.0.177, @ai-sdk/gateway 4.0.150), nothing hand-rolled:
 *
 * - LISTENING: `experimental_streamTranscribe` with `gateway.experimental_transcription(model)`. The SDK opens
 *   `wss://ai-gateway.vercel.sh/v4/ai/transcription-model?ai-model-id=<model>` with the subprotocols
 *   ["ai-gateway-transcription.v1", "ai-gateway-auth.<key>"], sends the TEXT frame
 *   `{type:"transcription-stream.start", inputAudioFormat:{type:"audio/pcm", rate}}`, then the audio as BINARY frames
 *   (≤ 64 KiB) and `{type:"transcription-stream.audio-done"}` at the end; the server sends JSON parts:
 *   transcript-delta / transcript-partial / transcript-final / error / finish.
 * - SPEAKING: `experimental_streamSpeech` with `gateway.experimental_speech(model)`: `…/speech-model?ai-model-id=…`,
 *   subprotocols ["ai-gateway-speech.v1", "ai-gateway-auth.<key>"], TEXT frames `speech-stream.start` (voice,
 *   outputFormat, language), `speech-stream.text-delta`, `speech-stream.text-done`; the server sends `audio` parts
 *   (base64 audio with its `audioFormat`), then `finish`.
 *
 * Built only for a live call (assertLiveAllowed: never under the test runner, VOICE_REALTIME=live, a Gateway key).
 * The SDK modules and `ws` are imported only here, on the first live call.
 */
import { assertLiveAllowed } from "@/lib/voice/gateway-realtime";
import { ListenerBase, type Listener } from "./listener";
import type { Speaker } from "./speaker";
import { LISTEN_INPUT_RATE, PIPELINE_VOICE, SPEAK_OUTPUT_RATE } from "./models";
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

/**
 * Streaming transcription for the whole call: one Gateway stream, the buyer's audio resampled from 24 kHz to
 * LISTEN_INPUT_RATE and pushed as it comes. Partial text: the latest transcript-partial, or the deltas of the
 * utterance so far; final: each transcript-final.
 */
export class GatewayListener extends ListenerBase implements Listener {
  private readonly resampler = new Resampler(VOICE_SAMPLE_RATE, LISTEN_INPUT_RATE);
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly abort = new AbortController();
  private closed = false;
  private deltas = new Map<string, string>();

  constructor(readonly modelId: string, env: Record<string, string | undefined> = process.env) {
    super();
    assertLiveAllowed(env);
    const audio = new ReadableStream<Uint8Array>({ start: (c) => void (this.controller = c) });
    void this.run(env.AI_GATEWAY_API_KEY!.trim(), audio);
  }

  private async run(apiKey: string, audio: ReadableStream<Uint8Array>) {
    try {
      const { ai, gateway } = await loadSdk(apiKey);
      const result = ai.experimental_streamTranscribe({
        model: gateway.experimental_transcription(this.modelId),
        audio,
        inputAudioFormat: { type: "audio/pcm", rate: LISTEN_INPUT_RATE },
        abortSignal: this.abort.signal,
      });
      for await (const part of result.fullStream) {
        if (this.closed) return;
        if (part.type === "transcript-delta") {
          const id = part.id ?? "_";
          const text = (this.deltas.get(id) ?? "") + part.delta;
          this.deltas.set(id, text);
          this.emitPartial(text);
        } else if (part.type === "transcript-partial") {
          this.emitPartial(part.text);
        } else if (part.type === "transcript-final") {
          this.deltas.delete(part.id ?? "_");
          this.emitFinal(part.text);
        } else if (part.type === "error") {
          this.emitError(`transcription error: ${errText(part.error)}`);
        }
      }
      if (!this.closed) this.emitError("transcription stream ended");
    } catch (e) {
      if (!this.closed) this.emitError(`transcription failed: ${errText(e)}`);
    }
  }

  pushAudio(pcm: Uint8Array) {
    if (this.closed || !this.controller) return;
    const out = this.resampler.push(pcm);
    if (!out.byteLength) return;
    this.sentMs += (out.byteLength / 2 / LISTEN_INPUT_RATE) * 1000;
    try {
      this.controller.enqueue(out);
    } catch {
      // The stream already ended (an error was reported).
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller?.close();
    } catch {
      // Already closed.
    }
    this.abort.abort();
  }
}

/**
 * Streaming speech, one Gateway stream per text (a sentence): raw PCM 24 kHz is asked for; PCM at another rate is
 * resampled; any other format fails with a clear error (the engine logs it). `cancel` aborts every stream in progress.
 */
export class GatewaySpeaker implements Speaker {
  readonly voice: string;
  private sdk: Promise<Sdk> | null = null;
  private readonly active = new Set<AbortController>();
  private readonly apiKey: string;

  constructor(readonly modelId: string, env: Record<string, string | undefined> = process.env, voice: string = PIPELINE_VOICE) {
    assertLiveAllowed(env);
    this.apiKey = env.AI_GATEWAY_API_KEY!.trim();
    this.voice = voice;
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

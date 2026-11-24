/**
 * LISTENING (pipeline proof): the buyer's audio in, transcripts out. Behind this small interface so the engine never
 * sees a provider: the Gateway's streaming transcription (lib/voice-pipeline/gateway.ts) on a live call; the scripted
 * listener (VOICE_REALTIME=scripted: free, no network) or a test's hand-driven fake otherwise.
 */
import { EnergyVad, type VadOptions } from "@/lib/voice/vad";
import { pcmDurationMs } from "@/lib/voice/protocol";
import { PIPELINE_TIMING } from "./models";

export interface Listener {
  /** The model id (logs, the session's settings); "scripted" for the free stand-in. */
  readonly modelId: string;
  /** Buyer audio: PCM16 mono 24 kHz, as the browser sends it. */
  pushAudio(pcm: Uint8Array): void;
  /** The text so far of the utterance being heard (replaces the previous partial). */
  onPartial(cb: (text: string) => void): void;
  /** One finished utterance (or segment of one). */
  onFinal(cb: (text: string) => void): void;
  /** The listener failed for good (the call goes on without it; logged). */
  onError(cb: (message: string) => void): void;
  /**
   * Optional: the engine's detector heard the buyer stop. A listener that can finalise the utterance does so now
   * (GatewayListener: audio-done on this stream, a fresh stream for the next utterance).
   */
  endUtterance?(): void;
  /**
   * Optional, read right after endUtterance: how long the stream that carried the utterance just ended took to
   * connect (from its opening to the SDK's first read of its audio, i.e. the socket open); null when unknown or it
   * never connected.
   */
  readonly lastConnectMs?: number | null;
  /** Seconds of audio sent to the model so far (the cost estimate). */
  readonly audioSec: number;
  close(): void;
}

/** Callback plumbing shared by the listeners. */
export class ListenerBase {
  protected partialCbs: ((t: string) => void)[] = [];
  protected finalCbs: ((t: string) => void)[] = [];
  protected errorCbs: ((m: string) => void)[] = [];
  protected sentMs = 0;
  onPartial(cb: (text: string) => void) { this.partialCbs.push(cb); }
  onFinal(cb: (text: string) => void) { this.finalCbs.push(cb); }
  onError(cb: (message: string) => void) { this.errorCbs.push(cb); }
  protected emitPartial(t: string) { for (const cb of this.partialCbs) cb(t); }
  protected emitFinal(t: string) { for (const cb of this.finalCbs) cb(t); }
  protected emitError(m: string) { for (const cb of this.errorCbs) cb(m); }
  get audioSec() { return Math.round(this.sentMs / 100) / 10; }
}

/**
 * A test's listener: records the audio it is given; the test says what was heard (`partial`, `final`).
 */
export class ManualListener extends ListenerBase implements Listener {
  readonly modelId: string;
  closed = false;
  bytes = 0;
  /** endUtterance calls (the engine's speech ends). */
  utteranceEnds = 0;
  /** What the engine reads as the ended utterance's stream connect time (a test sets it). */
  lastConnectMs: number | null = null;
  constructor(modelId = "scripted") {
    super();
    this.modelId = modelId;
  }
  pushAudio(pcm: Uint8Array) {
    this.bytes += pcm.byteLength;
    this.sentMs += pcmDurationMs(pcm.byteLength);
  }
  partial(text: string) { this.emitPartial(text); }
  final(text: string) { this.emitFinal(text); }
  fail(message: string) { this.emitError(message); }
  endUtterance() { this.utteranceEnds++; }
  close() { this.closed = true; }
}

/**
 * The free stand-in for VOICE_REALTIME=scripted (the harness, local runs): hears speech with the energy detector and
 * "transcribes" each stretch as a fixed numbered line, a partial when the speech starts and the final when it ends.
 */
export class ScriptedListener extends ListenerBase implements Listener {
  readonly modelId = "scripted";
  private readonly vad: EnergyVad;
  private n = 0;
  constructor(vad: VadOptions = { ...PIPELINE_TIMING.vad }) {
    super();
    this.vad = new EnergyVad(vad);
  }
  pushAudio(pcm: Uint8Array) {
    this.sentMs += pcmDurationMs(pcm.byteLength);
    const e = this.vad.push(pcm);
    if (e === "start") this.emitPartial("Scripted buyer");
    else if (e === "end") this.emitFinal(`Scripted buyer line ${++this.n}.`);
  }
  close() {}
}

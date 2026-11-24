/**
 * SPEAKING (pipeline proof): text in, PCM16 mono 24 kHz chunks out (what the browser plays). Behind this small
 * interface: the Gateway's streaming speech (lib/voice-pipeline/gateway.ts) on a live call; the scripted speaker
 * (VOICE_REALTIME=scripted: a quiet tone, free, no network) or a test's fake otherwise.
 */
import { VOICE_SAMPLE_RATE } from "@/lib/voice/protocol";

export interface Speaker {
  /** The model id (logs, the session's settings); "scripted" for the free stand-in. */
  readonly modelId: string;
  /** The voice it speaks with (the "This call" card). */
  readonly voice: string;
  /** Speaks one text: its audio as PCM16 mono 24 kHz chunks, in order. Ends early (no error) once cancelled. */
  speak(text: string, opts: { language: string }): AsyncIterable<Uint8Array>;
  /** Stops every speech in progress now (barge-in, the end of the call). */
  cancel(): void;
}

/** A short audible tone (so a scripted call is heard), `ms` long, PCM16 24 kHz. */
export function tonePcm(ms: number, hz = 220, amplitude = 2_000): Uint8Array {
  const n = Math.round((VOICE_SAMPLE_RATE * ms) / 1000);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / VOICE_SAMPLE_RATE) * amplitude), true);
  return out;
}

/**
 * The free stand-in and the tests' fake: every text becomes `msPerChar` of tone per character (at most `maxMs`),
 * in chunks of `chunkMs`, each after a microtask (or `delay`, a test's hook). Records what it was asked to say.
 */
export class ScriptedSpeaker implements Speaker {
  readonly voice: string;
  readonly said: { text: string; language: string }[] = [];
  cancels = 0;
  private gen = 0;
  constructor(
    readonly modelId = "scripted",
    private readonly o: { msPerChar?: number; maxMs?: number; chunkMs?: number; delay?: () => Promise<void>; voice?: string; failWith?: string } = {},
  ) {
    this.voice = o.voice ?? "scripted tone";
  }
  async *speak(text: string, opts: { language: string }): AsyncIterable<Uint8Array> {
    const gen = this.gen;
    this.said.push({ text, language: opts.language });
    if (this.o.failWith) throw new Error(this.o.failWith);
    const total = Math.min(this.o.maxMs ?? 1_500, Math.max(100, text.length * (this.o.msPerChar ?? 10)));
    const chunk = this.o.chunkMs ?? 100;
    for (let at = 0; at < total; at += chunk) {
      await (this.o.delay ? this.o.delay() : Promise.resolve());
      if (gen !== this.gen) return;
      yield tonePcm(Math.min(chunk, total - at));
    }
  }
  cancel() {
    this.gen++;
    this.cancels++;
  }
}

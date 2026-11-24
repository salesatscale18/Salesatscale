/**
 * SPEAKING (pipeline proof): text in, PCM16 mono 24 kHz chunks out (what the browser plays). Behind this small
 * interface: the Gateway's streaming speech (lib/voice-pipeline/gateway.ts) on a live call; the scripted speaker
 * (VOICE_REALTIME=scripted: a quiet tone, free, no network) or a test's fake otherwise.
 */
import { VOICE_SAMPLE_RATE } from "@/lib/voice/protocol";
import { attemptSkipped, speakModeName, type SpeakAttempt } from "./models";

/** Where a speaker writes its own log lines (the engine stamps them with the session). */
export type SpeakerLog = (level: "info" | "warn", line: string) => void;

export interface Speaker {
  /** The model id (logs, the session's settings); "scripted" for the free stand-in. */
  readonly modelId: string;
  /** The voice it speaks with (the "This call" card). */
  readonly voice: string;
  /** Speaks one text: its audio as PCM16 mono 24 kHz chunks, in order. Ends early (no error) once cancelled. */
  speak(text: string, opts: { language: string }): AsyncIterable<Uint8Array>;
  /** Stops every speech in progress now (barge-in, the end of the call). */
  cancel(): void;
  /** Optional: the engine's log, for a speaker that reports its own choices (SpeakerChain). */
  setLog?(log: SpeakerLog): void;
}

/** Every speech attempt failed: the call goes on without speech (logged once, by the chain). */
export class SpeechUnavailable extends Error {
  readonly alreadyLogged = true;
  constructor(message: string) {
    super(message);
    this.name = "SpeechUnavailable";
  }
}

/** One speak attempt of the chain: its model and mode, and the speaker that runs it. */
export type ChainLink = SpeakAttempt & { speaker: Speaker };

const clipMsg = (e: unknown) => String((e as { message?: unknown })?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * The live speaker of a pipeline call: an ordered list of speak attempts (lib/voice-pipeline/models.ts
 * PIPELINE_SPEAK_ATTEMPTS). The first time the call needs speech, the attempts are tried in order on that text: the
 * first that produces audio is kept for the rest of the call (logged "pipeline speech using <model> <mode>"); a
 * failed attempt is logged with the provider's message (clipped) and the next one says the SAME text at once, so the
 * buyer still hears it. An attempt that cannot speak the call's language is skipped. While the choice is being made,
 * other texts (the next sentence, prefetched) wait for it. If every attempt fails, that is logged once and every
 * later text fails at once with SpeechUnavailable (nothing more is logged): the call goes on without speech.
 * A cancel during the choice ends it without a choice (the next text tries again from the top).
 */
export class SpeakerChain implements Speaker {
  readonly voice: string;
  private chosen: ChainLink | null = null;
  private choosing: Promise<ChainLink | null> | null = null;
  private exhausted = false;
  private gen = 0;
  private log: SpeakerLog = () => {};

  /**
   * `onChosen`: called once when an attempt produced audio and is kept, with the failures before it ("<model> <mode>:
   * <reason>", in order); the realtime + ElevenLabs speaker logs its fallback line from it.
   */
  constructor(private readonly links: readonly ChainLink[], private readonly opts: { onChosen?(link: ChainLink, failures: readonly string[]): void } = {}) {
    if (!links.length) throw new Error("SpeakerChain needs at least one speak attempt");
    this.voice = links[0].speaker.voice;
  }

  /** The model the call kept; the first in the list until one has spoken. */
  get modelId(): string {
    return (this.chosen ?? this.links[0]).model;
  }

  /** "dialogue" / "speech" of the model kept (null until one has spoken). */
  get mode(): string | null {
    return this.chosen ? speakModeName(this.chosen) : null;
  }

  setLog(log: SpeakerLog) {
    this.log = log;
  }

  async *speak(text: string, opts: { language: string }): AsyncIterable<Uint8Array> {
    if (this.chosen) return yield* this.chosen.speaker.speak(text, opts);
    if (this.exhausted) throw new SpeechUnavailable("no speech model works on this call (logged)");
    if (this.choosing) {
      const link = await this.choosing;
      if (link) return yield* link.speaker.speak(text, opts);
      if (this.exhausted) throw new SpeechUnavailable("no speech model works on this call (logged)");
      return; // the choice was cancelled (barge-in, the end): this text is not said
    }
    yield* this.choose(text, opts);
  }

  /** Tries the attempts in order on `text`; the first with audio is kept and its audio is this text's. */
  private async *choose(text: string, opts: { language: string }): AsyncGenerator<Uint8Array> {
    const gen = this.gen;
    let settle!: (link: ChainLink | null) => void;
    this.choosing = new Promise((r) => (settle = r));
    let settled = false;
    const done = (link: ChainLink | null) => {
      if (settled) return;
      settled = true;
      this.choosing = null;
      settle(link);
    };
    const failures: string[] = [];
    try {
      for (const link of this.links) {
        const name = `${link.model} ${speakModeName(link)}`;
        if (attemptSkipped(link, opts.language)) {
          this.log("info", `pipeline speech skipping ${name}: English only (call language ${opts.language})`);
          continue;
        }
        if (gen !== this.gen) return done(null);
        const it = link.speaker.speak(text, opts)[Symbol.asyncIterator]();
        let first: IteratorResult<Uint8Array>;
        try {
          first = await it.next();
          while (!first.done && !first.value.byteLength) first = await it.next();
        } catch (e) {
          if (gen !== this.gen) return done(null);
          const why = clipMsg(e);
          failures.push(`${name}: ${why}`);
          this.log("warn", `pipeline speech attempt failed (${name}): ${why}; trying the next`);
          continue;
        }
        if (gen !== this.gen) {
          await it.return?.();
          return done(null);
        }
        if (first.done) {
          failures.push(`${name}: no audio`);
          this.log("warn", `pipeline speech attempt failed (${name}): the stream ended without audio; trying the next`);
          continue;
        }
        this.chosen = link;
        this.log("info", `pipeline speech using ${name}${failures.length ? ` (after ${failures.length} failed)` : ""}`);
        this.opts.onChosen?.(link, failures);
        done(link);
        try {
          yield first.value;
          for (;;) {
            const r = await it.next();
            if (r.done) return;
            yield r.value;
          }
        } finally {
          await it.return?.();
        }
      }
      if (gen !== this.gen) return done(null);
      this.exhausted = true;
      this.log("warn", `pipeline speech unavailable: every speech model failed (${failures.join(" | ") || "none tried"}); the call goes on without speech`);
      done(null);
      throw new SpeechUnavailable("every speech model failed (logged)");
    } finally {
      done(null);
    }
  }

  cancel() {
    this.gen++;
    for (const l of this.links) l.speaker.cancel();
  }
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

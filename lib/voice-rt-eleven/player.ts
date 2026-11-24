/**
 * The speech player of the text-output + ElevenLabs path (lib/voice-rt-eleven): a complete reply's text, already in
 * its spoken form, is spoken by a Speaker (lib/voice-pipeline/speaker.ts: SpeakerChain on a live call,
 * ScriptedSpeaker otherwise) as ONE speech stream for the whole reply (one `speech-stream.start`, the reply's full
 * text, one stream of audio). Until 24 Nov each sentence was its own request, and the expressive v4 model chose tone
 * and delivery anew for every sentence: the voice changed mid-answer (owner, live test).
 *
 * The stream is read into a buffer as fast as the provider sends it (so the reply's total audio length is known as
 * soon as synthesis ends), and its PCM16 24 kHz audio goes out in 100 ms frames paced to real time (never more than
 * `leadMs` ahead of what the browser plays). Replies play one after the other, never over each other; no reply is
 * synthesized before its turn (no prefetch: the realtime path has no fillers). `cancel` (a barge-in, the end of the
 * call) stops everything at once and estimates what the buyer heard of the reply in progress (heardEstimate).
 * No network of its own; the clock is injectable (tests move it by hand).
 */
import { VOICE_SAMPLE_RATE } from "@/lib/voice/protocol";
import type { Clock } from "@/lib/voice/realtime";
import type { Speaker } from "@/lib/voice-pipeline/speaker";
import { PcmFramer, pcmMs } from "@/lib/voice-pipeline/pcm";

/**
 * Characters per second of speech when nothing was measured yet on the call (ElevenLabs conversational English is
 * about 14-16 characters a second). Only for the heard-text estimate after a barge-in.
 */
export const FALLBACK_CHARS_PER_SEC = 15;

/** One reply to speak. */
export type SpeechJob = {
  readonly id: number;
  /** The engine's agent turn this reply is (its stored line). */
  readonly turnId: string;
  /** The whole reply (its spoken form): one speech stream. */
  readonly text: string;
  readonly language: string;
  /** When the reply was handed to the player (the response was complete). */
  readonly queuedAt: number;
  /** Characters whose synthesis produced audio (what the speech model bills): the reply's length, once audio came. */
  chars: number;
  firstAudioAt: number | null;
  /** Audio received from the speech stream so far, ms. */
  receivedMs: number;
  /** The speech stream ended normally: receivedMs is the reply's whole audio. */
  synthDone: boolean;
  /** Audio sent to the browser, ms. */
  sentMs: number;
  /** Every frame of the reply was sent (the browser may still be playing the last lead). */
  allSent: boolean;
  /** After a cancel: the audio sent but not yet played (the lead the browser drops), and the estimate of what was heard. */
  unplayedMs?: number;
  heard?: HeardEstimate;
  state: "queued" | "playing" | "done" | "cut" | "failed";
  error?: string;
};

export type HeardEstimate = {
  /** The reply's text the buyer heard: a prefix of it ending at a word boundary ("" when none). */
  text: string;
  /** Audio the buyer heard (sent minus the unplayed lead), ms. */
  playedMs: number;
  /** "total": the stream's whole audio was known (share of it); "rate": a characters-per-second rate. */
  basis: "total" | "rate";
  /** The rate used (basis "rate"): measured on this call's finished streams, else FALLBACK_CHARS_PER_SEC. */
  charsPerSec: number | null;
};

/**
 * What the buyer heard of a reply cut after `playedMs` of its audio: characters × the played share, cut back to the
 * last word boundary. The share is exact-ish when the stream's whole audio length is known (`totalMs`: synthesis had
 * finished); otherwise the characters said so far are `playedMs` × `charsPerSec`. The SDK's speech stream parts carry
 * no alignment or timestamps (see the report in lib/voice-rt-eleven/index.ts), so this is an estimate.
 */
export function heardEstimate(text: string, playedMs: number, o: { totalMs: number | null; charsPerSec: number }): HeardEstimate {
  const played = Math.max(0, playedMs);
  const basis = o.totalMs !== null && o.totalMs > 0 ? "total" as const : "rate" as const;
  const chars = basis === "total" ? (text.length * Math.min(1, played / o.totalMs!)) : (played / 1000) * o.charsPerSec;
  const n = Math.min(text.length, Math.floor(chars));
  let heard: string;
  if (n >= text.length) heard = text;
  else if (n <= 0) heard = "";
  // The cut lands on a boundary (the next character is a space): the words up to it were heard.
  else if (/\s/.test(text[n])) heard = text.slice(0, n).trimEnd();
  else {
    const cut = text.slice(0, n).search(/\s\S*$/);
    heard = cut < 0 ? "" : text.slice(0, cut).trimEnd();
  }
  return { text: heard, playedMs: Math.round(played), basis, charsPerSec: basis === "rate" ? o.charsPerSec : null };
}

export type SpeechPlayerOptions = {
  speaker: Speaker;
  clock: Clock;
  /** Audio frames to the browser: at most this many bytes (PCM16 24 kHz; 4,800 = 100 ms). */
  frameBytes: number;
  /** Agent audio is sent at most this far ahead of real time. */
  leadMs: number;
  /** A frame of agent audio for the browser (and the recording). */
  send(frame: Uint8Array, job: SpeechJob): void;
  /** The reply's first audio went out. */
  onFirstAudio?(job: SpeechJob): void;
  /** Characters of a reply whose synthesis produced audio (counted once per reply). */
  onChars?(chars: number, job: SpeechJob): void;
  /** The reply finished (all sent, or speech failed): not called for a cut. */
  onJobEnd?(job: SpeechJob): void;
  /** Every queued reply was sent and the browser has played it out: the agent is quiet now. Not called after a cancel. */
  onIdle?(): void;
  log?(level: "info" | "warn", line: string): void;
};

const clipMsg = (e: unknown) => String((e as { message?: unknown })?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 200);

export class SpeechPlayer {
  private readonly framer: PcmFramer;
  private queue: SpeechJob[] = [];
  private current: SpeechJob | null = null;
  /** The last reply whose frames were all sent while the browser still plays its lead (null once played out). */
  private tail: SpeechJob | null = null;
  /** The run loop's generation (a cancel starts a new one). */
  private gen = 0;
  private running: number | null = null;
  /** When the browser will have played everything sent so far (clock time). */
  private playheadAt = 0;
  private waits = new Set<() => void>();
  private seq = 0;
  /** This call's finished streams: characters and audio ms (the measured speaking rate). */
  private measured = { chars: 0, ms: 0 };
  /** Speech streams opened (one per reply; tests and the logs). */
  streams = 0;

  constructor(private readonly o: SpeechPlayerOptions) {
    this.framer = new PcmFramer(o.frameBytes);
  }

  /** A reply is queued, playing, or its audio is still playing in the browser. */
  get active(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  /** The reply whose audio is going out now (null between replies). */
  get playing(): SpeechJob | null {
    return this.current;
  }

  /** Characters per second measured on this call's finished streams; null before the first one finished. */
  get measuredCharsPerSec(): number | null {
    return this.measured.ms > 0 ? (this.measured.chars / this.measured.ms) * 1000 : null;
  }

  /** Queues a reply (spoken after the ones before it) as one speech stream. */
  play(turnId: string, text: string, language: string): SpeechJob {
    const job: SpeechJob = {
      id: ++this.seq, turnId, text, language, queuedAt: this.o.clock.now(), chars: 0, firstAudioAt: null,
      receivedMs: 0, synthDone: false, sentMs: 0, allSent: false, state: "queued",
    };
    this.queue.push(job);
    if (this.running === null) void this.run(this.gen);
    return job;
  }

  /**
   * Stops now: the speaker is cancelled, waits end, queued replies are dropped, no frame goes out after this. Returns
   * the reply that was playing (or still playing out its lead in the browser, or the next one, not started yet), with
   * `unplayedMs` and `heard` set; null when nothing was queued or playing. A reply cut mid-stream is marked cut.
   */
  cancel(): SpeechJob | null {
    const now = this.o.clock.now();
    // The reply the buyer is hearing: the one sending, else the last one still playing out its lead (the next reply
    // may already be synthesizing, with nothing sent yet), else the next one.
    const cut = (this.current && this.current.sentMs > 0 ? this.current : null) ?? this.tail ?? this.current ?? this.queue[0] ?? null;
    if (cut) {
      cut.unplayedMs = Math.max(0, Math.min(cut.sentMs, this.playheadAt - now));
      const rate = this.measuredCharsPerSec ?? FALLBACK_CHARS_PER_SEC;
      cut.heard = heardEstimate(cut.text, cut.sentMs - cut.unplayedMs, { totalMs: cut.synthDone ? cut.receivedMs : null, charsPerSec: rate });
    }
    for (const j of [this.current, ...this.queue]) if (j && (j.state === "queued" || j.state === "playing")) j.state = "cut";
    this.gen++;
    this.running = null;
    this.current = null;
    this.tail = null;
    this.queue = [];
    this.o.speaker.cancel();
    this.framer.reset();
    this.playheadAt = now;
    for (const w of [...this.waits]) w();
    this.waits.clear();
    return cut;
  }

  private async run(gen: number) {
    this.running = gen;
    while (gen === this.gen && this.queue.length) {
      const job = this.queue.shift()!;
      this.current = job;
      this.tail = null;
      await this.playJob(job, gen);
      if (gen !== this.gen) return;
      this.current = null;
      if (job.allSent) this.tail = job;
      if (job.state !== "cut") this.o.onJobEnd?.(job);
    }
    if (gen !== this.gen) return;
    // The browser plays what was sent: the agent is speaking until the playhead.
    const left = this.playheadAt - this.o.clock.now();
    if (left > 0) await this.wait(left);
    if (gen !== this.gen) return;
    // A reply queued while the last one played out: play it now.
    if (this.queue.length) return void this.run(gen);
    this.tail = null;
    this.running = null;
    this.o.onIdle?.();
  }

  /** One reply: ONE speech stream, read into a buffer as it comes, its frames paced out to the browser. */
  private async playJob(job: SpeechJob, gen: number) {
    job.state = "playing";
    this.framer.reset();
    this.streams++;
    const buf: Uint8Array[] = [];
    let ended = false;
    let error: unknown = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    // The reader: the whole reply's audio, as fast as the provider sends it.
    void (async () => {
      try {
        for await (const chunk of this.o.speaker.speak(job.text, { language: job.language })) {
          if (gen !== this.gen) return;
          if (!chunk.byteLength) continue;
          if (!job.chars) {
            job.chars = job.text.length;
            this.o.onChars?.(job.chars, job);
          }
          job.receivedMs += pcmMs(chunk.byteLength, VOICE_SAMPLE_RATE);
          buf.push(chunk);
          notify();
        }
        if (gen === this.gen && job.receivedMs > 0) {
          job.synthDone = true;
          this.measured.chars += job.text.length;
          this.measured.ms += job.receivedMs;
        }
      } catch (e) {
        error = e;
      } finally {
        ended = true;
        notify();
      }
    })();
    try {
      for (;;) {
        if (gen !== this.gen) return;
        const chunk = buf.shift();
        if (chunk) {
          for (const frame of this.framer.push(chunk)) {
            await this.pace();
            if (gen !== this.gen) return;
            const now = this.o.clock.now();
            const ms = pcmMs(frame.byteLength, VOICE_SAMPLE_RATE);
            this.o.send(frame, job);
            job.sentMs += ms;
            this.playheadAt = Math.max(this.playheadAt, now) + ms;
            if (job.firstAudioAt === null) {
              job.firstAudioAt = now;
              this.o.onFirstAudio?.(job);
            }
          }
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          const done = () => {
            this.waits.delete(done);
            resolve();
          };
          wake = done;
          this.waits.add(done);
        });
      }
      if (gen !== this.gen) return;
      if (error) throw error;
      job.allSent = true;
      job.state = "done";
    } catch (e) {
      if (gen !== this.gen) return;
      job.state = "failed";
      job.error = clipMsg(e);
      // A speaker chain logs its own failures (each attempt, and once when none works).
      if (!(e as { alreadyLogged?: boolean })?.alreadyLogged) this.o.log?.("warn", `rt speech failed: ${job.error}`);
      this.o.speaker.cancel();
    }
  }

  /** Waits until the browser's queue is within the lead. */
  private async pace() {
    const ahead = this.playheadAt - this.o.clock.now();
    if (ahead > this.o.leadMs) await this.wait(ahead - this.o.leadMs);
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.waits.delete(finish);
        this.o.clock.clearTimeout(h);
        resolve();
      };
      const h = this.o.clock.setTimeout(finish, ms);
      this.waits.add(finish);
    });
  }
}

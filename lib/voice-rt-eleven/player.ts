/**
 * The speech player of the realtime + ElevenLabs engines (lib/voice-rt-eleven): a complete reply's text, already in
 * its spoken form and split into sentences, is spoken by a Speaker (lib/voice-pipeline/speaker.ts: SpeakerChain on a
 * live call, ScriptedSpeaker otherwise) sentence by sentence, the next sentence synthesizing while the current one
 * plays (lib/voice-pipeline/prefetch.ts), and its PCM16 24 kHz audio goes out in 100 ms frames paced to real time
 * (never more than `leadMs` ahead of what the browser plays), exactly as the pipeline engines send it. Replies play
 * one after the other, never over each other. `cancel` (a barge-in, the end of the call) stops everything at once and
 * says how far the reply in progress got. No network of its own; the clock is injectable (tests move it by hand).
 */
import { VOICE_SAMPLE_RATE } from "@/lib/voice/protocol";
import type { Clock } from "@/lib/voice/realtime";
import type { Speaker } from "@/lib/voice-pipeline/speaker";
import { PcmFramer, pcmMs } from "@/lib/voice-pipeline/pcm";
import { prefetch, type Prefetch } from "@/lib/voice-pipeline/prefetch";

/** One reply to speak. `started`/`sent`: sentences whose audio started going out / went out whole. */
export type SpeechJob = {
  readonly id: number;
  /** The engine's agent turn this reply is (its stored line). */
  readonly turnId: string;
  readonly sentences: readonly string[];
  readonly language: string;
  /** When the reply was handed to the player (the response was complete). */
  readonly queuedAt: number;
  started: number;
  sent: number;
  /** Characters whose synthesis produced audio (what the speech model bills). */
  chars: number;
  firstAudioAt: number | null;
  state: "queued" | "playing" | "done" | "cut" | "failed";
  error?: string;
};

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
  /** Characters of a sentence whose synthesis produced audio (counted once per sentence). */
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
  /** The run loop's generation (a cancel starts a new one). */
  private gen = 0;
  private running: number | null = null;
  /** When the browser will have played everything sent so far (clock time). */
  private playheadAt = 0;
  private waits = new Set<() => void>();
  private seq = 0;

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

  /** Queues a reply (spoken after the ones before it). */
  play(turnId: string, sentences: readonly string[], language: string): SpeechJob {
    const job: SpeechJob = { id: ++this.seq, turnId, sentences, language, queuedAt: this.o.clock.now(), started: 0, sent: 0, chars: 0, firstAudioAt: null, state: "queued" };
    this.queue.push(job);
    if (this.running === null) void this.run(this.gen);
    return job;
  }

  /**
   * Stops now: the speaker is cancelled, waits end, queued replies are dropped. Returns the reply that was playing
   * (or the next one, not started yet) as it stood, marked cut; null when nothing was queued or playing.
   */
  cancel(): SpeechJob | null {
    const cut = this.current ?? this.queue[0] ?? null;
    for (const j of [this.current, ...this.queue]) if (j && (j.state === "queued" || j.state === "playing")) j.state = "cut";
    this.gen++;
    this.running = null;
    this.current = null;
    this.queue = [];
    this.o.speaker.cancel();
    this.framer.reset();
    this.playheadAt = this.o.clock.now();
    for (const w of [...this.waits]) w();
    this.waits.clear();
    return cut;
  }

  private async run(gen: number) {
    this.running = gen;
    while (gen === this.gen && this.queue.length) {
      const job = this.queue.shift()!;
      this.current = job;
      await this.playJob(job, gen);
      if (gen !== this.gen) return;
      this.current = null;
      if (job.state !== "cut") this.o.onJobEnd?.(job);
    }
    if (gen !== this.gen) return;
    // The browser plays what was sent: the agent is speaking until the playhead.
    const left = this.playheadAt - this.o.clock.now();
    if (left > 0) await this.wait(left);
    if (gen !== this.gen) return;
    // A reply queued while the last one played out: play it now.
    if (this.queue.length) return void this.run(gen);
    this.running = null;
    this.o.onIdle?.();
  }

  private async playJob(job: SpeechJob, gen: number) {
    job.state = "playing";
    this.framer.reset();
    const starts: Prefetch[] = [];
    const startSentence = (i: number) => {
      if (i >= job.sentences.length || starts[i]) return;
      starts[i] = prefetch(this.o.speaker.speak(job.sentences[i], { language: job.language }), () => {
        job.chars += job.sentences[i].length;
        this.o.onChars?.(job.sentences[i].length, job);
      });
    };
    try {
      for (let i = 0; i < job.sentences.length; i++) {
        startSentence(i);
        startSentence(i + 1);
        for await (const chunk of starts[i].chunks()) {
          if (gen !== this.gen) return;
          for (const frame of this.framer.push(chunk)) {
            await this.pace();
            if (gen !== this.gen) return;
            const now = this.o.clock.now();
            if (job.started <= i) job.started = i + 1;
            this.o.send(frame, job);
            this.playheadAt = Math.max(this.playheadAt, now) + pcmMs(frame.byteLength, VOICE_SAMPLE_RATE);
            if (job.firstAudioAt === null) {
              job.firstAudioAt = now;
              this.o.onFirstAudio?.(job);
            }
          }
        }
        if (gen !== this.gen) return;
        job.sent = i + 1;
      }
      job.state = "done";
    } catch (e) {
      if (gen !== this.gen) return;
      job.state = "failed";
      job.error = clipMsg(e);
      // A speaker chain logs its own failures (each attempt, and once when none works).
      if (!(e as { alreadyLogged?: boolean })?.alreadyLogged) this.o.log?.("warn", `rt speech failed: ${job.error}`);
      this.o.speaker.cancel();
    } finally {
      for (const s of starts) s?.stop();
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

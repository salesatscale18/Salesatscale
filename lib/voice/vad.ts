/**
 * A cheap energy speech detector for PCM16 mono 24 kHz audio, and a rolling
 * audio buffer (live voice). The scripted model hears the buyer with it, and
 * the engine listens with it while a call is on standby (lib/voice/call-rules.ts):
 * speech = energy above the threshold for at least `minSpeechMs`; a shorter
 * burst (a click) is ignored. With `floorFactor`, the threshold follows the
 * room: loud = above the noise floor × factor, so a noisy room does not count
 * as speech for long. `boost` raises the threshold (after false wakes).
 * Pure and dependency-free.
 */
import { pcmDurationMs } from "./protocol";

/** RMS of a PCM16 little-endian frame, 0..1. */
export function rms(pcm: Uint8Array): number {
  const n = Math.floor(pcm.byteLength / 2);
  if (!n) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export type VadOptions = {
  threshold: number;
  minSpeechMs: number;
  endSilenceMs: number;
  /** Adaptive noise floor (omit for a fixed threshold). */
  floorFactor?: number;
  floorRiseMs?: number;
  floorFallMs?: number;
};

export type VadEvent = "start" | "end" | null;

export class EnergyVad {
  inSpeech = false;
  /** The room's noise level as heard so far (RMS). */
  floor = 0;
  /** Multiplies the threshold (1 = as configured). */
  boost = 1;
  private loudMs = 0;
  private quietMs = 0;

  constructor(readonly o: VadOptions) {}

  /** The level a frame must reach to count as loud now. */
  get level(): number {
    const adaptive = this.o.floorFactor ? this.floor * this.o.floorFactor : 0;
    return Math.max(this.o.threshold, adaptive) * this.boost;
  }

  /** One frame: "start" when speech begins, "end" when it stops, else null. */
  push(pcm: Uint8Array): VadEvent {
    const ms = pcmDurationMs(pcm.byteLength);
    if (!ms) return null;
    const r = rms(pcm);
    const loud = r >= this.level;
    this.follow(r, ms);
    if (loud) {
      this.quietMs = 0;
      this.loudMs += ms;
      if (!this.inSpeech && this.loudMs >= this.o.minSpeechMs) {
        this.inSpeech = true;
        return "start";
      }
      return null;
    }
    if (this.inSpeech) {
      this.quietMs += ms;
      if (this.quietMs >= this.o.endSilenceMs) return this.end();
      return null;
    }
    // A burst shorter than minSpeechMs (a click) is forgotten.
    this.loudMs = 0;
    return null;
  }

  /** Speech stops now (audio that simply stopped). */
  end(): VadEvent {
    if (!this.inSpeech) return null;
    this.inSpeech = false;
    this.loudMs = 0;
    this.quietMs = 0;
    return "end";
  }

  /** Forget the current stretch (the floor and boost stay: they describe the room). */
  reset() {
    this.inSpeech = false;
    this.loudMs = 0;
    this.quietMs = 0;
  }

  private follow(r: number, ms: number) {
    if (!this.o.floorFactor) return;
    // Rises slowly (speech must not become "the room"; slower still during speech), falls fast.
    const rise = (this.o.floorRiseMs ?? 4000) * (this.inSpeech ? 4 : 1);
    const span = r > this.floor ? rise : this.o.floorFallMs ?? 300;
    this.floor += (r - this.floor) * Math.min(1, ms / span);
  }
}

/** The last `maxMs` of audio frames (oldest dropped first). */
export class PcmRing {
  private frames: Uint8Array[] = [];
  private ms = 0;
  constructor(private maxMs: number) {}

  push(pcm: Uint8Array) {
    this.frames.push(pcm);
    this.ms += pcmDurationMs(pcm.byteLength);
    while (this.frames.length > 1 && this.ms - pcmDurationMs(this.frames[0].byteLength) >= this.maxMs) {
      this.ms -= pcmDurationMs(this.frames.shift()!.byteLength);
    }
  }

  get durationMs(): number {
    return this.ms;
  }

  /** The frames held, oldest first, and empties the buffer. */
  drain(): Uint8Array[] {
    const out = this.frames;
    this.frames = [];
    this.ms = 0;
    return out;
  }

  clear() {
    this.frames = [];
    this.ms = 0;
  }
}

/**
 * Pure audio helpers for the call screen (live voice): resampling the mic to
 * the wire rate, PCM16 conversion and cutting it into frames. No DOM, no Web
 * Audio: unit-tested in Node.
 */
import { VOICE_SAMPLE_RATE } from "../protocol";

/** Mic audio goes out in frames of this many ms. */
export const FRAME_MS = 40;
/** Samples per frame at the wire rate (960 at 24 kHz). */
export const FRAME_SAMPLES = (VOICE_SAMPLE_RATE * FRAME_MS) / 1000;

/**
 * A streaming linear resampler (mono). Keeps its position and the last input
 * sample between chunks, so chunk borders add no clicks or drift. Going down
 * (48 kHz → 24 kHz) it averages each output's input span first, a cheap
 * low-pass that keeps most aliasing out of speech.
 */
export class LinearResampler {
  readonly ratio: number;
  /** Position of the next output in the virtual input [last, ...chunk] (index 0 = last sample of the previous chunk). */
  private t = 1;
  private last = 0;
  constructor(readonly inRate: number, readonly outRate: number = VOICE_SAMPLE_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error("Sample rates must be positive");
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    if (this.inRate === this.outRate) return input.slice();
    const at = (i: number) => (i === 0 ? this.last : input[i - 1]);
    const out: number[] = [];
    const span = this.ratio > 1 ? this.ratio : 0;
    while (this.t <= n) {
      const idx = Math.floor(this.t);
      const frac = this.t - idx;
      const next = idx + 1 <= n ? at(idx + 1) : at(idx);
      let v = at(idx) * (1 - frac) + next * frac;
      if (span) {
        // Box average over the span this output stands for.
        const from = Math.max(0, Math.ceil(this.t - span / 2));
        const to = Math.min(n, Math.floor(this.t + span / 2));
        if (to > from) {
          let sum = 0;
          for (let i = from; i <= to; i++) sum += at(i);
          v = sum / (to - from + 1);
        }
      }
      out.push(v);
      this.t += this.ratio;
    }
    this.t -= n;
    this.last = input[n - 1];
    return Float32Array.from(out);
  }

  reset() {
    this.t = 1;
    this.last = 0;
  }
}

/** Float samples (-1..1) as PCM16 little-endian bytes (clamped). */
export function floatToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** PCM16 little-endian bytes as float samples (-1..1). An odd last byte is ignored. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Collects resampled audio and hands out whole frames of `size` samples. */
export class FrameChunker {
  private buf: Float32Array;
  private len = 0;
  constructor(readonly size: number = FRAME_SAMPLES) {
    this.buf = new Float32Array(size * 4);
  }
  push(samples: Float32Array): Float32Array[] {
    if (this.len + samples.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + samples.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(samples, this.len);
    this.len += samples.length;
    const frames: Float32Array[] = [];
    let at = 0;
    while (this.len - at >= this.size) {
      frames.push(this.buf.slice(at, at + this.size));
      at += this.size;
    }
    if (at) {
      this.buf.copyWithin(0, at, this.len);
      this.len -= at;
    }
    return frames;
  }
  /** Samples waiting for a whole frame. */
  get pending() {
    return this.len;
  }
  reset() {
    this.len = 0;
  }
}

/** Root mean square of float samples, 0..1. */
export function rmsOf(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** A level for the animated bars: RMS on a soft curve, 0..1. */
export function levelOf(rms: number): number {
  return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, rms)) * 3));
}

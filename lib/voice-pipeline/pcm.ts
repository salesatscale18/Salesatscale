/**
 * PCM16 little-endian mono helpers for the pipeline proof: resampling (the browser's 24 kHz mic audio to the
 * listener's rate; a speech model's other rate to the browser's 24 kHz), framing into the relay's audio frames, and
 * a byte carry for odd-sized chunks. Pure and dependency-free.
 */

/** PCM16 LE bytes as samples (an odd last byte is ignored). */
export function toSamples(pcm: Uint8Array): Int16Array {
  const n = Math.floor(pcm.byteLength / 2);
  const out = new Int16Array(n);
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Samples as PCM16 LE bytes. */
export function toBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return out;
}

/**
 * A streaming linear resampler: chunks of PCM16 at `from` Hz in, PCM16 at `to` Hz out, continuous across chunks
 * (the position and the last sample carry over), so frame boundaries add no clicks. Same rate: passed through.
 */
export class Resampler {
  private pos = 0;
  private last: number | null = null;
  constructor(readonly from: number, readonly to: number) {}

  push(pcm: Uint8Array): Uint8Array {
    if (this.from === this.to) return pcm;
    const input = toSamples(pcm);
    if (!input.length) return new Uint8Array(0);
    // Sample i of the extended input: the carried last sample at -1, then this chunk.
    const at = (i: number) => (i < 0 ? this.last ?? input[0] : input[Math.min(i, input.length - 1)]);
    const step = this.from / this.to;
    const out: number[] = [];
    // `pos` is the next output's position in input samples, relative to this chunk's first sample (may be < 0 by < 1).
    while (this.pos <= input.length - 1) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      out.push(Math.round(at(i) * (1 - f) + at(i + 1) * f));
      this.pos += step;
    }
    this.pos -= input.length;
    this.last = input[input.length - 1];
    return toBytes(Int16Array.from(out));
  }
}

/** One-shot resampling of a whole buffer. */
export function resamplePcm16(pcm: Uint8Array, from: number, to: number): Uint8Array {
  return new Resampler(from, to).push(pcm);
}

/**
 * Re-frames a byte stream into even-length frames of at most `maxBytes`: odd leftovers wait for the next chunk.
 * `push` returns the whole frames ready now; `flush` the rest (even only).
 */
export class PcmFramer {
  private carry = new Uint8Array(0);
  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const all = new Uint8Array(this.carry.byteLength + chunk.byteLength);
    all.set(this.carry, 0);
    all.set(chunk, this.carry.byteLength);
    const usable = all.byteLength - (all.byteLength % 2);
    const frames: Uint8Array[] = [];
    let at = 0;
    while (usable - at >= this.maxBytes) {
      frames.push(all.slice(at, at + this.maxBytes));
      at += this.maxBytes;
    }
    if (usable - at > 0) {
      frames.push(all.slice(at, usable));
      at = usable;
    }
    this.carry = all.slice(at);
    return frames;
  }

  /** Drops an odd leftover byte (it cannot be played). */
  reset() {
    this.carry = new Uint8Array(0);
  }
}

/** Duration of PCM16 mono bytes at `rate`, in ms. */
export const pcmMs = (bytes: number, rate: number) => (Math.floor(bytes / 2) / rate) * 1000;

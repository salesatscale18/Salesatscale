/**
 * Audio integrity, deterministic (no network, no model): a known tone through every path the call's audio takes,
 * in realistic and awkward piece sizes, checked for continuity (no neighbour-sample jumps) and for its frequency.
 * - live, agent: provider audio pieces (base64) → ServerEventMapper → what the browser decodes (pcm16ToFloat);
 * - live, mic: the worklet's 128-sample blocks at 48 kHz → LinearResampler → FrameChunker → floatToPcm16;
 * - recording: the same streams through CallRecorder (24 → 16 kHz, stereo chunks).
 * An odd-length piece shifts every sample of the next piece by one byte wherever PCM16 is read piece by piece:
 * the mapper and the recorder carry the odd byte instead (22 Nov 2026: crackle on the agent channel).
 */
import { describe, expect, it } from "vitest";
import { ServerEventMapper } from "@/lib/voice/gateway-realtime";
import { FrameChunker, floatToPcm16, LinearResampler, pcm16ToFloat } from "@/lib/voice/client/audio";
import { CallRecorder, Downsampler, MemoryRecordingStore, RECORDING_RATE } from "@/lib/voice/recording";
import type { RealtimeEvent } from "@/lib/voice/realtime";

const RATE = 24_000;
const FREQ = 440;
const AMP = 0.5;

/** A 440 Hz tone at half full scale, PCM16 little-endian, at `rate`. */
function tonePcm(seconds: number, rate = RATE): Uint8Array {
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(AMP * 32767 * Math.sin((2 * Math.PI * FREQ * i) / rate)), true);
  return out;
}

/** Cuts bytes into pieces of the given sizes (cycled), each a view with an odd byte offset into a bigger buffer. */
function pieces(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0, k = 0; at < bytes.length; k++) {
    const n = Math.min(sizes[k % sizes.length], bytes.length - at);
    const pool = new Uint8Array(n + 3);
    pool.set(bytes.subarray(at, at + n), 1);
    out.push(pool.subarray(1, 1 + n));
    at += n;
  }
  return out;
}

const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64");

/** Largest |x[i+1] − x[i]| (full scale 1). */
function maxJump(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}
/** The tone's own largest step at this rate (full scale 1), with a margin. */
const toneStep = (rate: number) => AMP * 2 * Math.PI * (FREQ / rate) * 1.25;
/** Frequency from upward zero crossings. */
function frequency(x: ArrayLike<number>, rate: number): number {
  let ups = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) ups++;
  return ups / (x.length / rate);
}
const concatFloats = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Odd and even piece sizes, like a provider that does not cut on sample boundaries. */
const AWKWARD = [961, 1200, 479, 2, 1, 3, 4800, 1023];

describe("live path, agent audio: provider pieces → mapper → what the browser plays", () => {
  const tone = tonePcm(1);
  const mapped = (sizes: number[]) => {
    const m = new ServerEventMapper();
    const out: Uint8Array[] = [];
    for (const p of pieces(tone, sizes)) {
      for (const e of m.map({ type: "audio-delta", responseId: "r1", itemId: "i1", delta: b64(p), raw: null } as never)) if (e.type === "audio") out.push(e.pcm);
    }
    return out;
  };

  it("odd-length pieces come out as whole samples: every piece even, the stream unchanged, the tone continuous", () => {
    const out = mapped(AWKWARD);
    expect(out.every((p) => p.byteLength % 2 === 0)).toBe(true);
    expect(Buffer.concat(out.map((p) => Buffer.from(p)))).toEqual(Buffer.from(tone));
    // The browser decodes each piece on its own (voice-client play → pcm16ToFloat).
    const played = concatFloats(out.map(pcm16ToFloat));
    expect(maxJump(played)).toBeLessThan(toneStep(RATE));
    expect(Math.abs(frequency(played, RATE) - FREQ)).toBeLessThan(3);
  });

  it("without the carry, the same pieces decoded one by one are noise (why the carry exists)", () => {
    const naive = concatFloats(pieces(tone, AWKWARD).map(pcm16ToFloat));
    expect(maxJump(naive)).toBeGreaterThan(0.5);
  });

  it("reports an odd piece and audio of an earlier response arriving after a newer one; a new response drops a half sample", () => {
    const m = new ServerEventMapper();
    const ev = (responseId: string, bytes: number[]) => m.map({ type: "audio-delta", responseId, itemId: "i", delta: b64(Uint8Array.from(bytes)), raw: null } as never);
    const kinds = (es: RealtimeEvent[]) => es.map((e) => (e.type === "diagnostic" ? e.kind : e.type));
    expect(kinds(ev("r1", [1, 2, 3]))).toEqual(["audio-odd-bytes", "audio"]);
    // r2 starts: the carried byte of r1 is not glued to it.
    const r2 = ev("r2", [9, 9]);
    expect(r2.find((e) => e.type === "audio")).toMatchObject({ pcm: Uint8Array.from([9, 9]) });
    expect(kinds(ev("r1", [5, 6]))).toEqual(["audio-interleaved", "audio"]);
  });

  it("OpenAI: audio of a response the buyer cut that arrives after the cut is dropped (reported); the next response plays", () => {
    const m = new ServerEventMapper({ dropCutAudio: true });
    const ev = (e: Record<string, unknown>) => m.map({ raw: null, ...e } as never);
    const audio = (responseId: string) => ev({ type: "audio-delta", responseId, itemId: "i", delta: b64(Uint8Array.from([1, 2])) });
    expect(audio("r1").map((e) => e.type)).toEqual(["audio"]);
    ev({ type: "speech-started" });
    expect(audio("r1")).toEqual([{ type: "diagnostic", kind: "audio-after-cut" }]);
    expect(audio("r2").map((e) => e.type)).toEqual(["audio"]);
    // Gemini (default): unchanged, nothing dropped.
    const g = new ServerEventMapper();
    g.map({ type: "audio-delta", responseId: "r1", itemId: "i", delta: b64(Uint8Array.from([1, 2])), raw: null } as never);
    g.map({ type: "speech-started", raw: null } as never);
    expect(g.map({ type: "audio-delta", responseId: "r1", itemId: "i", delta: b64(Uint8Array.from([1, 2])), raw: null } as never).map((e) => e.type)).toEqual(["audio"]);
  });

  it("an odd byte offset (a view into Node's Buffer pool) decodes the same as a fresh copy", () => {
    const p = pieces(tonePcm(0.05), [2400])[0];
    expect(p.byteOffset % 2).toBe(1);
    expect(pcm16ToFloat(p)).toEqual(pcm16ToFloat(p.slice()));
  });
});

describe("live path, mic: worklet blocks at 48 kHz → resampler → 40 ms frames → PCM16", () => {
  it("is continuous and keeps the frequency", () => {
    const inRate = 48_000;
    const n = inRate;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = AMP * Math.sin((2 * Math.PI * FREQ * i) / inRate);
    const rs = new LinearResampler(inRate, RATE);
    const ch = new FrameChunker();
    const frames: Uint8Array[] = [];
    for (let at = 0; at < n; at += 128) for (const f of ch.push(rs.process(src.subarray(at, at + 128)))) frames.push(floatToPcm16(f));
    expect(frames.every((f) => f.byteLength % 2 === 0)).toBe(true);
    const sent = concatFloats(frames.map(pcm16ToFloat));
    expect(maxJump(sent)).toBeLessThan(toneStep(RATE));
    expect(Math.abs(frequency(sent, RATE) - FREQ)).toBeLessThan(3);
  });
});

describe("recording path: CallRecorder (24 → 16 kHz, left buyer, right agent)", () => {
  it("the downsampler carries an odd byte: awkward pieces give the same output as one piece", () => {
    const tone = tonePcm(0.5);
    const whole = new Downsampler().push(tone);
    const d = new Downsampler();
    const parts = pieces(tone, AWKWARD).map((p) => d.push(p));
    const joined = Int16Array.from(parts.flatMap((p) => [...p]));
    expect(joined).toEqual(whole);
  });

  it("agent audio arriving faster than real time and mic frames in real time are continuous, at the right frequency", async () => {
    const store = new MemoryRecordingStore();
    const rec = new CallRecorder({ store, prefix: "t/" });
    const agent = pieces(tonePcm(2), AWKWARD);
    const mic = pieces(tonePcm(2), [1920]);
    // The agent's 2 s arrive within the first second; the mic sends a 40 ms frame every 40 ms.
    agent.forEach((p, i) => rec.agent(p, (i * 1000) / agent.length));
    mic.forEach((p, i) => rec.buyer(p, 40 * (i + 1)));
    const got = await rec.finish(2_200);
    expect(got.chunks).toBe(1);
    const bytes = store.files.get("t/00001.pcm")!;
    const s = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < s.length; i += 2) {
      left.push(s[i] / 32768);
      right.push(s[i + 1] / 32768);
    }
    // The sounding part of each channel (the edges hold the lead-in silence and the filter's ramp).
    const sounding = (x: number[]) => {
      const first = x.findIndex((v) => Math.abs(v) > 0.05);
      const last = x.length - 1 - [...x].reverse().findIndex((v) => Math.abs(v) > 0.05);
      return x.slice(first + 64, last - 64);
    };
    for (const ch of [sounding(left), sounding(right)]) {
      expect(ch.length).toBeGreaterThan(RECORDING_RATE * 1.5);
      expect(maxJump(ch)).toBeLessThan(toneStep(RECORDING_RATE));
      expect(Math.abs(frequency(ch, RECORDING_RATE) - FREQ)).toBeLessThan(3);
    }
  });
});

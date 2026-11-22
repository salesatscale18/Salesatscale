/**
 * Recording of agent voice calls (owner decision, 22 Nov 2026): both sides of the call as stereo PCM, written as
 * it happens in chunks of about 30 seconds, so a function that dies mid-call still leaves playable audio.
 *
 * - Left channel: the buyer's microphone as the relay received it. Right channel: the agent's audio as the buyer's
 *   browser played it (see CallRecorder). 16 kHz, 16-bit, interleaved little-endian, on the call clock: silence
 *   fills every gap (a muted buyer, a pause, the agent not speaking), so both channels stay aligned.
 * - Chunks: `voice/<production|development>/<accountId>/<sessionId>/00001.pcm` (raw PCM, no header), private,
 *   kept 90 days by the store (RecordingStore). Playback builds a WAV on the fly (lib/voice/recording-playback.ts).
 * - Stores: in memory (tests and scripted calls) and Vercel Blob (lib/voice/recording-blob.ts, the conventions of
 *   lib/sources/blob.ts). Without a token, or on a Preview deployment, recording is off and the row says so.
 * - Keep period: @vercel/blob has no per-blob expiry; the cron deletes chunks past the account's period.
 * Server-only.
 */
import { VOICE_SAMPLE_RATE } from "./protocol";
import { blobRecordingStore } from "./recording-blob";

/** The recording's sample rate (both channels). */
export const RECORDING_RATE = 16_000;
/** Bytes per stereo frame (2 channels × 16 bit). */
export const RECORDING_FRAME_BYTES = 4;
/** Seconds of call per chunk. */
export const RECORDING_CHUNK_SEC = 30;
const CHUNK_FRAMES = RECORDING_RATE * RECORDING_CHUNK_SEC;
/** How long the store keeps a recording when nothing else says (the account's setting sets it per call). */
export const RECORDING_TTL_DAYS = 180;
/** Frames per millisecond of call. */
const FRAMES_PER_MS = RECORDING_RATE / 1000;
/** The browser starts agent audio this long after it arrives when nothing is queued (PlaybackSchedule leadSec, 50 ms). */
const PLAYBACK_LEAD_FRAMES = 50 * FRAMES_PER_MS;

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type RecordingChunkInfo = { path: string; size: number };

/** Where recordings go. Paths are relative (`voice/...`); never a token or a signed URL in them. */
export interface RecordingStore {
  readonly kind: "memory" | "blob";
  /** Writes one chunk (private). `ttlDays`: the period it is kept (deleted by our cron; Blob has no expiry of its own). */
  put(path: string, bytes: Uint8Array, opts?: { ttlDays?: number }): Promise<void>;
  /** The chunks under a folder, in path order, with their sizes. */
  list(prefix: string): Promise<RecordingChunkInfo[]>;
  /** Bytes [start, end) of one chunk. */
  read(path: string, start: number, end: number): Promise<Uint8Array>;
  /** Removes every chunk under a folder. */
  deleteAll(prefix: string): Promise<void>;
}

/** An in-memory store: tests and scripted calls (one per process; lost on restart). */
export class MemoryRecordingStore implements RecordingStore {
  readonly kind = "memory" as const;
  readonly files = new Map<string, Uint8Array>();
  async put(path: string, bytes: Uint8Array, _opts?: { ttlDays?: number }) {
    void _opts; // no expiry in memory
    this.files.set(path, bytes.slice());
  }
  async list(prefix: string) {
    return [...this.files.entries()].filter(([p]) => p.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([path, b]) => ({ path, size: b.byteLength }));
  }
  async read(path: string, start: number, end: number) {
    const b = this.files.get(path);
    if (!b) throw new Error("recording chunk not found");
    return b.slice(start, end);
  }
  async deleteAll(prefix: string) {
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.files.delete(p);
  }
}

let memoryStore: MemoryRecordingStore | null = null;
/** The process's in-memory store (scripted calls play back from it until the server restarts). */
export function memoryRecordingStore(): MemoryRecordingStore {
  memoryStore ??= new MemoryRecordingStore();
  return memoryStore;
}

/** "production" on the production deployment, else "development" (local, tests, scripted). */
export function recordingEnvironment(env: Record<string, string | undefined> = process.env): "production" | "development" {
  return env.VERCEL_ENV === "production" ? "production" : "development";
}

/** The call's recording folder: `voice/<production|development>/<accountId>/<sessionId>/`. */
export function recordingPrefix(accountId: string, sessionId: string, env: Record<string, string | undefined> = process.env): string {
  return `voice/${recordingEnvironment(env)}/${accountId}/${sessionId}/`;
}

/** Chunk `n` (1-based) of a folder: `00001.pcm`. */
export const chunkPath = (prefix: string, n: number) => `${prefix}${String(n).padStart(5, "0")}.pcm`;

/**
 * The store a call records to, or null with the reason (logged, and the row says "off"):
 * - a Preview deployment never writes recordings (it shares the production database);
 * - a scripted call (and tests) records in memory;
 * - a live call needs BLOB_READ_WRITE_TOKEN (Vercel Blob); without it recording is off.
 */
export async function recordingStoreFor(mode: "live" | "scripted", env: Record<string, string | undefined> = process.env): Promise<{ store: RecordingStore | null; reason: string }> {
  if (env.VERCEL_ENV === "preview") return { store: null, reason: "preview deployment (never records)" };
  if (mode === "scripted") return { store: memoryRecordingStore(), reason: "in memory (scripted call)" };
  const store = blobRecordingStore(env);
  return store ? { store, reason: "Vercel Blob" } : { store: null, reason: "no BLOB_READ_WRITE_TOKEN" };
}

/** The store a recording is read back from (playback, delete, expiry), by the session's mode; null when there is none here. */
export async function playbackStoreFor(mode: string, env: Record<string, string | undefined> = process.env): Promise<RecordingStore | null> {
  if (mode === "scripted") return memoryRecordingStore();
  return blobRecordingStore(env);
}

// ---------------------------------------------------------------------------
// 24 kHz → 16 kHz
// ---------------------------------------------------------------------------

/** Half the low-pass kernel's length, in input samples. */
const HALF = 16;
/** Low-pass cutoff: below the 8 kHz Nyquist of the output, with room for the transition band. */
const CUTOFF_HZ = 7_000;

function kernel(d: number): number {
  if (Math.abs(d) >= HALF) return 0;
  const wc = CUTOFF_HZ / VOICE_SAMPLE_RATE;
  const x = 2 * wc * d;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  // Blackman window over [-HALF, HALF].
  const n = (d + HALF) / (2 * HALF);
  const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
  return 2 * wc * sinc * w;
}

/** The two phases of the 3:2 resampler (output at input positions k and k + 0.5), each normalised to unity gain. */
const PHASES: number[][] = [0, 0.5].map((frac) => {
  const taps: number[] = [];
  for (let j = -HALF + 1; j <= HALF; j++) taps.push(kernel(frac - j));
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map((v) => v / sum);
});

/**
 * Streaming 24 kHz → 16 kHz resampler for 16-bit PCM: a windowed-sinc low-pass (7 kHz cutoff, Blackman, 32 taps)
 * evaluated at every 1.5th input sample. Stateful across frames, so frame edges add no clicks.
 */
export class Downsampler {
  private buf: number[] = [];
  /** Absolute input index of buf[0]. */
  private base = 0;
  /** Next output index. */
  private next = 0;

  push(pcm: Uint8Array): Int16Array {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i + 1 < pcm.byteLength; i += 2) this.buf.push(view.getInt16(i, true));
    const out: number[] = [];
    for (;;) {
      const x = this.next * 1.5;
      const k = Math.floor(x);
      if (k + HALF >= this.base + this.buf.length) break;
      const taps = PHASES[x === k ? 0 : 1];
      let acc = 0;
      for (let t = 0; t < taps.length; t++) {
        const j = k - HALF + 1 + t;
        const v = j >= this.base ? this.buf[j - this.base] : 0;
        acc += v * taps[t];
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
      this.next++;
    }
    // Keep only the history the next output needs.
    const keepFrom = Math.floor(this.next * 1.5) - HALF;
    if (keepFrom > this.base) {
      this.buf.splice(0, keepFrom - this.base);
      this.base = keepFrom;
    }
    return Int16Array.from(out);
  }
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

type Chunk = { left: Int16Array; right: Int16Array };

export type RecordingProgress = { chunks: number; bytes: number; sec: number; failed: number };

/**
 * One call's recording, on the call clock (ms since the call connected).
 *
 * The agent side is placed as the browser plays it: the browser schedules each piece of agent audio back to back,
 * starting when it arrives (lib/voice/client/playback.ts), and drops what is still queued when the engine sends
 * `flush` (a barge-in or typed text). The relay receives agent audio faster than real time, so each piece goes at
 * max(arrival, end of the previous piece), and `cut(at)` removes what was scheduled after `at`: what the buyer never
 * heard is not in the recording. This is the server's estimate (there are no playback acks from the browser):
 * network delay and the browser's output latency are not counted.
 *
 * A chunk is written once the call clock has passed its end (nothing can be cut from it any more); the last,
 * shorter chunk at the end of the call. Writes go one at a time, in order.
 */
export class CallRecorder {
  private readonly chunks = new Map<number, Chunk>();
  private readonly buyerIn = new Downsampler();
  private readonly agentIn = new Downsampler();
  private buyerCursor = 0;
  private agentCursor = 0;
  /** Chunks before this index were written (or handed to the store). */
  private committed = 0;
  private writes: Promise<void> = Promise.resolve();
  private progress: RecordingProgress = { chunks: 0, bytes: 0, sec: 0, failed: 0 };
  private done = false;

  /** `ttlDays`: the store deletes each chunk after this many days; 0: kept until someone deletes it. */
  constructor(private readonly o: { store: RecordingStore; prefix: string; ttlDays?: number; onError?: (e: unknown) => void }) {}

  /** The buyer's microphone audio (24 kHz PCM16) that arrived at `atMs`. */
  buyer(pcm: Uint8Array, atMs: number) {
    if (this.done) return;
    const s = this.buyerIn.push(pcm);
    if (!s.length) return;
    const end = this.frameAt(atMs);
    // Real-time audio: contiguous unless there was a gap (a muted mic, dropped frames), which stays silent.
    const start = end - s.length > this.buyerCursor + 160 ? end - s.length : this.buyerCursor;
    this.write("left", start, s);
    this.buyerCursor = start + s.length;
    this.tick(atMs);
  }

  /** Agent audio (24 kHz PCM16) that arrived at `atMs`: it plays after what is already scheduled. */
  agent(pcm: Uint8Array, atMs: number) {
    if (this.done) return;
    const s = this.agentIn.push(pcm);
    if (!s.length) return;
    // As the browser's schedule (PlaybackSchedule): right after the queued audio, or after a short lead when idle.
    const now = this.frameAt(atMs);
    const start = this.agentCursor > now ? this.agentCursor : now + PLAYBACK_LEAD_FRAMES;
    this.write("right", start, s);
    this.agentCursor = start + s.length;
    this.tick(atMs);
  }

  /** The browser dropped the agent audio still queued at `atMs` (a barge-in): it was never heard. */
  cut(atMs: number) {
    const at = this.frameAt(atMs);
    if (this.agentCursor <= at) return;
    for (let f = Math.max(at, this.committed * CHUNK_FRAMES); f < this.agentCursor; f++) {
      const c = this.chunks.get(Math.floor(f / CHUNK_FRAMES));
      if (c) c.right[f % CHUNK_FRAMES] = 0;
    }
    this.agentCursor = at;
  }

  /** Writes every chunk the call clock has passed. */
  tick(atMs: number) {
    if (this.done) return;
    const now = this.frameAt(atMs);
    while ((this.committed + 1) * CHUNK_FRAMES <= now) this.commit(this.committed, CHUNK_FRAMES);
  }

  /** The chunks stored so far (for the session row's heartbeat). */
  get stored(): RecordingProgress {
    return { ...this.progress };
  }

  /**
   * The end of the call at `atMs`: the last chunk (agent audio scheduled after the end was never played), then
   * waits for the writes. Never throws.
   */
  async finish(atMs: number): Promise<RecordingProgress> {
    if (!this.done) {
      this.tick(atMs);
      this.done = true;
      const end = this.frameAt(atMs);
      const rest = end - this.committed * CHUNK_FRAMES;
      if (rest > 0) this.commit(this.committed, rest);
    }
    await this.writes;
    return this.stored;
  }

  private frameAt(ms: number) {
    return Math.max(0, Math.round(ms * FRAMES_PER_MS));
  }

  private write(side: "left" | "right", start: number, s: Int16Array) {
    for (let i = 0; i < s.length; i++) {
      const f = start + i;
      const k = Math.floor(f / CHUNK_FRAMES);
      if (k < this.committed) continue; // already written: too late for this chunk
      let c = this.chunks.get(k);
      if (!c) {
        c = { left: new Int16Array(CHUNK_FRAMES), right: new Int16Array(CHUNK_FRAMES) };
        this.chunks.set(k, c);
      }
      c[side][f % CHUNK_FRAMES] = s[i];
    }
  }

  private commit(k: number, frames: number) {
    const c = this.chunks.get(k);
    this.chunks.delete(k);
    this.committed = k + 1;
    const bytes = new Uint8Array(frames * RECORDING_FRAME_BYTES);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < frames; i++) {
      view.setInt16(i * 4, c ? c.left[i] : 0, true);
      view.setInt16(i * 4 + 2, c ? c.right[i] : 0, true);
    }
    const path = chunkPath(this.o.prefix, k + 1);
    const secEnd = (k * CHUNK_FRAMES + frames) / RECORDING_RATE;
    this.writes = this.writes.then(async () => {
      try {
        const ttl = this.o.ttlDays ?? RECORDING_TTL_DAYS;
        await this.o.store.put(path, bytes, ttl > 0 ? { ttlDays: ttl } : {});
        this.progress = { ...this.progress, chunks: this.progress.chunks + 1, bytes: this.progress.bytes + bytes.byteLength, sec: Math.round(secEnd) };
      } catch (e) {
        this.progress = { ...this.progress, failed: this.progress.failed + 1 };
        this.o.onError?.(e);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/** The 44-byte header of a 16 kHz, 16-bit stereo WAV holding `dataBytes` of PCM. */
export function wavHeader(dataBytes: number): Uint8Array {
  const h = new Uint8Array(44);
  const v = new DataView(h.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo: left buyer, right agent
  v.setUint32(24, RECORDING_RATE, true);
  v.setUint32(28, RECORDING_RATE * RECORDING_FRAME_BYTES, true);
  v.setUint16(32, RECORDING_FRAME_BYTES, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return h;
}

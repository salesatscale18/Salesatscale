/**
 * Call recordings (lib/voice/recording.ts, recording-playback.ts, recording-settings.ts): the 24 → 16 kHz
 * resampler, the recorder's alignment (agent audio as played, cut at a barge-in), chunking, the WAV header and
 * Range, the store choice, the settings defaults and the notice. Pure; an in-memory store.
 */
import { describe, expect, it } from "vitest";
import {
  CallRecorder, chunkPath, Downsampler, MemoryRecordingStore, RECORDING_CHUNK_SEC, RECORDING_RATE, recordingPrefix, recordingStoreFor, wavHeader,
} from "@/lib/voice/recording";
import { parseRange, wavResponse } from "@/lib/voice/recording-playback";
import { RECORDING_NOTICE, recordingNoticeText, resolveRecordingSettings, withRecordingNotice } from "@/lib/voice/recording-settings";
import { VOICE_SAMPLE_RATE } from "@/lib/voice/protocol";

/** `ms` of a sine at `hz` (24 kHz PCM16), amplitude `amp` (0..1). */
function sine(ms: number, hz: number, amp = 0.5): Uint8Array {
  const n = Math.round((VOICE_SAMPLE_RATE * ms) / 1000);
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / VOICE_SAMPLE_RATE) * amp * 32767), true);
  return out;
}
const rms = (s: ArrayLike<number>) => Math.sqrt(Array.from(s).reduce((a, x) => a + x * x, 0) / Math.max(1, s.length)) / 32768;

/** One channel of interleaved stereo PCM (0 = left/buyer, 1 = right/agent), frames [from, to) in ms. */
function channel(pcm: Uint8Array, ch: 0 | 1, fromMs: number, toMs: number): number[] {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out: number[] = [];
  const a = Math.round((fromMs * RECORDING_RATE) / 1000);
  const b = Math.min(pcm.byteLength / 4, Math.round((toMs * RECORDING_RATE) / 1000));
  for (let f = a; f < b; f++) out.push(v.getInt16(f * 4 + ch * 2, true));
  return out;
}

describe("24 kHz to 16 kHz", () => {
  it("keeps speech-band audio, removes what would alias, and has no seams between frames", () => {
    const d = new Downsampler();
    const pieces: Int16Array[] = [];
    const tone = sine(1000, 1000);
    for (let at = 0; at < tone.byteLength; at += 960) pieces.push(d.push(tone.subarray(at, at + 960)));
    const out = Int16Array.from(pieces.flatMap((p) => Array.from(p)));
    expect(Math.abs(out.length - 16_000)).toBeLessThan(40);
    // A 1 kHz tone keeps its level (0.5 amplitude → RMS ≈ 0.354).
    expect(rms(out.slice(100, -100))).toBeGreaterThan(0.34);
    expect(rms(out.slice(100, -100))).toBeLessThan(0.37);
    // 10 kHz is above the output's 8 kHz Nyquist: filtered out (more than 30 dB down), not folded to 6 kHz.
    const hi = new Downsampler().push(sine(1000, 10_000));
    expect(rms(hi.slice(100, -100))).toBeLessThan(0.354 * 0.032);
  });
});

describe("the recorder", () => {
  it("agent audio as played: queued after what plays, cut at a barge-in; the buyer on the left; silence elsewhere", async () => {
    const store = new MemoryRecordingStore();
    const rec = new CallRecorder({ store, prefix: "voice/development/a/s/" });
    // 2 s of agent audio arrives at once at 1.0 s (faster than real time): it plays from 1.05 s to 3.05 s.
    rec.agent(sine(2_000, 440), 1_000);
    // The buyer speaks from 1.5 s to 2.0 s (real time, 100 ms frames) and cuts the agent in at 2.0 s.
    for (let t = 1_600; t <= 2_000; t += 100) rec.buyer(sine(100, 300), t);
    rec.cut(2_000);
    const p = await rec.finish(4_000);
    expect(p).toMatchObject({ chunks: 1, bytes: 4 * RECORDING_RATE * 4, sec: 4, failed: 0 });
    const pcm = store.files.get(chunkPath("voice/development/a/s/", 1))!;
    expect(rms(channel(pcm, 1, 0, 1_000))).toBe(0);
    expect(rms(channel(pcm, 1, 1_100, 1_950))).toBeGreaterThan(0.3);
    // What the buyer never heard (after the cut) is not in the recording.
    expect(rms(channel(pcm, 1, 2_010, 4_000))).toBe(0);
    expect(rms(channel(pcm, 0, 1_520, 1_990))).toBeGreaterThan(0.3);
    expect(rms(channel(pcm, 0, 0, 1_480))).toBe(0);
    expect(rms(channel(pcm, 0, 2_050, 4_000))).toBe(0);
  });

  it("writes a chunk every 30 s while the call runs (a function that dies keeps them), the last shorter one at the end", async () => {
    const store = new MemoryRecordingStore();
    const prefix = "voice/development/a/s2/";
    const rec = new CallRecorder({ store, prefix });
    for (let t = 100; t <= 65_000; t += 100) rec.buyer(sine(100, 300, 0.1), t);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Mid-call: two whole chunks are stored already.
    expect((await store.list(prefix)).map((c) => [c.path, c.size])).toEqual([
      [chunkPath(prefix, 1), RECORDING_CHUNK_SEC * RECORDING_RATE * 4], [chunkPath(prefix, 2), RECORDING_CHUNK_SEC * RECORDING_RATE * 4],
    ]);
    expect(rec.stored).toMatchObject({ chunks: 2, sec: 60 });
    const end = await rec.finish(70_000);
    expect(end).toMatchObject({ chunks: 3, sec: 70 });
    expect((await store.list(prefix))[2].size).toBe(10 * RECORDING_RATE * 4);
  });

  it("a chunk that cannot be written is counted as failed; the others are kept", async () => {
    let n = 0;
    const store = new MemoryRecordingStore();
    const flaky = { ...store, kind: "memory" as const, list: store.list.bind(store), read: store.read.bind(store), deleteAll: store.deleteAll.bind(store), put: async (p: string, b: Uint8Array) => { if (n++ === 0) throw new Error("down"); await store.put(p, b); } };
    const errors: unknown[] = [];
    const rec = new CallRecorder({ store: flaky, prefix: "x/", onError: (e) => errors.push(e) });
    rec.buyer(sine(100, 300), 100);
    expect(await rec.finish(61_000)).toMatchObject({ chunks: 2, failed: 1 });
    expect(errors).toHaveLength(1);
  });
});

describe("the WAV and Range", () => {
  it("a 44-byte header for 16 kHz stereo PCM", () => {
    const h = new DataView(wavHeader(64_000).buffer);
    expect(String.fromCharCode(...wavHeader(0).slice(0, 4))).toBe("RIFF");
    expect(h.getUint32(4, true)).toBe(36 + 64_000);
    expect(h.getUint16(22, true)).toBe(2);
    expect(h.getUint32(24, true)).toBe(16_000);
    expect(h.getUint32(40, true)).toBe(64_000);
  });

  it("ranges: start-end, open end, suffix, and impossible ones", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });

  it("the WAV across chunks: whole file, a range spanning header and two chunks, and 416", async () => {
    const store = new MemoryRecordingStore();
    await store.put("p/00001.pcm", Uint8Array.from({ length: 8 }, (_, i) => i + 1));
    await store.put("p/00002.pcm", Uint8Array.from({ length: 8 }, (_, i) => i + 11));
    const chunks = await store.list("p/");
    const whole = wavResponse(store, chunks, null);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("cache-control")).toBe("private, no-store");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    const all = new Uint8Array(await whole.arrayBuffer());
    expect(all.byteLength).toBe(44 + 16);
    expect(Array.from(all.slice(44))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18]);
    const part = wavResponse(store, chunks, "bytes=40-53");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 40-53/60");
    expect(Array.from(new Uint8Array(await part.arrayBuffer()))).toEqual([...Array.from(all.slice(40, 44)), 1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
    expect(wavResponse(store, chunks, "bytes=60-").status).toBe(416);
  });
});

describe("where a call records", () => {
  it("scripted calls in memory; a live call needs the token; Preview never records; a missing package is off", async () => {
    expect((await recordingStoreFor("scripted", {})).store?.kind).toBe("memory");
    expect(await recordingStoreFor("live", {})).toEqual({ store: null, reason: "no BLOB_READ_WRITE_TOKEN" });
    expect(await recordingStoreFor("live", { VERCEL_ENV: "preview", BLOB_READ_WRITE_TOKEN: "t" })).toEqual({ store: null, reason: "preview deployment (never records)" });
    expect(await recordingStoreFor("scripted", { VERCEL_ENV: "preview" })).toMatchObject({ store: null });
    // With the token: the Vercel Blob store (nothing is written here).
    const blob = await recordingStoreFor("live", { BLOB_READ_WRITE_TOKEN: "t" });
    expect(blob.reason).toBe("Vercel Blob");
    expect(blob.store?.kind).toBe("blob");
    expect(recordingPrefix("acc", "sid", { VERCEL_ENV: "production" })).toBe("voice/production/acc/sid/");
    expect(recordingPrefix("acc", "sid", {})).toBe("voice/development/acc/sid/");
    expect(chunkPath("voice/production/acc/sid/", 1)).toBe("voice/production/acc/sid/00001.pcm");
  });
});

describe("settings and the notice", () => {
  it("both switches default on; only an explicit false turns one off", () => {
    expect(resolveRecordingSettings(null)).toEqual({ recordCalls: true, recordingNotice: true, keepDays: 180 });
    expect(resolveRecordingSettings({ recordCalls: false })).toEqual({ recordCalls: false, recordingNotice: true, keepDays: 180 });
    expect(resolveRecordingSettings({ recordingNotice: false, recordingKeepDays: 365 })).toEqual({ recordCalls: true, recordingNotice: false, keepDays: 365 });
    // 0 = until deleted; only 30, 90, 180, 365 or 0.
    expect(resolveRecordingSettings({ recordingKeepDays: 0 }).keepDays).toBe(0);
    expect(resolveRecordingSettings({ recordingKeepDays: 7 }).keepDays).toBe(180);
  });

  it("the notice: owner wording; after the greeting and introduction on a new call, first on a pick-up; named language otherwise", () => {
    expect(RECORDING_NOTICE).toEqual({ en: "Some calls may be recorded for quality review.", he: "חלק מהשיחות עשויות להיות מוקלטות לבקרת איכות." });
    expect(recordingNoticeText("he")).toBe(RECORDING_NOTICE.he);
    expect(recordingNoticeText("fr")).toBe(RECORDING_NOTICE.en);
    const opener = withRecordingNotice('The call has just connected. Say your opening line now, in your own voice: "Hi Dana, this is Maya from Polar. You asked about sensors. How many sites do you have?"', RECORDING_NOTICE.en, { position: "opener" });
    expect(opener).toContain(`"Hi Dana, this is Maya from Polar. ${RECORDING_NOTICE.en} You asked about sensors. How many sites do you have?"`);
    // The notice is in the line itself; no sentence about the notice, the recording or other answers.
    expect(opener.endsWith('?" Say all of it.')).toBe(true);
    expect(opener).not.toMatch(/recording notice|answer for when|nothing else about/);
    const pickup = withRecordingNotice('The call has just connected; the buyer switched the chat to voice. … say: "I\'m here, go ahead."', RECORDING_NOTICE.en, { position: "pickup" });
    expect(pickup).toContain(`"${RECORDING_NOTICE.en} I'm here, go ahead."`);
    expect(withRecordingNotice('Say it: "Bonjour, ici Maya. Combien de sites?"', RECORDING_NOTICE.en, { position: "opener", languageName: "French" })).toMatch(/Say the recording notice in French\.$/);
    expect(withRecordingNotice("Say hello.", RECORDING_NOTICE.en, { position: "pickup" })).toBe(`Say hello. Start with: "${RECORDING_NOTICE.en}"`);
  });
});

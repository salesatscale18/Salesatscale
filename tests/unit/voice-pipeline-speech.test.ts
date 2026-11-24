/**
 * The pipeline's speaking side, free fakes only (B1, the first live call: "The ElevenLabs text-to-speech WebSocket
 * does not serve eleven_v4_turbo. Set providerOptions.elevenlabs.dialogue …" on every turn):
 * - the speak attempts (models.ts): their order, modes and rates, and the dialogue provider options' shape;
 * - SpeakerChain: the first attempt with audio is kept for the call; a failed attempt is logged with the provider's
 *   message and the next one says the SAME text at once; English-only attempts are skipped on a Hebrew call; when
 *   every attempt fails it is logged once and later texts fail at once (nothing more logged);
 * - AudioPipe (the listener's per-utterance audio): queued while the stream connects, at most 2 s, then audio-done.
 */
import { describe, expect, it } from "vitest";
import {
  attemptSkipped, PIPELINE_SPEAK_ATTEMPTS, PIPELINE_SPEAK_MODEL, pipelineCostMicros, PIPELINE_LISTEN_MODEL, SPEAK_MICROS_PER_CHAR, speakModeName,
} from "@/lib/voice-pipeline/models";
import { ScriptedSpeaker, SpeakerChain, SpeechUnavailable, type ChainLink, type Speaker } from "@/lib/voice-pipeline/speaker";
import { AudioPipe, LISTEN_REPLAY_MS, speakProviderOptions } from "@/lib/voice-pipeline/gateway";
import { retryLineFor, RETRY_LINE } from "@/lib/voice-pipeline/engine";

const DIALOGUE_REFUSAL = "The ElevenLabs text-to-speech WebSocket does not serve eleven_v4_turbo. Set providerOptions.elevenlabs.dialogue to stream it as dialogue.";

async function collect(it: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of it) n += c.byteLength;
  return n;
}

function chain(fails: Record<number, string | true>) {
  const speakers = PIPELINE_SPEAK_ATTEMPTS.map((a, i) => {
    const f = fails[i];
    return new ScriptedSpeaker(a.model, { msPerChar: 2, maxMs: 200, chunkMs: 100, ...(f === true ? { maxMs: 0 } : f ? { failWith: f } : {}) });
  });
  const links: ChainLink[] = PIPELINE_SPEAK_ATTEMPTS.map((a, i) => ({ ...a, speaker: speakers[i] }));
  const logs: string[] = [];
  const c = new SpeakerChain(links);
  c.setLog((level, line) => logs.push(`${level} ${line}`));
  return { c, speakers, logs };
}

describe("the speak attempts", () => {
  it("in order: v4-turbo dialogue, v3-conversational without and with dialogue, flash v2.5 (English only), multilingual v2", () => {
    expect(PIPELINE_SPEAK_ATTEMPTS.map((a) => `${a.model} ${speakModeName(a)}${a.englishOnly ? " en" : ""}`)).toEqual([
      "elevenlabs/eleven-v4-turbo dialogue",
      "elevenlabs/eleven-v3-conversational speech",
      "elevenlabs/eleven-v3-conversational dialogue",
      "elevenlabs/eleven-flash-v2.5 speech en",
      "elevenlabs/eleven-multilingual-v2 speech",
    ]);
    expect(PIPELINE_SPEAK_MODEL).toBe("elevenlabs/eleven-v4-turbo");
    expect(attemptSkipped(PIPELINE_SPEAK_ATTEMPTS[3], "he")).toBe(true);
    expect(attemptSkipped(PIPELINE_SPEAK_ATTEMPTS[3], "en")).toBe(false);
    expect(attemptSkipped(PIPELINE_SPEAK_ATTEMPTS[4], "he")).toBe(false);
  });

  it("rates: $0.04 per 1,000 characters, multilingual v2 $0.08; every attempt is priced", () => {
    expect(SPEAK_MICROS_PER_CHAR).toMatchObject({
      "elevenlabs/eleven-v4-turbo": 40, "elevenlabs/eleven-v3-conversational": 40, "elevenlabs/eleven-flash-v2.5": 40, "elevenlabs/eleven-multilingual-v2": 80,
    });
    for (const a of PIPELINE_SPEAK_ATTEMPTS) expect(pipelineCostMicros(PIPELINE_LISTEN_MODEL, 0, a.model, 1_000).known).toBe(true);
    expect(pipelineCostMicros(PIPELINE_LISTEN_MODEL, 0, "elevenlabs/eleven-multilingual-v2", 1_000).speak).toBe(80_000);
  });

  it("dialogue mode: providerOptions.elevenlabs.dialogue.voices holds the call's one voice (@ai-sdk/elevenlabs shape)", () => {
    expect(speakProviderOptions("21m00Tcm4TlvDq8ikWAM")).toEqual({ elevenlabs: { dialogue: { voices: ["21m00Tcm4TlvDq8ikWAM"] } } });
  });

  it("the retry line after a failed turn, in the call's language", () => {
    expect(retryLineFor("en")).toBe("Sorry, could you say that again?");
    expect(retryLineFor("he")).toBe("סליחה, אפשר לחזור על זה?");
    expect(retryLineFor("he-IL")).toBe(RETRY_LINE.he);
  });
});

describe("SpeakerChain", () => {
  it("the first attempt fails: logged with the provider's message, the next says the same text, and is kept for the call", async () => {
    const { c, speakers, logs } = chain({ 0: DIALOGUE_REFUSAL });
    expect(c.modelId).toBe("elevenlabs/eleven-v4-turbo");
    expect(await collect(c.speak("Hello there.", { language: "en" }))).toBeGreaterThan(0);
    expect(speakers[0].said.map((x) => x.text)).toEqual(["Hello there."]);
    expect(speakers[1].said.map((x) => x.text)).toEqual(["Hello there."]);
    expect(c.modelId).toBe("elevenlabs/eleven-v3-conversational");
    expect(c.mode).toBe("speech");
    expect(logs).toEqual([
      `warn pipeline speech attempt failed (elevenlabs/eleven-v4-turbo dialogue): ${DIALOGUE_REFUSAL}; trying the next`,
      "info pipeline speech using elevenlabs/eleven-v3-conversational speech (after 1 failed)",
    ]);
    // Kept: the next text goes straight to it; the failed one is not tried again.
    expect(await collect(c.speak("Second line.", { language: "en" }))).toBeGreaterThan(0);
    expect(speakers[0].said).toHaveLength(1);
    expect(speakers[1].said.map((x) => x.text)).toEqual(["Hello there.", "Second line."]);
    expect(logs).toHaveLength(2);
  });

  it("the first attempt works: kept at once; a stream without audio counts as a failure", async () => {
    const ok = chain({});
    await collect(ok.c.speak("Hi.", { language: "en" }));
    expect(ok.logs).toEqual(["info pipeline speech using elevenlabs/eleven-v4-turbo dialogue"]);
    const silent = chain({ 0: true });
    await collect(silent.c.speak("Hi.", { language: "en" }));
    expect(silent.logs[0]).toContain("the stream ended without audio");
    expect(silent.c.modelId).toBe("elevenlabs/eleven-v3-conversational");
  });

  it("a Hebrew call skips the English-only attempt", async () => {
    const { c, speakers, logs } = chain({ 0: "x", 1: "y", 2: "z" });
    await collect(c.speak("שלום", { language: "he" }));
    expect(speakers[3].said).toHaveLength(0);
    expect(speakers[4].said.map((x) => x.text)).toEqual(["שלום"]);
    expect(c.modelId).toBe("elevenlabs/eleven-multilingual-v2");
    expect(logs.some((l) => l.includes("skipping elevenlabs/eleven-flash-v2.5 speech: English only"))).toBe(true);
  });

  it("every attempt fails: logged once, the text is not said, later texts fail at once without more logs", async () => {
    const { c, speakers, logs } = chain({ 0: "a", 1: "b", 2: "c", 3: "d", 4: "e" });
    await expect(collect(c.speak("Hello.", { language: "en" }))).rejects.toBeInstanceOf(SpeechUnavailable);
    const unavailable = logs.filter((l) => l.includes("pipeline speech unavailable: every speech model failed"));
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toContain("elevenlabs/eleven-v4-turbo dialogue: a");
    const n = logs.length;
    await expect(collect(c.speak("Again.", { language: "en" }))).rejects.toMatchObject({ alreadyLogged: true });
    expect(logs).toHaveLength(n);
    expect(speakers.every((s) => s.said.length === 1)).toBe(true);
  });

  it("a second text while the choice is made waits for it, then uses the model kept (the next sentence, prefetched)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Speaker = new ScriptedSpeaker("elevenlabs/eleven-v4-turbo", { failWith: undefined, delay: () => gate });
    const second = new ScriptedSpeaker("elevenlabs/eleven-v3-conversational");
    const c = new SpeakerChain([{ ...PIPELINE_SPEAK_ATTEMPTS[0], speaker: slow }, { ...PIPELINE_SPEAK_ATTEMPTS[1], speaker: second }]);
    const a = collect(c.speak("One.", { language: "en" }));
    const b = collect(c.speak("Two.", { language: "en" }));
    release();
    expect(await a).toBeGreaterThan(0);
    expect(await b).toBeGreaterThan(0);
    expect((slow as ScriptedSpeaker).said.map((x) => x.text)).toEqual(["One.", "Two."]);
    expect(second.said).toHaveLength(0);
  });

  it("a cancel during the choice ends it without a choice; the next text tries again from the top", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = new ScriptedSpeaker("elevenlabs/eleven-v4-turbo", { delay: () => gate });
    const c = new SpeakerChain([{ ...PIPELINE_SPEAK_ATTEMPTS[0], speaker: first }, { ...PIPELINE_SPEAK_ATTEMPTS[1], speaker: new ScriptedSpeaker("elevenlabs/eleven-v3-conversational") }]);
    const a = collect(c.speak("One.", { language: "en" }));
    c.cancel();
    release();
    expect(await a).toBe(0);
    expect(c.mode).toBeNull();
    expect(await collect(c.speak("Two.", { language: "en" }))).toBeGreaterThan(0);
    expect(c.modelId).toBe("elevenlabs/eleven-v4-turbo");
  });
});

describe("AudioPipe (one transcription stream's audio)", () => {
  it("queues while the stream connects (at most 2 s, the oldest dropped), then reads in order and ends with audio-done", async () => {
    const max = (16_000 * 2 * LISTEN_REPLAY_MS) / 1000;
    const pipe = new AudioPipe(max);
    const chunk = (v: number) => new Uint8Array(16_000 * 2 * 0.5).fill(v); // 500 ms each
    for (let v = 1; v <= 6; v++) pipe.push(chunk(v));
    expect(pipe.queuedBytes).toBe(max);
    expect(pipe.dropped).toBe(2 * chunk(0).byteLength);
    pipe.end();
    const got: number[] = [];
    for await (const c of pipe.stream as unknown as AsyncIterable<Uint8Array>) got.push(c[0]);
    expect(got).toEqual([3, 4, 5, 6]);
    pipe.push(chunk(9));
    expect(pipe.queuedBytes).toBe(0);
  });

  it("marks its connect time: the first read by the SDK (the socket open), not the pushes before it", async () => {
    const pipe = new AudioPipe(64_000);
    pipe.push(new Uint8Array(100).fill(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(pipe.firstReadAt).toBeNull();
    const reader = pipe.stream.getReader();
    await reader.read();
    expect(pipe.firstReadAt).toEqual(expect.any(Number));
    reader.releaseLock();
  });
});

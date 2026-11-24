/**
 * The realtime + ElevenLabs engines' pure parts (lib/voice-rt-eleven, the text-output mapping in
 * lib/voice/gateway-realtime.ts): the session config for text output, the mapping of the SDK's text-output events
 * (ai 7.0.177 / @ai-sdk/provider RealtimeModelV4ServerEvent: text-delta, text-done, response-created,
 * function-call-arguments-done, response-done), the speech player (sentences, pacing, cancel), the engine list and
 * the cost. No network.
 */
import { describe, expect, it } from "vitest";
import { ServerEventMapper, toSdkSessionConfig } from "@/lib/voice/gateway-realtime";
import { ManualClock, flushAsync, type RealtimeSessionConfig } from "@/lib/voice/realtime";
import { SpeechPlayer } from "@/lib/voice-rt-eleven/player";
import { rtRealtimeCost, rtSpeakCost } from "@/lib/voice-rt-eleven/cost";
import { rtElevenCallInfo, medianOf } from "@/lib/voice-rt-eleven/summary";
import { rtElevenProfile } from "@/lib/voice-rt-eleven/profile";
import { GUARDED_PROFILE } from "@/lib/voice-guarded/profile";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { RealtimeUsageAccumulator, voiceCallCost } from "@/lib/ai/models";
import {
  ENGINE_ORDER, engineLabelKey, isRetiredEngine, isRtElevenEngine, labEngineChoice, otherEngine, RT_ELEVEN_MODELS, sessionEngine,
} from "@/lib/voice-classic/engine-choice";
import { t } from "@/lib/i18n";

const base: RealtimeSessionConfig = {
  instructions: "Be helpful.", tools: [{ name: "end_call", description: "End.", parameters: { type: "object", properties: {} } }], voice: "marin",
  language: "en", toolBehavior: "blocking", turnTaking: { silenceMs: 500, threshold: 0.5 },
};

/** A normalized SDK server event (the Gateway passes OpenAI's events through in this shape). */
const ev = (e: Record<string, unknown>) => ({ raw: {}, ...e }) as never;

describe("text output: the session config", () => {
  it("outputModalities text, no voice, no output audio format or transcription; input transcription and tuned VAD as for audio", () => {
    const text = toSdkSessionConfig({ ...base, outputModality: "text" }, "openai/gpt-realtime-2.1");
    expect(text.outputModalities).toEqual(["text"]);
    expect(text.voice).toBeUndefined();
    expect(text.outputAudioFormat).toBeUndefined();
    expect(text.outputAudioTranscription).toBeUndefined();
    expect(text.inputAudioFormat).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(text.inputAudioTranscription).toEqual({});
    expect(text.turnDetection).toEqual({ type: "server-vad", threshold: 0.5, silenceDurationMs: 500 });
    expect(text.providerOptions).toBeUndefined();
    // The safe retry keeps text output.
    expect(toSdkSessionConfig({ ...base, outputModality: "text", safe: true }, "openai/gpt-realtime-mini")).toMatchObject({ outputModalities: ["text"] });
    // Audio output unchanged.
    const audio = toSdkSessionConfig(base, "openai/gpt-realtime-2.1");
    expect(audio).toMatchObject({ outputModalities: ["audio"], voice: "marin", outputAudioFormat: { type: "audio/pcm", rate: 24_000 }, outputAudioTranscription: {} });
  });
});

describe("text output: the event mapping", () => {
  it("a response's text goes out once, whole, at its end (no agent transcript); text-done replaces the item's deltas", () => {
    const m = new ServerEventMapper({ textOutput: true });
    expect(m.map(ev({ type: "response-created", responseId: "r1" }))).toEqual([{ type: "response-started" }]);
    expect(m.map(ev({ type: "text-delta", responseId: "r1", itemId: "i1", delta: "Hello" }))).toEqual([]);
    expect(m.map(ev({ type: "text-delta", responseId: "r1", itemId: "i1", delta: " there." }))).toEqual([]);
    expect(m.map(ev({ type: "text-done", responseId: "r1", itemId: "i1", text: "Hello there!" }))).toEqual([]);
    const done = m.map(ev({ type: "response-done", responseId: "r1", status: "completed", usage: { inputTextTokens: 10, outputTextTokens: 5 } }));
    expect(done).toEqual([
      { type: "response-text", text: "Hello there!", toolCalls: 0 },
      { type: "turn-done" },
      { type: "usage", usage: { audioInTokens: 0, audioOutTokens: 0, textInTokens: 10, textOutTokens: 5, cachedInTokens: 0 } },
    ]);
  });

  it("a response with a tool call: the tool call as always, and its text counted with toolCalls (the engine drops it)", () => {
    const m = new ServerEventMapper({ textOutput: true });
    m.map(ev({ type: "response-created", responseId: "r2" }));
    m.map(ev({ type: "text-delta", responseId: "r2", itemId: "i1", delta: "Let me check." }));
    expect(m.map(ev({ type: "function-call-arguments-done", responseId: "r2", itemId: "i2", callId: "c1", name: "check_fit", arguments: "{\"a\":1}" })))
      .toEqual([{ type: "tool-call", callId: "c1", name: "check_fit", args: { a: 1 } }]);
    const done = m.map(ev({ type: "response-done", responseId: "r2", status: "completed" }));
    expect(done).toEqual([{ type: "response-text", text: "Let me check.", toolCalls: 1 }, { type: "turn-done" }]);
    // The next response starts clean.
    m.map(ev({ type: "response-created", responseId: "r3" }));
    m.map(ev({ type: "text-delta", responseId: "r3", itemId: "i3", delta: "It fits." }));
    expect(m.map(ev({ type: "response-done", responseId: "r3", status: "completed" }))[0]).toEqual({ type: "response-text", text: "It fits.", toolCalls: 0 });
  });

  it("a cancelled response is marked interrupted; a barge-in is only speech-started; the buyer's line closes before the answer", () => {
    const m = new ServerEventMapper({ textOutput: true });
    m.map(ev({ type: "transcript-fragment", speaker: "user", delta: "How much", startMs: 0, endMs: 1 }));
    m.map(ev({ type: "response-created", responseId: "r4" }));
    expect(m.map(ev({ type: "text-delta", responseId: "r4", itemId: "i1", delta: "It costs" }))).toEqual([{ type: "buyer-transcript", text: "How much", final: true }]);
    expect(m.map(ev({ type: "speech-started" }))).toEqual([{ type: "speech-started" }]);
    expect(m.map(ev({ type: "response-done", responseId: "r4", status: "cancelled" }))).toEqual([
      { type: "response-text", text: "It costs", toolCalls: 0, interrupted: true }, { type: "turn-done", interrupted: true },
    ]);
  });

  it("defensive: transcript-named text of a text-only response is read as its text (never an agent transcript)", () => {
    const m = new ServerEventMapper({ textOutput: true });
    m.map(ev({ type: "response-created", responseId: "r5" }));
    expect(m.map(ev({ type: "audio-transcript-delta", responseId: "r5", itemId: "i1", delta: "Hi" }))).toEqual([]);
    expect(m.map(ev({ type: "audio-transcript-done", responseId: "r5", itemId: "i1", transcript: "Hi there." }))).toEqual([]);
    expect(m.map(ev({ type: "response-done", responseId: "r5", status: "completed" }))[0]).toEqual({ type: "response-text", text: "Hi there.", toolCalls: 0 });
  });

  it("audio output is unchanged: text-delta is not read there", () => {
    const m = new ServerEventMapper();
    expect(m.map(ev({ type: "text-delta", responseId: "r", itemId: "i", delta: "x" }))).toEqual([{ type: "provider-event", kind: "unknown", name: "text-delta" }]);
    expect(m.map(ev({ type: "response-created", responseId: "r" }))).toEqual([]);
  });
});

describe("the speech player", () => {
  const setup = (o: { msPerChar?: number } = {}) => {
    const clock = new ManualClock(0);
    const speaker = new ScriptedSpeaker("elevenlabs/eleven-v4-turbo", { msPerChar: o.msPerChar ?? 20, maxMs: 2_000 });
    const frames: { at: number; bytes: number; job: number }[] = [];
    let idle = 0;
    let chars = 0;
    const firsts: number[] = [];
    const player = new SpeechPlayer({
      speaker, clock, frameBytes: 4_800, leadMs: 1_000,
      send: (f, j) => void frames.push({ at: clock.now(), bytes: f.byteLength, job: j.id }),
      onFirstAudio: (j) => void firsts.push(j.id), onChars: (n) => void (chars += n), onIdle: () => void idle++,
    });
    const run = (ms: number) => clock.advance(ms, () => flushAsync(3));
    return { clock, speaker, frames, player, run, idle: () => idle, chars: () => chars, firsts };
  };

  it("speaks sentence by sentence in 100 ms frames, at most a second ahead of real time; idle once played out", async () => {
    const p = setup();
    const job = p.player.play("a1", ["First sentence here.", "Second sentence is longer than that."], "en");
    await p.run(0);
    expect(p.speaker.said.map((x) => x.text)).toEqual(["First sentence here.", "Second sentence is longer than that."]);
    expect(p.frames.every((f) => f.bytes <= 4_800)).toBe(true);
    // Only about a second's worth goes out at once.
    expect(p.frames.length).toBeLessThanOrEqual(11);
    expect(p.player.active).toBe(true);
    await p.run(5_000);
    expect(job.state).toBe("done");
    expect(job.sent).toBe(2);
    expect(p.chars()).toBe("First sentence here.".length + "Second sentence is longer than that.".length);
    expect(p.firsts).toEqual([job.id]);
    expect(p.idle()).toBe(1);
    expect(p.player.active).toBe(false);
  });

  it("replies play one after the other; cancel stops at once, drops the queue and reports how far it got", async () => {
    const p = setup({ msPerChar: 40 });
    const a = p.player.play("a1", ["One two three four five six seven.", "Eight nine ten eleven twelve."], "en");
    const b = p.player.play("a2", ["Next reply."], "en");
    await p.run(500);
    expect(p.frames.every((f) => f.job === a.id)).toBe(true);
    const cut = p.player.cancel();
    expect(cut).toBe(a);
    expect(a.state).toBe("cut");
    expect(b.state).toBe("cut");
    expect(a.started).toBeGreaterThanOrEqual(1);
    expect(a.sent).toBeLessThan(2);
    const n = p.frames.length;
    await p.run(5_000);
    expect(p.frames.length).toBe(n);
    expect(p.idle()).toBe(0);
    expect(p.speaker.cancels).toBe(1);
    expect(p.player.active).toBe(false);
  });
});

describe("the engine list", () => {
  it("six options in the owner's order; the pipelines retired but still labelled; rt engines have their own model", () => {
    expect(ENGINE_ORDER).toEqual(["current", "guarded", "guarded_silent", "rt_eleven", "rt_eleven_mini", "classic"]);
    expect(t(engineLabelKey("rt_eleven"))).toBe("GPT-Realtime 2.1 + ElevenLabs (testing)");
    expect(t(engineLabelKey("rt_eleven_mini"))).toBe("GPT-Realtime mini + ElevenLabs (testing)");
    expect(t("lab.voice.engine_help.rt_eleven")).toBe("GPT-Realtime 2.1 listens and decides and answers in text; ElevenLabs speaks. Test lab only.");
    expect(t(engineLabelKey("pipeline"))).toBe("Pipeline: Gemini Flash + ElevenLabs (testing)");
    expect(RT_ELEVEN_MODELS).toEqual({ rt_eleven: "openai/gpt-realtime-2.1", rt_eleven_mini: "openai/gpt-realtime-mini" });
    for (const e of ["pipeline", "pipeline_lite", "pipeline_chat"]) expect(isRetiredEngine(e)).toBe(true);
    for (const e of ["current", "guarded", "rt_eleven", "rt_eleven_mini", "classic"]) expect(isRetiredEngine(e)).toBe(false);
    expect(isRtElevenEngine("rt_eleven_mini")).toBe(true);
    expect(otherEngine("rt_eleven")).toBe("rt_eleven");
    expect(sessionEngine({ engine: "rt_eleven_mini" })).toBe("rt_eleven_mini");
    expect(sessionEngine({ engine: "rt-eleven" })).toBe("current");
  });

  it("platform admins only (anyone else gets Current)", () => {
    const env = { VOICE_REALTIME: "scripted" };
    expect(labEngineChoice({ role: "super_admin" }, "rt_eleven", env)).toBe("rt_eleven");
    expect(labEngineChoice({ role: "user" }, "rt_eleven", env)).toBe("current");
    expect(labEngineChoice({ role: "super_admin" }, "rt_eleven", { VOICE_REALTIME: "off" })).toBe("current");
  });

  it("the profile is exactly guarded's, under its own name", () => {
    const p = rtElevenProfile("rt_eleven");
    expect(p.engine).toBe("rt_eleven");
    expect({ ...p, engine: GUARDED_PROFILE.engine }).toEqual(GUARDED_PROFILE);
  });
});

describe("cost", () => {
  it("the realtime part prices text output; its floor is the listening only (not half the call in audio out)", () => {
    const acc = new RealtimeUsageAccumulator("per_response");
    acc.add({ audioInTokens: 2_500, audioOutTokens: 0, textInTokens: 4_000, textOutTokens: 300, cachedInTokens: 0 });
    const r = rtRealtimeCost("openai/gpt-realtime-2.1", acc, 100);
    // 2,500 × $32/M + 4,000 × $4/M + 300 × $24/M = 80,000 + 16,000 + 7,200 micros; floor: 100 s × 25 tokens × $32/M = 80,000.
    expect(r.costMicros).toBe(103_200);
    expect(r.usage).toMatchObject({ basis: "usage", usageCostMicros: 103_200, durationCostMicros: 80_000 });
    // The audio engines' floor would charge half the call as audio out.
    expect(voiceCallCost("openai/gpt-realtime-2.1", acc, 100).costMicros).toBeGreaterThan(r.costMicros);
    // No usage yet: the floor.
    expect(rtRealtimeCost("openai/gpt-realtime-mini", new RealtimeUsageAccumulator("per_response"), 60)).toMatchObject({ costMicros: 15_000, usage: { basis: "duration", estimated: true } });
  });

  it("speech: characters × the kept model's rate; unknown model counts 0", () => {
    expect(rtSpeakCost("elevenlabs/eleven-v4-turbo", 1_000)).toEqual({ costMicros: 40_000, known: true });
    expect(rtSpeakCost("elevenlabs/eleven-multilingual-v2", 10)).toEqual({ costMicros: 800, known: true });
    expect(rtSpeakCost("scripted", 10)).toEqual({ costMicros: 0, known: false });
  });

  it("the call card's info from the session JSON; medians", () => {
    expect(rtElevenCallInfo({ engine: "guarded" }, {})).toBeNull();
    expect(rtElevenCallInfo({ engine: "rt_eleven", rtEleven: { realtimeModel: "openai/gpt-realtime-2.1", speakModel: "elevenlabs/eleven-v4-turbo" } }, null))
      .toEqual({ realtimeModel: "openai/gpt-realtime-2.1", speakModel: "elevenlabs/eleven-v4-turbo", medianAnswerMs: null, medianThinkMs: null });
    expect(rtElevenCallInfo({ engine: "rt_eleven_mini", rtEleven: { speakModel: "a" } }, { rtEleven: { speakModel: "b", medianAnswerMs: 900 } }))
      .toMatchObject({ speakModel: "b", medianAnswerMs: 900 });
    expect(medianOf([])).toBeNull();
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(3);
  });
});

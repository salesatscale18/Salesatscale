/**
 * The pipeline proof's pure parts (lib/voice-pipeline): the spoken form of a chat reply, the sentence splitter, the
 * turn-taking state machine, PCM conversion and framing, the cost estimate and the card's reading of a session.
 */
import { describe, expect, it } from "vitest";
import { spokenForm, splitSentences } from "@/lib/voice-pipeline/spoken";
import { median, TurnTaking, type BuyerLine } from "@/lib/voice-pipeline/turns";
import { PcmFramer, Resampler, resamplePcm16, toBytes, toSamples } from "@/lib/voice-pipeline/pcm";
import {
  fillerTextFor, LISTEN_MICROS_PER_SEC, listenRateText, PIPELINE_CALL_CONTEXT_LINE, PIPELINE_FILLER, PIPELINE_LISTEN_MODEL, PIPELINE_LISTEN_MODELS, PIPELINE_SPEAK_MODEL, PIPELINE_TIMING,
  pipelineCostMicros, pipelineListenModelChoice, SPEAK_MICROS_PER_CHAR,
} from "@/lib/voice-pipeline/models";
import { pipelineCallInfo, pipelineModelsLabel, thinkModelLabel } from "@/lib/voice-pipeline/summary";
import { PIPELINE_TEXT_MODEL } from "@/lib/voice-pipeline/gateway-llm";
import { ManualListener, ScriptedListener } from "@/lib/voice-pipeline/listener";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";
import { micPcm } from "@/lib/voice/scripted-realtime";

const line = (text: string, typed = false): BuyerLine => ({ text, typed, speechEndAt: 1_000, finalAt: 1_300, startMs: 0 });

describe("spoken form of a chat reply", () => {
  it("strips markdown, list markers, emphasis and emojis; keeps numbers as written", () => {
    const chat = "## Your quote 🎉\n\n- **2 sites** at ₪59 each\n- Setup: 1.5 hours\n\nTotal: ₪318.00 today. Sound good? 👍";
    expect(spokenForm(chat)).toBe("Your quote. 2 sites at ₪59 each. Setup: 1.5 hours. Total: ₪318.00 today. Sound good?");
  });

  it("replaces a bare link with words, keeps a markdown link's label, never says a URL", () => {
    expect(spokenForm("Fill in the form here:\nhttps://app.example.com/f/abc123?x=1")).toBe("Fill in the form here: the link in the chat.");
    expect(spokenForm("See [the order form](https://x.test/f) and sign.")).toBe("See the order form and sign.");
    expect(spokenForm("הטופס כאן: https://x.test/f", "he")).toBe("הטופס כאן: הקישור בצ'אט.");
    expect(spokenForm("Open www.example.com/a now")).not.toMatch(/example/);
  });

  it("drops direction isolates and collapses whitespace; numbered lists lose their markers", () => {
    expect(spokenForm("Hi, I'm ⁨Dana⁩ from ⁨Acme⁩.")).toBe("Hi, I'm Dana from Acme.");
    expect(spokenForm("1. First step\n2) Second step\n\n\n   spaced   out ")).toBe("First step. Second step. spaced out.");
    expect(spokenForm("")).toBe("");
  });
});

describe("sentence splitter", () => {
  it("splits after sentence ends, not inside numbers or abbreviations; joins tiny sentences", () => {
    expect(splitSentences("The total is 1.5 thousand. Does that work for you? Great!")).toEqual(["The total is 1.5 thousand.", "Does that work for you? Great!"]);
    expect(splitSentences("We cover e.g. offices and shops. Mr. Cohen will call.")).toEqual(["We cover e.g. offices and shops.", "Mr. Cohen will call."]);
    expect(splitSentences("Ok. So we have two options here. Which one would you like?")).toEqual(["Ok. So we have two options here.", "Which one would you like?"]);
    expect(splitSentences("Ok. So we have two options here. Which one?")).toEqual(["Ok. So we have two options here. Which one?"]);
    expect(splitSentences("שלום! מה שלומך היום? יש לנו הצעה.")).toEqual(["שלום! מה שלומך היום?", "יש לנו הצעה."]);
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("turn-taking", () => {
  it("final transcript → thinking → speaking → listening", () => {
    const t = new TurnTaking();
    expect(t.commit(line("We have two sites."))).toBe("run");
    expect(t.state).toBe("thinking");
    expect(t.replied(true)).toBeNull();
    expect(t.state).toBe("speaking");
    expect(t.spoken()).toBeNull();
    expect(t.state).toBe("listening");
  });

  it("noise (under 2 characters) is ignored", () => {
    const t = new TurnTaking();
    expect(t.commit(line("a"))).toBe("ignored");
    expect(t.commit(line("  "))).toBe("ignored");
    expect(t.state).toBe("listening");
  });

  it("lines heard while thinking are queued, joined, and become the next turn once the reply is spoken", () => {
    const t = new TurnTaking();
    t.commit(line("How much is it?"));
    expect(t.commit(line("For two sites."))).toBe("queued");
    expect(t.commit(line("Monthly."))).toBe("queued");
    expect(t.queued).toBe(2);
    t.replied(true);
    const next = t.spoken();
    expect(next?.text).toBe("For two sites. Monthly.");
    expect(t.state).toBe("thinking");
    // No reply: the queue (empty) leaves it listening.
    expect(t.replied(false)).toBeNull();
    expect(t.state).toBe("listening");
  });

  it("barge-in while speaking goes back to listening; a typed line while speaking cuts and runs", () => {
    const t = new TurnTaking();
    expect(t.bargeIn()).toBe(false);
    t.commit(line("Hi there."));
    t.replied(true);
    expect(t.bargeIn()).toBe(true);
    expect(t.state).toBe("listening");
    t.commit(line("Hi again."));
    t.replied(true);
    expect(t.commit(line("Stop, a question.", true))).toBe("barge_and_run");
    expect(t.state).toBe("thinking");
    // The opener speaks from listening only.
    const o = new TurnTaking();
    expect(o.speakFirst()).toBe(true);
    expect(o.state).toBe("speaking");
    expect(o.speakFirst()).toBe(false);
  });

  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([300])).toBe(300);
    expect(median([900, 100, 500])).toBe(500);
    expect(median([100, 200, 300, 400])).toBe(250);
  });
});

describe("PCM conversion", () => {
  it("24 kHz to 16 kHz keeps the length ratio and the signal, across chunks without gaps", () => {
    const one = micPcm(1000, true); // 1 s of tone at 24 kHz
    const whole = resamplePcm16(one, 24_000, 16_000);
    expect(whole.byteLength / 2).toBeGreaterThanOrEqual(15_999);
    expect(whole.byteLength / 2).toBeLessThanOrEqual(16_001);
    const r = new Resampler(24_000, 16_000);
    const parts = [one.subarray(0, 9_602), one.subarray(9_602, 30_000), one.subarray(30_000)].map((p) => r.push(p));
    const joined = parts.reduce((n, p) => n + p.byteLength, 0) / 2;
    expect(Math.abs(joined - whole.byteLength / 2)).toBeLessThanOrEqual(1);
    // The same samples as one-shot (continuity across chunk boundaries).
    const a = toSamples(whole);
    const b = toSamples(Uint8Array.from(parts.flatMap((p) => [...p])));
    let maxDiff = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it("16 kHz to 24 kHz (a speech model at another rate), and same rate passes through", () => {
    const src = toBytes(Int16Array.from({ length: 1_600 }, (_, i) => (i % 2 ? 1000 : -1000)));
    expect(resamplePcm16(src, 16_000, 24_000).byteLength / 2).toBeCloseTo(2_400, -1);
    expect(resamplePcm16(src, 24_000, 24_000)).toBe(src);
  });

  it("frames: even length, at most the frame size, an odd byte carried to the next chunk", () => {
    const f = new PcmFramer(4_800);
    const out1 = f.push(new Uint8Array(10_001));
    expect(out1.map((x) => x.byteLength)).toEqual([4_800, 4_800, 400]);
    const out2 = f.push(new Uint8Array(3));
    expect(out2.map((x) => x.byteLength)).toEqual([4]);
    expect(f.push(new Uint8Array(1))).toEqual([]);
  });
});

describe("cost, the card's reading, the fakes", () => {
  it("prices listening per second and speaking per character from the constants", () => {
    const c = pipelineCostMicros(PIPELINE_LISTEN_MODEL, 120, PIPELINE_SPEAK_MODEL, 1_000);
    expect(c).toEqual({ listen: 120 * LISTEN_MICROS_PER_SEC[PIPELINE_LISTEN_MODEL], speak: 1_000 * SPEAK_MICROS_PER_CHAR[PIPELINE_SPEAK_MODEL], known: true });
    // A 2-minute call: $0.018 listening, $0.04 per 1,000 characters spoken.
    expect(c.listen).toBe(18_000);
    expect(c.speak).toBe(40_000);
    expect(pipelineCostMicros("unknown/model", 10, "unknown/voice", 10)).toEqual({ listen: 0, speak: 0, known: false });
  });

  it("reads a pipeline session's models and median for the card; other engines get nothing", () => {
    const info = pipelineCallInfo({ engine: "pipeline", pipeline: { listenModel: "l", thinkModel: "t", speakModel: "s" } }, { pipeline: { medianAnswerMs: 1234 } });
    expect(info).toEqual({ listenModel: "l", thinkModel: "t", speakModel: "s", medianAnswerMs: 1234, medianThinkMs: null, medianRounds: null, medianRoundMs: null });
    // Speaking: the model the call kept (usage, at the end) over the first one tried (settings, at the start).
    expect(pipelineCallInfo({ engine: "pipeline", pipeline: { speakModel: "first" } }, { pipeline: { speakModel: "kept", medianThinkMs: 3_500, medianAnswerMs: null } }))
      .toMatchObject({ speakModel: "kept", medianThinkMs: 3_500, medianAnswerMs: null });
    expect(pipelineCallInfo({ engine: "guarded" }, null)).toBeNull();
    expect(pipelineCallInfo(null, null)).toBeNull();
    expect(pipelineModelsLabel(info!)).toBe("Listen l · think t · speak s");
    expect(pipelineCallInfo({ engine: "pipeline_chat", pipeline: { thinkModel: "claude-sonnet-5-5" } }, null)?.thinkModel).toBe("claude-sonnet-5-5");
  });

  it("the thinking model's label: Gemini Flash and the chat models, as people read them", () => {
    expect(thinkModelLabel("google/gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(thinkModelLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(thinkModelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(thinkModelLabel("scripted")).toBe("Scripted");
    expect(thinkModelLabel("")).toBe("");
  });

  it("the pipeline's own cost is unchanged by Flash thinking: listening + speaking only, thinking never counted here", () => {
    // Thinking (Gemini Flash or the chat model) is priced by the chat turn on its reply row (usage.model); the
    // session's estimate takes only the listen and speak models: the same figures whatever model thinks.
    expect(pipelineCostMicros.length).toBe(4);
    const c = pipelineCostMicros(PIPELINE_LISTEN_MODEL, 60, PIPELINE_SPEAK_MODEL, 500);
    expect(c).toEqual({ listen: 9_000, speak: 20_000, known: true });
    expect(LISTEN_MICROS_PER_SEC).not.toHaveProperty(PIPELINE_TEXT_MODEL);
    expect(SPEAK_MICROS_PER_CHAR).not.toHaveProperty(PIPELINE_TEXT_MODEL);
  });

  it("the scripted listener hears speech with the detector; the scripted speaker stops on cancel", async () => {
    const l = new ScriptedListener();
    const heard: string[] = [];
    l.onPartial((x) => heard.push(`p:${x}`));
    l.onFinal((x) => heard.push(`f:${x}`));
    for (let i = 0; i < 8; i++) l.pushAudio(micPcm(100, true));
    for (let i = 0; i < 9; i++) l.pushAudio(micPcm(100, false));
    expect(heard).toEqual(["p:Scripted buyer", "f:Scripted buyer line 1."]);
    expect(l.audioSec).toBeCloseTo(1.7, 5);
    const m = new ManualListener();
    m.pushAudio(micPcm(500, false));
    expect(m.audioSec).toBe(0.5);

    const s = new ScriptedSpeaker("scripted", { msPerChar: 10, maxMs: 1_000, chunkMs: 100 });
    let chunks = 0;
    for await (const c of s.speak("x".repeat(50), { language: "en" })) {
      expect(c.byteLength).toBe(4_800);
      if (++chunks === 2) s.cancel();
    }
    expect(chunks).toBe(2);
    expect(s.said).toEqual([{ text: "x".repeat(50), language: "en" }]);
  });
});

describe("the speed settings (models.ts)", () => {
  it("line wait 250 ms stable / 800 ms cap from the detector's report; the detector's end silence is 550 ms", () => {
    expect(PIPELINE_TIMING.lineWait).toEqual({ stableMs: 250, capMs: 800 });
    expect(PIPELINE_TIMING.vad.endSilenceMs).toBe(550);
  });

  it("the listening model: VOICE_PIPELINE_LISTEN_MODEL when it is a listed streaming model, else the default", () => {
    expect(pipelineListenModelChoice({})).toEqual({ model: PIPELINE_LISTEN_MODEL, fromEnv: false });
    expect(PIPELINE_LISTEN_MODEL).toBe("google/gemini-3.5-transcribe-live");
    for (const m of ["openai/gpt-transcribe", "spacexai/grok-stt", "elevenlabs/scribe-v2-realtime"]) {
      expect(pipelineListenModelChoice({ VOICE_PIPELINE_LISTEN_MODEL: ` ${m.toUpperCase()} ` })).toEqual({ model: m, fromEnv: true });
    }
    expect(pipelineListenModelChoice({ VOICE_PIPELINE_LISTEN_MODEL: "gpt-transcribe" })).toMatchObject({ model: PIPELINE_LISTEN_MODEL, fromEnv: false, invalid: "not a creator/model id" });
    expect(pipelineListenModelChoice({ VOICE_PIPELINE_LISTEN_MODEL: "openai/gpt-5" }).invalid).toMatch(/not a streaming transcription model/);
    expect(pipelineListenModelChoice({ VOICE_PIPELINE_LISTEN_MODEL: "x/y; rm -rf" }).model).toBe(PIPELINE_LISTEN_MODEL);
    expect(PIPELINE_LISTEN_MODELS).toContain(PIPELINE_LISTEN_MODEL);
  });

  it("listening rates: gpt-transcribe 75, grok-stt 28 micros/s; scribe-v2-realtime unknown (counts 0)", () => {
    expect(LISTEN_MICROS_PER_SEC["openai/gpt-transcribe"]).toBe(75);
    expect(pipelineCostMicros("spacexai/grok-stt", 100, PIPELINE_SPEAK_MODEL, 0)).toEqual({ listen: 2_800, speak: 0, known: true });
    expect(pipelineCostMicros("elevenlabs/scribe-v2-realtime", 100, PIPELINE_SPEAK_MODEL, 0)).toEqual({ listen: 0, speak: 0, known: false });
    expect(listenRateText("elevenlabs/scribe-v2-realtime")).toBe("rate unknown (counts 0)");
    expect(listenRateText("google/gemini-3.5-transcribe-live")).toBe("150 micros/s");
  });

  it("the filler: 2.5 s, one short line per language", () => {
    expect(PIPELINE_FILLER.afterMs).toBe(2_500);
    expect([fillerTextFor("en"), fillerTextFor("he"), fillerTextFor("iw-IL")]).toEqual(["One moment.", "רגע אחד.", "רגע אחד."]);
  });

  it("the call's context line (provisional): one line, under 600 characters", () => {
    expect(PIPELINE_CALL_CONTEXT_LINE).not.toMatch(/[\r\n]/);
    expect(PIPELINE_CALL_CONTEXT_LINE.length).toBeGreaterThan(0);
    expect(PIPELINE_CALL_CONTEXT_LINE.length).toBeLessThan(600);
  });
});

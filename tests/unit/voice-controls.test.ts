/**
 * One Voice settings panel for every model (owner, 25 Nov 2026): the new controls' settings, what each sends to the
 * provider and when. Gemini turn-taking (style, pause, interruptions → Google's automaticActivityDetection), "Turn
 * ending: Smart" (OpenAI semantic VAD with eagerness), "Thinking effort" (OpenAI reasoning.effort), "Protect the
 * opening line" (the engine's; tests/integration/voice-opener-protect.test.ts) and the ElevenLabs speaking rate for the
 * pace. Every new thing is sent on TEST calls only (one *_FOR_BUYER_CALLS constant each, all off) and never in the safe
 * retry; default settings send exactly what they sent before. Pure; no network.
 */
import { describe, expect, it } from "vitest";
import {
  callTurnExtras, DEFAULT_VOICE_SETTINGS, GEMINI_TURN_TAKING_FOR_BUYER_CALLS, geminiActivityDetectionFor, OPENER_PROTECTION_FOR_BUYER_CALLS, openerProtectionFor, resolveVoiceSettings,
  SMART_TURN_END_FOR_BUYER_CALLS, THINKING_EFFORT_FOR_BUYER_CALLS, turnTakingFor, validateVoiceSettings, voiceCapabilities, voiceFormExtras, type ResolvedVoiceSettings,
} from "@/lib/voice/settings";
import { GEMINI_TURN_OPTION, ServerEventMapper, SETUP_RETRY_FIELDS, toSdkSessionConfig } from "@/lib/voice/gateway-realtime";
import { configSummary, geminiTurnLine } from "@/lib/voice/engine";
import { sessionAckSummary } from "@/lib/voice/eleven-realtime";
import type { RealtimeSessionConfig } from "@/lib/voice/realtime";
import { realtimeTools } from "@/lib/voice/tool-schema";
import { ELEVEN_PACE_SPEED_FOR_BUYER_CALLS, elevenSpeedFor } from "@/lib/voice-rt-eleven/catalog";
import { elevenAttempts } from "@/lib/voice-rt-eleven/speaker";
import { speakSpeedOption } from "@/lib/voice-pipeline/gateway";

const GEMINI = "google/gemini-3.8-live";
const GPT = "openai/gpt-realtime-2.1";
const MINI = "openai/gpt-realtime-mini";
const ELEVEN_RT = "elevenlabs/eleven-realtime-v1-mini";
const TURBO = "elevenlabs/eleven-v4-turbo";
const FLASH = "elevenlabs/eleven-flash-v2.5";
const MULTI = "elevenlabs/eleven-multilingual-v2";
const RACHEL = "21m00Tcm4TlvDq8ikWAM";

const s = (o: Partial<ResolvedVoiceSettings> = {}): ResolvedVoiceSettings => ({ ...DEFAULT_VOICE_SETTINGS, ...o });
const cfgFor = (family: "gemini" | "openai", extra: Partial<RealtimeSessionConfig> = {}): RealtimeSessionConfig => ({
  instructions: "x", tools: realtimeTools(family), toolBehavior: "blocking", pace: "normal", language: "he", expectedLanguages: ["he", "en"], scenario: null,
  ...(family === "openai" ? { voice: "alloy", turnTaking: turnTakingFor("balanced", GPT)! } : {}), ...extra,
});

describe("settings: defaults, validation, capabilities", () => {
  it("defaults reproduce today: pause turn ending, default thinking, opener protected (a version that never stored it: on)", () => {
    expect(resolveVoiceSettings(null)).toMatchObject({ turnEnd: "pause", thinking: "default", openerProtected: true });
    expect(resolveVoiceSettings({ voice: "alloy" })).toMatchObject({ turnEnd: "pause", thinking: "default", openerProtected: true });
    expect(resolveVoiceSettings({ turnEnd: "smart", thinking: "high", openerProtected: false } as never)).toMatchObject({ turnEnd: "smart", thinking: "high", openerProtected: false });
    // Junk resolves to the default.
    expect(resolveVoiceSettings({ turnEnd: "x", thinking: "max", openerProtected: "no" } as never)).toMatchObject({ turnEnd: "pause", thinking: "default", openerProtected: true });
  });

  it("validation: only non-default values are stored, each only for a model that has it", () => {
    expect(validateVoiceSettings({ turnEnd: "smart", thinking: "minimal", openerProtected: false }, GPT)).toEqual({ ok: true, value: { turnEnd: "smart", thinking: "minimal", openerProtected: false } });
    expect(validateVoiceSettings({ turnEnd: "pause", thinking: "default", openerProtected: true }, GPT)).toEqual({ ok: true, value: {} });
    // mini: smart turn ending yes, thinking effort no (dropped).
    expect(validateVoiceSettings({ turnEnd: "smart", thinking: "high" }, MINI)).toEqual({ ok: true, value: { turnEnd: "smart" } });
    // Gemini and ElevenLabs Realtime: neither; the opener switch on every model.
    for (const m of [GEMINI, ELEVEN_RT]) expect(validateVoiceSettings({ turnEnd: "smart", thinking: "high", openerProtected: false }, m)).toEqual({ ok: true, value: { openerProtected: false } });
    // A model switch re-checks for the new model.
    expect(validateVoiceSettings({ model: MINI, thinking: "high", turnEnd: "smart" }, GPT)).toEqual({ ok: true, value: { model: MINI, turnEnd: "smart" } });
    const bad = validateVoiceSettings({ turnEnd: "fast", thinking: "max", openerProtected: "on" }, GPT);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["openerProtected", "thinking", "turnEnd"]);
    // Not in the input: the version's "off" is kept; else nothing is stored.
    expect(validateVoiceSettings({}, GPT, { storedOpenerProtected: false })).toEqual({ ok: true, value: { openerProtected: false } });
    expect(validateVoiceSettings({ openerProtected: true }, GPT, { storedOpenerProtected: false })).toEqual({ ok: true, value: {} });
    // Gemini style, pause and interruptions are real settings now.
    expect(validateVoiceSettings({ style: "patient", pauseMs: "800", interrupt: "low" }, GEMINI)).toEqual({ ok: true, value: { style: "patient", pauseMs: 800, interrupt: "low" } });
  });

  it("the form's fields: an unchecked switch posts off (marker field), a form without it keeps the version's", () => {
    const form = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(voiceFormExtras(form({ turnEnd: "smart", thinking: "low", openerProtectedShown: "1", openerProtected: "on" }))).toEqual({ turnEnd: "smart", thinking: "low", openerProtected: true });
    expect(voiceFormExtras(form({ openerProtectedShown: "1" }))).toEqual({ openerProtected: false });
    expect(voiceFormExtras(form({}))).toEqual({});
  });

  it("capabilities: Gemini gets style, pause and interruptions; turn ending on GPT-Realtime; thinking on 2.1 only; the opener switch everywhere", () => {
    expect(voiceCapabilities(GEMINI)).toMatchObject({ style: true, pauseMs: true, interruptSensitivity: true, turnEnd: false, thinking: false, openerProtect: true });
    expect(voiceCapabilities(GPT)).toMatchObject({ style: true, pauseMs: true, interruptSensitivity: true, turnEnd: true, thinking: true, openerProtect: true });
    expect(voiceCapabilities(MINI)).toMatchObject({ turnEnd: true, thinking: false, openerProtect: true });
    expect(voiceCapabilities(ELEVEN_RT)).toMatchObject({ style: false, pauseMs: false, interruptSensitivity: false, turnEnd: false, thinking: false, openerProtect: true });
    // GPT's own server VAD values are unchanged; Gemini still gets none from turnTakingFor.
    expect(turnTakingFor("balanced", GPT)).toEqual({ silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 });
    expect(turnTakingFor("patient", GEMINI)).toBeNull();
  });
});

describe("test calls only: the constants and what a call adds", () => {
  it("every constant is off: buyer calls send exactly what they sent before", () => {
    expect([GEMINI_TURN_TAKING_FOR_BUYER_CALLS, SMART_TURN_END_FOR_BUYER_CALLS, THINKING_EFFORT_FOR_BUYER_CALLS, OPENER_PROTECTION_FOR_BUYER_CALLS, ELEVEN_PACE_SPEED_FOR_BUYER_CALLS]).toEqual([false, false, false, false, false]);
    const all = s({ style: "patient", pauseMs: 800, interrupt: "high", turnEnd: "smart", thinking: "high" });
    for (const m of [GEMINI, GPT, MINI, ELEVEN_RT, "scripted"]) expect(callTurnExtras(all, m, false), m).toEqual({});
    expect(openerProtectionFor(s(), false)).toBe(false);
    // A constant turned on (overridden here) sends it to buyers too.
    expect(callTurnExtras(all, GPT, false, { thinking: true })).toEqual({ reasoningEffort: "high" });
    expect(openerProtectionFor(s(), false, true)).toBe(true);
  });

  it("default settings: nothing new on any model, test calls too; the opener is protected on test calls", () => {
    for (const m of [GEMINI, GPT, MINI, ELEVEN_RT, "scripted"]) expect(callTurnExtras(s(), m, true), m).toEqual({});
    expect(openerProtectionFor(s(), true)).toBe(true);
    expect(openerProtectionFor(s({ openerProtected: false }), true)).toBe(false);
  });

  it("test calls: each model gets only its own block", () => {
    const all = s({ style: "quick", turnEnd: "smart", thinking: "medium", interrupt: "low" });
    expect(callTurnExtras(all, GEMINI, true)).toEqual({ geminiActivity: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW", endOfSpeechSensitivity: "END_SENSITIVITY_HIGH", prefixPaddingMs: 300, silenceDurationMs: 350 } });
    expect(callTurnExtras(all, GPT, true)).toEqual({ semanticVad: { eagerness: "high" }, reasoningEffort: "medium" });
    expect(callTurnExtras(all, MINI, true)).toEqual({ semanticVad: { eagerness: "high" } });
    expect(callTurnExtras(all, ELEVEN_RT, true)).toEqual({});
    expect(callTurnExtras(s({ turnEnd: "smart" }), GPT, true)).toEqual({ semanticVad: { eagerness: "medium" } });
    expect(callTurnExtras(s({ turnEnd: "smart", style: "patient" }), GPT, true)).toEqual({ semanticVad: { eagerness: "low" } });
  });

  it("Gemini's mapping table", () => {
    const g = (o: Partial<ResolvedVoiceSettings>) => geminiActivityDetectionFor(s(o));
    expect(g({})).toBeNull();
    expect(g({ interrupt: "low" })).toEqual({ startOfSpeechSensitivity: "START_SENSITIVITY_LOW", prefixPaddingMs: 300, silenceDurationMs: 600 });
    expect(g({ interrupt: "medium" })).toEqual({ silenceDurationMs: 600 });
    expect(g({ interrupt: "high" })).toEqual({ startOfSpeechSensitivity: "START_SENSITIVITY_HIGH", prefixPaddingMs: 40, silenceDurationMs: 600 });
    expect(g({ style: "patient" })).toEqual({ endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 900 });
    expect(g({ style: "quick" })).toEqual({ endOfSpeechSensitivity: "END_SENSITIVITY_HIGH", silenceDurationMs: 350 });
    expect(g({ pauseMs: 1200 })).toEqual({ silenceDurationMs: 1200 });
    expect(g({ style: "patient", pauseMs: 400, interrupt: "high" })).toEqual({ startOfSpeechSensitivity: "START_SENSITIVITY_HIGH", endOfSpeechSensitivity: "END_SENSITIVITY_LOW", prefixPaddingMs: 40, silenceDurationMs: 400 });
  });
});

describe("the session config sent", () => {
  it("default settings: byte-identical to before for Gemini and GPT (full and safe retry)", () => {
    for (const [family, model] of [["gemini", GEMINI], ["openai", GPT], ["openai", MINI]] as const) {
      const base = cfgFor(family);
      const withNothing = { ...base, ...callTurnExtras(s(), model, true) };
      expect(JSON.stringify(toSdkSessionConfig(withNothing, model))).toBe(JSON.stringify(toSdkSessionConfig(base, model)));
      expect(JSON.stringify(toSdkSessionConfig({ ...withNothing, safe: true }, model))).toBe(JSON.stringify(toSdkSessionConfig({ ...base, safe: true }, model)));
    }
    // Gemini's providerOptions and turn detection as before.
    const g = toSdkSessionConfig(cfgFor("gemini"), GEMINI);
    expect(g.providerOptions).toEqual({ google: { defaultToolBehavior: "BLOCKING" } });
    expect(g.turnDetection).toEqual({ type: "server-vad" });
    expect(toSdkSessionConfig(cfgFor("openai"), GPT).providerOptions).toBeUndefined();
  });

  it("Gemini: realtimeInputConfig next to google on the first connect; the retry sends google only", () => {
    const activity = geminiActivityDetectionFor(s({ style: "patient", interrupt: "low" }))!;
    const full = toSdkSessionConfig(cfgFor("gemini", { geminiActivity: activity }), GEMINI);
    expect(full.providerOptions).toEqual({ google: { defaultToolBehavior: "BLOCKING" }, [GEMINI_TURN_OPTION]: { automaticActivityDetection: activity } });
    expect(GEMINI_TURN_OPTION).toBe("realtimeInputConfig");
    // No raw generationConfig ever (it would replace the built one with the voice).
    expect(Object.keys(full.providerOptions!)).not.toContain("generationConfig");
    // Everything else as without it.
    const { providerOptions: _a, ...restA } = full;
    const { providerOptions: _b, ...restB } = toSdkSessionConfig(cfgFor("gemini"), GEMINI);
    void _a; void _b;
    expect(restA).toEqual(restB);
    const safe = toSdkSessionConfig(cfgFor("gemini", { geminiActivity: activity, safe: true }), GEMINI);
    expect(safe.providerOptions).toEqual({ google: { defaultToolBehavior: "BLOCKING" } });
    expect(Object.keys(safe)).toEqual([...SETUP_RETRY_FIELDS.gemini].filter((k) => k !== "voice"));
  });

  it("GPT smart turn ending: semantic VAD with eagerness in a whole audio block (no pause, no threshold); the retry sends none", () => {
    const full = toSdkSessionConfig(cfgFor("openai", { semanticVad: { eagerness: "low" } }), GPT);
    expect(full.turnDetection).toEqual({ type: "semantic-vad" });
    expect(full.providerOptions).toEqual({
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "semantic_vad", eagerness: "low" }, transcription: { model: "gpt-realtime-whisper" } },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: "alloy" },
      },
    });
    expect(JSON.stringify(full)).not.toMatch(/silence|threshold|prefix/i);
    // Text output (ElevenLabs speaks): no output block.
    const text = toSdkSessionConfig(cfgFor("openai", { semanticVad: { eagerness: "high" }, outputModality: "text" }), MINI);
    expect((text.providerOptions as { audio: Record<string, unknown> }).audio).toEqual({
      input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "semantic_vad", eagerness: "high" }, transcription: { model: "gpt-realtime-whisper" } },
    });
    const safe = toSdkSessionConfig(cfgFor("openai", { semanticVad: { eagerness: "low" }, reasoningEffort: "high", parallelToolCalls: true, safe: true }), GPT);
    expect(Object.keys(safe)).toEqual([...SETUP_RETRY_FIELDS.openai]);
    expect(safe.providerOptions).toBeUndefined();
  });

  it("GPT thinking effort: providerOptions.reasoning, next to parallel tool calls; the server VAD tuning unchanged", () => {
    const full = toSdkSessionConfig(cfgFor("openai", { reasoningEffort: "minimal", parallelToolCalls: true }), GPT);
    expect(full.providerOptions).toEqual({ parallel_tool_calls: true, reasoning: { effort: "minimal" } });
    expect(full.turnDetection).toEqual(toSdkSessionConfig(cfgFor("openai"), GPT).turnDetection);
  });

  it("ElevenLabs Realtime never sends any of it", () => {
    const c = toSdkSessionConfig(cfgFor("openai", { semanticVad: { eagerness: "low" }, reasoningEffort: "high" }), ELEVEN_RT);
    expect(c.providerOptions).toBeUndefined();
    expect(c.turnDetection).toBeUndefined();
  });
});

describe("the log", () => {
  it("connect line: GPT names its turn detection, eagerness and reasoning; the retry the provider's defaults", () => {
    const base = cfgFor("openai");
    expect(configSummary(base, "gpt")).toMatch(/ turn=server_vad eagerness=- reasoning=-$/);
    expect(configSummary({ ...base, semanticVad: { eagerness: "low" }, reasoningEffort: "high" }, "gpt")).toMatch(/ turn=semantic_vad eagerness=low reasoning=high$/);
    expect(configSummary({ ...base, semanticVad: { eagerness: "low" }, safe: true }, "gpt")).toMatch(/ turn=provider-default eagerness=- reasoning=-$/);
    // Without a family (the scripted model, ElevenLabs Realtime): as before.
    expect(configSummary(base)).toBe(`config=full instructions=1 tools=${base.tools.length}`);
  });

  it("Gemini: what was sent, and first setup or retry", () => {
    const activity = geminiActivityDetectionFor(s({ style: "quick", interrupt: "high" }))!;
    expect(geminiTurnLine(cfgFor("gemini", { geminiActivity: activity }))).toBe("gemini turn-taking sent: start=HIGH end=HIGH prefix=40 silence=350 setup=first");
    expect(geminiTurnLine(cfgFor("gemini"))).toBe("gemini turn-taking sent: start=- end=- prefix=- silence=- setup=first");
    expect(geminiTurnLine(cfgFor("gemini", { geminiActivity: activity, safe: true }))).toBe("gemini turn-taking sent: start=- end=- prefix=- silence=- setup=retry (proven fields only)");
    // Its acknowledgement (setupComplete) on test calls that sent the block.
    expect(new ServerEventMapper({ ackSession: true }).map({ type: "custom", rawType: "setupComplete", raw: { setupComplete: {} } } as never))
      .toEqual([{ type: "session-ack", name: "setupComplete", detail: "accepted" }]);
    expect(new ServerEventMapper({}).map({ type: "custom", rawType: "setupComplete", raw: { setupComplete: {} } } as never)).toEqual([]);
  });

  it("provider session-updated: turn type and eagerness before parallel and reasoning (GA audio.input.turn_detection)", () => {
    const raw = { session: { audio: { input: { turn_detection: { type: "semantic_vad", eagerness: "low" } } }, reasoning: { effort: "high" }, parallel_tool_calls: true } };
    expect(sessionAckSummary(raw)).toMatch(/ turn=semantic_vad eagerness=low parallel=true reasoning=high$/);
    expect(sessionAckSummary({ session: { turn_detection: { type: "server_vad", threshold: 0.5 } } })).toMatch(/ turn=server_vad eagerness=- parallel=- reasoning=-$/);
    expect(sessionAckSummary({ session: {} })).toMatch(/ turn=- eagerness=- parallel=- reasoning=-$/);
  });
});

describe("ElevenLabs: the pace as a speaking rate (plain text-to-speech models only)", () => {
  it("Flash v2.5 and Multilingual v2: slower 0.9, normal nothing, faster 1.1; dialogue models nothing", () => {
    for (const m of [FLASH, MULTI]) {
      expect(elevenSpeedFor(m, "slower")).toBe(0.9);
      expect(elevenSpeedFor(m, "normal")).toBeUndefined();
      expect(elevenSpeedFor(m, "faster")).toBe(1.1);
    }
    for (const m of [TURBO, "elevenlabs/eleven-v4", "elevenlabs/eleven-v3-conversational"]) expect(elevenSpeedFor(m, "faster")).toBeUndefined();
  });

  it("the chosen link carries it (never a fallback); the speak request sends `speed` in text-to-speech mode only", () => {
    const links = elevenAttempts({ model: FLASH, voice: RACHEL, stability: 1, speed: 1.1 });
    expect(links[0]).toMatchObject({ model: FLASH, dialogue: false, speed: 1.1 });
    expect(links.slice(1).every((l) => l.speed === undefined)).toBe(true);
    expect(elevenAttempts({ model: TURBO, voice: RACHEL, stability: 1, speed: 1.1 })[0].speed).toBeUndefined();
    expect(elevenAttempts({ model: FLASH, voice: RACHEL, stability: 1 })[0]).not.toHaveProperty("speed");
    expect(speakSpeedOption(false, 0.9)).toEqual({ speed: 0.9 });
    expect(speakSpeedOption(true, 0.9)).toEqual({});
    expect(speakSpeedOption(false, undefined)).toEqual({});
  });
});

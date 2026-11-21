/** The voice model picker: one list, validation, capabilities, OpenAI session config, per-response usage and cost. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_VOICE_SETTINGS, VOICE_MODELS, callVoice, isProvenVoiceModel, isVoiceModel, resolveVoiceSettings, turnTakingFor, validateVoiceSettings,
  versionModelId, voiceCapabilities, voiceModelLabel,
} from "@/lib/voice/settings";
import { PROVEN_SESSION_FIELDS, toSdkSessionConfig, toVoiceUsage } from "@/lib/voice/gateway-realtime";
import { realtimeTools, schemaFamilyOf } from "@/lib/voice/tool-schema";
import { RealtimeUsageAccumulator, audioTokensPerSecond, realtimeUsdPerMinute, voiceCallCost } from "@/lib/ai/models";
import { modelCostHint, voiceModelChoices } from "@/lib/voice/model-choices";
import { voiceSettingsSummary } from "@/lib/voice/lab";
import { VoiceSettingsForm } from "@/components/sas/voice/voice-settings-form";

const GEMINI = "google/gemini-3.8-live";
const GPT = "openai/gpt-realtime-2.1";
const MINI = "openai/gpt-realtime-mini";

describe("one list of voice models", () => {
  it("three models with labels, families and the live-proven flag; Gemini is the default", () => {
    expect(VOICE_MODELS.map((m) => [m.id, m.label, m.family, m.proven])).toEqual([
      [GEMINI, "Gemini 3.8 Live", "gemini", true],
      [GPT, "GPT-Realtime 2.1", "openai", false],
      [MINI, "GPT-Realtime mini", "openai", false],
    ]);
    expect(isVoiceModel(GPT)).toBe(true);
    expect(isVoiceModel("openai/gpt-realtime-2")).toBe(false);
    expect(isProvenVoiceModel(GEMINI)).toBe(true);
    expect(isProvenVoiceModel(MINI)).toBe(false);
    expect(voiceModelLabel(MINI)).toBe("GPT-Realtime mini");
    expect(voiceModelLabel("scripted")).toBe("scripted");
    // A version's model: its own when valid, else VOICE_MODEL, else Gemini.
    expect(versionModelId({ model: GPT }, {})).toBe(GPT);
    expect(versionModelId({ model: "openai/gpt-4o" as never }, {})).toBe(GEMINI);
    expect(versionModelId(null, { VOICE_MODEL: MINI })).toBe(MINI);
    expect(versionModelId(null, {})).toBe(GEMINI);
    expect(schemaFamilyOf(MINI)).toBe("openai");
  });

  it("capabilities per model: Gemini voices and no turn-taking; GPT models: OpenAI voices, style, pause, interruptions", () => {
    expect(voiceCapabilities(GEMINI)).toMatchObject({ style: false, pauseMs: false, interruptSensitivity: false });
    for (const m of [GPT, MINI]) {
      expect(voiceCapabilities(m)).toMatchObject({ style: true, pauseMs: true, interruptSensitivity: true });
      expect(voiceCapabilities(m).voices).toContain("alloy");
      expect(callVoice(null, m)).toBe("alloy");
    }
    expect(callVoice(null, GEMINI)).toBe("Puck");
  });
});

describe("validation", () => {
  it("a model of the list only; the rest is checked for the model chosen", () => {
    expect(validateVoiceSettings({ model: "openai/gpt-4o" }, GEMINI)).toEqual({ ok: false, errors: { model: "Pick one of the models offered." } });
    expect(validateVoiceSettings({ model: GPT, voice: "coral", style: "patient", pauseMs: "900", interrupt: "low" }, GEMINI))
      .toEqual({ ok: true, value: { model: GPT, voice: "coral", style: "patient", pauseMs: 900, interrupt: "low" } });
    // Gemini has no turn-taking values: they are not kept.
    expect(validateVoiceSettings({ model: GEMINI, pauseMs: "900", interrupt: "low" }, GPT)).toEqual({ ok: true, value: { model: GEMINI } });
    expect(validateVoiceSettings({ pauseMs: "50" }, GPT)).toMatchObject({ ok: false, errors: { pauseMs: expect.any(String) } });
    expect(validateVoiceSettings({ interrupt: "loud" }, GPT)).toMatchObject({ ok: false, errors: { interrupt: expect.any(String) } });
  });

  it("switching the model drops a voice the new model does not have (the call then pins its default); same model: an error", () => {
    // Kore is a Gemini voice: switching to GPT keeps the rest and drops the voice.
    expect(validateVoiceSettings({ model: GPT, voice: "Kore", pace: "slower" }, GEMINI)).toEqual({ ok: true, value: { model: GPT, pace: "slower" } });
    expect(validateVoiceSettings({ model: GEMINI, voice: "coral" }, MINI)).toEqual({ ok: true, value: { model: GEMINI } });
    expect(validateVoiceSettings({ voice: "Kore" }, GPT)).toMatchObject({ ok: false, errors: { voice: expect.any(String) } });
    expect(callVoice(resolveVoiceSettings({ model: GPT }).voice, GPT)).toBe("alloy");
  });

  it("the version's pause and interruption level replace the style's in the turn detection (GPT models only)", () => {
    expect(turnTakingFor("balanced", GPT)).toEqual({ silenceMs: 600, threshold: 0.5, prefixPaddingMs: 300 });
    expect(turnTakingFor("balanced", GPT, { pauseMs: 1200, interrupt: "high" })).toEqual({ silenceMs: 1200, threshold: 0.35, prefixPaddingMs: 300 });
    expect(turnTakingFor("quick", MINI, { interrupt: "low" })).toEqual({ silenceMs: 350, threshold: 0.7, prefixPaddingMs: 300 });
    expect(turnTakingFor("patient", GEMINI, { pauseMs: 1200 })).toBeNull();
    expect(resolveVoiceSettings({ pauseMs: 1234, interrupt: "medium", model: MINI })).toMatchObject({ pauseMs: 1200, interrupt: "medium", model: MINI });
  });
});

describe("OpenAI session config (normalized SDK fields)", () => {
  const tools = realtimeTools("openai").filter((t) => t.name === "search_catalog");
  const cfg = {
    instructions: "Be brief.", tools, voice: "alloy", language: "he" as const, expectedLanguages: ["he", "en"], toolBehavior: "blocking" as const,
    turnTaking: turnTakingFor("balanced", GPT, { pauseMs: 800, interrupt: "high" })!,
  };
  const tool = { type: "function", name: "search_catalog", description: tools[0].description, parameters: tools[0].parameters };

  it("first connect: only documented normalized fields, with the version's turn-taking and the transcription hint; no providerOptions", () => {
    const first = toSdkSessionConfig(cfg as never, GPT);
    expect(first).toEqual({
      instructions: "Be brief.", voice: "alloy", outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: 24000 }, outputAudioFormat: { type: "audio/pcm", rate: 24000 },
      inputAudioTranscription: { prompt: "The speaker most likely speaks Hebrew or English." }, outputAudioTranscription: {},
      turnDetection: { type: "server-vad", threshold: 0.35, silenceDurationMs: 800, prefixPaddingMs: 300 },
      tools: [tool],
    });
    expect(Object.keys(first).every((k) => (PROVEN_SESSION_FIELDS.openai as readonly string[]).includes(k))).toBe(true);
    // Plain JSON Schema for OpenAI (no Gemini subset), no strict flag on the normalized tool.
    expect(JSON.stringify(first.tools)).not.toContain("strict");
  });

  it("safe retry: the same fields, optional values dropped (plain server VAD, no transcription hint); the engine leaves out a pinned default voice", () => {
    expect(toSdkSessionConfig({ ...cfg, voice: undefined, safe: true } as never, MINI)).toEqual({
      instructions: "Be brief.", outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: 24000 }, outputAudioFormat: { type: "audio/pcm", rate: 24000 },
      inputAudioTranscription: {}, outputAudioTranscription: {}, turnDetection: { type: "server-vad" }, tools: [tool],
    });
  });
});

describe("usage and cost per model", () => {
  it("OpenAI reports usage per response: every response.done counts in full (the heuristic would undercount)", () => {
    // Three responses of one call, as OpenAI's response.done usage: input grows with the context each time.
    const responses = [
      { inputTokens: 2_100, inputTextTokens: 1_900, inputAudioTokens: 200, cachedInputTokens: 0, outputTokens: 260, outputTextTokens: 60, outputAudioTokens: 200 },
      { inputTokens: 2_600, inputTextTokens: 2_050, inputAudioTokens: 550, cachedInputTokens: 1_792, outputTokens: 420, outputTextTokens: 90, outputAudioTokens: 330 },
      { inputTokens: 3_300, inputTextTokens: 2_300, inputAudioTokens: 1_000, cachedInputTokens: 2_304, outputTokens: 380, outputTextTokens: 80, outputAudioTokens: 300 },
    ].map((u) => toVoiceUsage(u as never));
    const per = new RealtimeUsageAccumulator("per_response");
    const auto = new RealtimeUsageAccumulator();
    for (const r of responses) { per.add(r); auto.add(r); }
    expect(per.total).toEqual({ textInTokens: 6_250, audioInTokens: 1_750, cachedInTokens: 4_096, textOutTokens: 230, audioOutTokens: 830 });
    expect(auto.total.audioInTokens).toBeLessThan(per.total.audioInTokens);
    // Priced: cached input at the cached rate, the rest at text / audio rates.
    const cost = voiceCallCost(GPT, per, 30);
    expect(cost.usage.basis).toBe("usage");
    const expected = (6_250 - 4_096) * 4 + 4_096 * 0.4 + 1_750 * 32 + 230 * 24 + 830 * 64;
    expect(cost.costMicros).toBe(Math.round(expected));
  });

  it("prices on file for the new models; the duration floor's audio rate per family (unverified: 25/s for both)", () => {
    expect(audioTokensPerSecond(GPT)).toBe(25);
    expect(audioTokensPerSecond(GEMINI)).toBe(25);
    expect(realtimeUsdPerMinute(GEMINI)).toBeCloseTo(0.0135, 4);
    expect(realtimeUsdPerMinute(GPT)).toBeCloseTo(0.096, 4);
    expect(realtimeUsdPerMinute(MINI)).toBeCloseTo(0.03, 4);
    expect(modelCostHint(GEMINI)).toBe("About $0.013 a minute of call (estimate).");
    expect(modelCostHint(GPT)).toBe("About 7.1× the cost per minute of Gemini (estimate).");
    expect(modelCostHint(MINI)).toBe("About 2.2× the cost per minute of Gemini (estimate).");
    expect(voiceModelChoices().map((c) => c.caps.style)).toEqual([false, true, true]);
  });
});

describe("the settings panel per model", () => {
  const render = (model: string | null) => renderToStaticMarkup(
    <VoiceSettingsForm action={async () => ({})} slug="acme" models={voiceModelChoices()} platformModel={GEMINI}
      initial={{ ...DEFAULT_VOICE_SETTINGS, model: model as never }} version={3} closeHref="#" deploymentLimitSec={null} />,
  );

  it("Gemini: the model first, its voices, no style or turn-taking; GPT: style, pause and interruptions as real controls", () => {
    const g = render(null);
    expect(g.indexOf('name="model"')).toBeLessThan(g.indexOf('name="voice"'));
    expect(g).toContain(">Gemini 3.8 Live</option>");
    expect(g).toContain(">GPT-Realtime mini</option>");
    expect(g).not.toContain('name="style"');
    expect(g).not.toContain('name="pauseMs"');
    expect(g).not.toContain("data-voice-model-unproven");
    expect(g).toContain("a minute of call (estimate)");
    const o = render(GPT);
    expect(o).toContain('name="style"');
    expect(o).toContain('<select class="sas-select" id="vs-pause" name="pauseMs"');
    expect(o).toContain('<select class="sas-select" id="vs-interrupt" name="interrupt"');
    expect(o).toContain("From the style (0.6 s)");
    expect(o).toContain("Not tried on a live call yet.");
    expect(o).toContain("About 7.1× the cost per minute of Gemini (estimate).");
    expect(o).toContain(">Alloy");
    expect(o).not.toContain(">Kore");
    expect(voiceSettingsSummary(resolveVoiceSettings({ model: MINI }), MINI)).toMatch(/^GPT-Realtime mini · Alloy/);
  });
});

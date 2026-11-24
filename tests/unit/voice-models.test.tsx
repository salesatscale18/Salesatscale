/** The voice model picker: one list, validation, capabilities, OpenAI session config, per-response usage and cost. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_VOICE_SETTINGS, VOICE_MODELS, callVoice, isProvenVoiceModel, isVoiceModel, resolveVoiceSettings, turnTakingFor, validateVoiceSettings,
  versionModelId, voiceCapabilities, voiceModelLabel,
} from "@/lib/voice/settings";
import { PROVEN_SESSION_FIELDS, SETUP_RETRY_FIELDS, toSdkSessionConfig, toVoiceUsage } from "@/lib/voice/gateway-realtime";
import { realtimeTools, schemaFamilyOf } from "@/lib/voice/tool-schema";
import { RealtimeUsageAccumulator, audioTokensPerSecond, realtimeUsdPerMinute, voiceCallCost } from "@/lib/ai/models";
import { modelCostHint, modelCostShort, voiceModelChoices } from "@/lib/voice/model-choices";
import { voiceChangeOnModel, voiceSettingsSummary } from "@/lib/voice/lab";
import { VoiceSettingsForm } from "@/components/sas/voice/voice-settings-form";

const GEMINI = "google/gemini-3.8-live";
const GPT = "openai/gpt-realtime-2.1";
const MINI = "openai/gpt-realtime-mini";

describe("one list of voice models", () => {
  it("five models with labels, families and the live-proven flag (the first three proven live by 22 Nov 2026; ElevenLabs Realtime not yet); Gemini is the default", () => {
    expect(VOICE_MODELS.map((m) => [m.id, m.label, m.family, m.proven])).toEqual([
      [GEMINI, "Gemini 3.8 Live", "gemini", true],
      [GPT, "GPT-Realtime 2.1", "openai", true],
      [MINI, "GPT-Realtime mini", "openai", true],
      ["elevenlabs/eleven-realtime-v1-mini", "ElevenLabs Realtime mini (testing)", "elevenlabs", false],
      ["elevenlabs/eleven-realtime-v1-max", "ElevenLabs Realtime max (testing)", "elevenlabs", false],
    ]);
    expect(isVoiceModel(GPT)).toBe(true);
    expect(isVoiceModel("openai/gpt-realtime-2")).toBe(false);
    expect(isProvenVoiceModel(GEMINI)).toBe(true);
    expect(isProvenVoiceModel(MINI)).toBe(true);
    expect(isProvenVoiceModel(GPT)).toBe(true);
    // A model id not in the list (an env override) is not proven.
    expect(isProvenVoiceModel("openai/gpt-realtime-2")).toBe(false);
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

  it("first connect: documented normalized fields, the version's turn-taking, transcription on with no prompt or language; no providerOptions", () => {
    const first = toSdkSessionConfig(cfg as never, GPT);
    expect(first).toEqual({
      instructions: "Be brief.", voice: "alloy", outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: 24000 }, outputAudioFormat: { type: "audio/pcm", rate: 24000 },
      inputAudioTranscription: {}, outputAudioTranscription: {},
      turnDetection: { type: "server-vad", threshold: 0.35, silenceDurationMs: 800, prefixPaddingMs: 300 },
      tools: [tool],
    });
    expect(JSON.stringify(first)).not.toContain('"prompt"');
    // Plain JSON Schema for OpenAI (no Gemini subset), no strict flag on the normalized tool.
    expect(JSON.stringify(first.tools)).not.toContain("strict");
  });

  it("retry after a refused setup: the smallest config that still carries the instructions and tools", () => {
    expect(toSdkSessionConfig({ ...cfg, safe: true } as never, MINI)).toEqual({
      instructions: "Be brief.", outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: 24000 }, outputAudioFormat: { type: "audio/pcm", rate: 24000 }, tools: [tool],
    });
  });

  it("the config snapshot per family (Gemini unchanged: exactly what its working calls sent)", () => {
    const gem = { ...cfg, tools: realtimeTools("gemini").filter((t) => t.name === "search_catalog"), voice: "Puck", turnTaking: undefined };
    expect(Object.keys(toSdkSessionConfig(gem as never, GEMINI))).toEqual([
      "instructions", "voice", "outputModalities", "inputAudioFormat", "outputAudioFormat", "inputAudioTranscription", "outputAudioTranscription", "turnDetection", "tools", "providerOptions",
    ]);
    expect(toSdkSessionConfig(gem as never, GEMINI)).toMatchObject({ inputAudioTranscription: {}, outputAudioTranscription: {}, turnDetection: { type: "server-vad" }, providerOptions: { google: { defaultToolBehavior: "BLOCKING" } } });
    expect(Object.keys(toSdkSessionConfig(cfg as never, GPT))).toEqual([
      "instructions", "voice", "outputModalities", "inputAudioFormat", "outputAudioFormat", "inputAudioTranscription", "outputAudioTranscription", "turnDetection", "tools",
    ]);
    // The first connect sends exactly the fields accepted live on 21-22 Nov 2026, on both GPT models.
    for (const m of [GPT, MINI]) expect(Object.keys(toSdkSessionConfig(cfg as never, m)).sort()).toEqual([...PROVEN_SESSION_FIELDS.openai].sort());
    // The fallback after a refused setup stays the minimal one.
    expect(Object.keys(toSdkSessionConfig({ ...cfg, safe: true } as never, GPT)).sort()).toEqual([...SETUP_RETRY_FIELDS.openai].sort());
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
    expect(voiceModelChoices().map((c) => c.caps.style)).toEqual([false, true, true, false, false]);
  });
});

describe("the picker's cost and voice notes", () => {
  it("the cost next to each name, from the same price table as the hint under the field", () => {
    expect([GEMINI, GPT, MINI].map((m) => modelCostShort(m))).toEqual(["lowest cost", "~7× cost", "~2× cost"]);
    expect(voiceModelChoices().map((c) => `${c.label} · ${c.short}`)).toEqual([
      "Gemini 3.8 Live · lowest cost", "GPT-Realtime 2.1 · ~7× cost", "GPT-Realtime mini · ~2× cost",
      // The session price included (about $0.08 a minute) plus their tokens.
      "ElevenLabs Realtime mini (testing) · ~6× cost", "ElevenLabs Realtime max (testing) · ~7× cost",
    ]);
  });

  it("a voice the new model lacks: the note names the default it changes to, the same as what is saved and sent", () => {
    expect(voiceChangeOnModel("Kore", voiceCapabilities(GPT))).toEqual({ from: "Kore", to: "Alloy" });
    expect(voiceChangeOnModel("coral", voiceCapabilities(GEMINI))).toEqual({ from: "Coral", to: "Puck" });
    // Carries over (GPT to mini), or none chosen: no note.
    expect(voiceChangeOnModel("coral", voiceCapabilities(MINI))).toBeNull();
    expect(voiceChangeOnModel(null, voiceCapabilities(GPT))).toBeNull();
    // What saving does with it: the voice is dropped, so the call sends the model's default, the one the note named.
    const saved = validateVoiceSettings({ model: GPT, voice: "Kore" }, GEMINI);
    expect(saved).toEqual({ ok: true, value: { model: GPT } });
    expect(callVoice(saved.ok ? saved.value.voice : null, GPT)).toBe("alloy");
    const keep = validateVoiceSettings({ model: MINI, voice: "coral" }, GPT);
    expect(keep).toEqual({ ok: true, value: { model: MINI, voice: "coral" } });
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
    expect(g).toContain(">Gemini 3.8 Live · lowest cost</option>");
    expect(g).toContain(">GPT-Realtime mini · ~2× cost</option>");
    expect(g).not.toContain("data-voice-changed");
    expect(g).not.toContain('name="style"');
    expect(g).not.toContain('name="pauseMs"');
    expect(g).not.toContain("data-voice-model-unproven");
    expect(g).toContain("a minute of call (estimate)");
    const o = render(GPT);
    expect(o).toContain('name="style"');
    expect(o).toContain('<select class="sas-select" id="vs-pause" name="pauseMs"');
    expect(o).toContain('<select class="sas-select" id="vs-interrupt" name="interrupt"');
    expect(o).toContain("From the style (0.6 s)");
    // Both GPT models ran live calls (21-22 Nov 2026): no "not tried" note.
    expect(o).not.toContain("data-voice-model-unproven");
    expect(o).toContain("About 7.1× the cost per minute of Gemini (estimate).");
    expect(o).toContain(">Alloy");
    expect(o).not.toContain(">Kore");
    expect(voiceSettingsSummary(resolveVoiceSettings({ model: MINI }), MINI)).toMatch(/^GPT-Realtime mini · Alloy/);
  });

  it("a model added later and not proven yet still gets the \"Not tried on a live call yet\" note", () => {
    const models = voiceModelChoices().map((m) => (m.id === MINI ? { ...m, proven: false } : m));
    const html = renderToStaticMarkup(
      <VoiceSettingsForm action={async () => ({})} slug="acme" models={models} platformModel={GEMINI}
        initial={{ ...DEFAULT_VOICE_SETTINGS, model: MINI as never }} version={3} closeHref="#" deploymentLimitSec={null} />,
    );
    expect(html).toContain("Not tried on a live call yet.");
  });
});

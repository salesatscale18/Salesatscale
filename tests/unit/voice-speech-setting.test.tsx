/**
 * "Voice from" (Voice settings › speech: the model's own voice or ElevenLabs) and the one rule (lib/voice-rt-eleven/rule.ts):
 * validation and resolution (admin vs non-admin, Gemini + ElevenLabs refused), the rule per wiring, model and call
 * kind, the form's states (design review of 24 Nov 2026), the starter line, the engine list (wiring only) and the
 * stability sent in dialogue mode only. Pure; no network.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_VOICE_SETTINGS, resolveVoiceSettings, SPEECH_NEEDS_OPENAI, validateVoiceSettings } from "@/lib/voice/settings";
import { speechAfterModelSwitch, voiceSettingsSummary } from "@/lib/voice/lab";
import { voiceModelChoices } from "@/lib/voice/model-choices";
import { VoiceSettingsForm } from "@/components/sas/voice/voice-settings-form";
import { ELEVEN_FOR_BUYER_CALLS, speechFor, speechIgnoredLine } from "@/lib/voice-rt-eleven/rule";
import { ENGINE_ORDER, engineLabelKey, engineLabelVars, isRetiredEngine, labEngineChoice } from "@/lib/voice-classic/engine-choice";
import { speakProviderOptions, speakRequestOptions } from "@/lib/voice-pipeline/gateway";
import { PIPELINE_VOICE_STABILITY } from "@/lib/voice-pipeline/models";
import { RT_SPEECH_STREAM_LINE } from "@/lib/voice-rt-eleven/speech-line";
import { t } from "@/lib/i18n";

const GEMINI = "google/gemini-3.8-live";
const GPT = "openai/gpt-realtime-2.1";
const MINI = "openai/gpt-realtime-mini";

describe("Voice from: validation and resolution", () => {
  it("a platform admin may pick ElevenLabs with a GPT-Realtime model; with Gemini it is refused with a clear message", () => {
    expect(validateVoiceSettings({ model: MINI, speech: "elevenlabs" }, GEMINI, { canPickSpeech: true })).toEqual({ ok: true, value: { model: MINI, speech: "elevenlabs" } });
    expect(validateVoiceSettings({ speech: "elevenlabs" }, GPT, { canPickSpeech: true })).toEqual({ ok: true, value: { speech: "elevenlabs" } });
    expect(validateVoiceSettings({ model: GEMINI, speech: "elevenlabs" }, MINI, { canPickSpeech: true })).toEqual({ ok: false, errors: { speech: SPEECH_NEEDS_OPENAI } });
    expect(SPEECH_NEEDS_OPENAI).toBe("ElevenLabs works with the GPT-Realtime models only. Pick GPT-Realtime 2.1 or mini, or the model's own voice.");
    expect(validateVoiceSettings({ speech: "elevenlabs" }, GEMINI, { canPickSpeech: true }).ok).toBe(false);
    expect(validateVoiceSettings({ model: MINI, speech: "loud" }, GEMINI, { canPickSpeech: true }).ok).toBe(false);
    // The model's own voice is the default: no key stored.
    expect(validateVoiceSettings({ model: MINI, speech: "model" }, GEMINI, { canPickSpeech: true })).toEqual({ ok: true, value: { model: MINI } });
  });

  it("anyone else's posted value is ignored: the version's stored value stays (dropped when the model no longer allows it)", () => {
    expect(validateVoiceSettings({ model: MINI, speech: "elevenlabs" }, MINI, { canPickSpeech: false })).toEqual({ ok: true, value: { model: MINI } });
    expect(validateVoiceSettings({ model: MINI, speech: "model" }, MINI, { canPickSpeech: false, storedSpeech: "elevenlabs" })).toEqual({ ok: true, value: { model: MINI, speech: "elevenlabs" } });
    expect(validateVoiceSettings({ model: GEMINI }, MINI, { canPickSpeech: false, storedSpeech: "elevenlabs" })).toEqual({ ok: true, value: { model: GEMINI } });
    // The default (no option): not allowed to pick.
    expect(validateVoiceSettings({ pace: "slower", speech: "elevenlabs" }, GPT)).toEqual({ ok: true, value: { pace: "slower" } });
  });

  it("resolve: \"model\" by default; ElevenLabs only with a GPT-Realtime model (stored or the platform's), else back to \"model\"", () => {
    expect(DEFAULT_VOICE_SETTINGS.speech).toBe("model");
    expect(resolveVoiceSettings(null).speech).toBe("model");
    expect(resolveVoiceSettings({ model: MINI, speech: "elevenlabs" } as never).speech).toBe("elevenlabs");
    expect(resolveVoiceSettings({ model: GEMINI, speech: "elevenlabs" } as never).speech).toBe("model");
    expect(resolveVoiceSettings({ speech: "elevenlabs" } as never).speech).toBe("model");
    expect(resolveVoiceSettings({ speech: "elevenlabs" } as never, GPT).speech).toBe("elevenlabs");
    expect(resolveVoiceSettings({ model: MINI, speech: "nope" } as never).speech).toBe("model");
  });

  it("a switch to Gemini with ElevenLabs chosen goes back to the model's own voice and says so; anything else is kept", () => {
    expect(speechAfterModelSwitch("elevenlabs", GEMINI)).toEqual({ speech: "model", reset: true });
    expect(speechAfterModelSwitch("elevenlabs", GPT)).toEqual({ speech: "elevenlabs", reset: false });
    expect(speechAfterModelSwitch("model", GEMINI)).toEqual({ speech: "model", reset: false });
    expect(t("voice.settings.speech_reset")).toBe("ElevenLabs works with GPT-Realtime only; voice set back to the model's own.");
  });
});

describe("the one rule: the version decides model and voice, the engine only the wiring", () => {
  const rule = (wanted: "model" | "elevenlabs", modelId: string, engine: string, isTest: boolean) => speechFor({ wanted, modelId, engine, isTest });
  it("test call + GPT + ElevenLabs → ElevenLabs on Current and on New; Classic, Gemini and buyer calls → the model's own voice (and why)", () => {
    expect(rule("elevenlabs", MINI, "current", true)).toEqual({ speech: "elevenlabs", ignored: null });
    expect(rule("elevenlabs", GPT, "guarded", true)).toEqual({ speech: "elevenlabs", ignored: null });
    expect(rule("elevenlabs", MINI, "classic", true)).toEqual({ speech: "model", ignored: "classic" });
    expect(rule("elevenlabs", GEMINI, "current", true)).toEqual({ speech: "model", ignored: "not_openai" });
    expect(rule("elevenlabs", MINI, "current", false)).toEqual({ speech: "model", ignored: "buyer_call" });
    expect(rule("model", MINI, "current", true)).toEqual({ speech: "model", ignored: null });
    expect(rule("model", MINI, "current", false)).toEqual({ speech: "model", ignored: null });
    expect(ELEVEN_FOR_BUYER_CALLS).toBe(false);
    // The owner's later switch: buyer calls hear ElevenLabs too.
    expect(speechFor({ wanted: "elevenlabs", modelId: MINI, engine: "current", isTest: false, buyerCalls: true })).toEqual({ speech: "elevenlabs", ignored: null });
    expect(speechIgnoredLine("buyer_call")).toMatch(/^speech=elevenlabs ignored on a buyer call/);
  });

  it("the engine select is wiring only: three options; the retired ids are refused for new calls but keep their labels", () => {
    expect(ENGINE_ORDER).toEqual(["current", "guarded", "classic"]);
    expect(ENGINE_ORDER.map((e) => t(engineLabelKey(e), engineLabelVars(e)))).toEqual(["Live for buyers (22 Nov)", "New (23 Nov)", "Old baseline (20 Nov)"]);
    for (const e of ["rt_eleven", "rt_eleven_mini", "guarded_silent", "pipeline", "pipeline_lite", "pipeline_chat"]) expect(isRetiredEngine(e)).toBe(true);
    for (const e of ["current", "guarded", "classic"]) expect(isRetiredEngine(e)).toBe(false);
    expect(t(engineLabelKey("rt_eleven"))).toBe("GPT-Realtime 2.1 + ElevenLabs (testing)");
    expect(t(engineLabelKey("guarded_silent"), engineLabelVars("guarded_silent"))).toBe("New + silent tools (23 Nov, testing)");
    expect(labEngineChoice({ role: "user" }, "guarded", { VOICE_REALTIME: "scripted" })).toBe("current");
  });
});

describe("stability (dialogue mode only) and the call's log line", () => {
  it("dialogue attempts carry voiceSettings.stability = PIPELINE_VOICE_STABILITY (1); text-to-speech attempts get nothing new", () => {
    expect(PIPELINE_VOICE_STABILITY).toBe(1);
    expect(speakRequestOptions("v1", true)).toEqual({ providerOptions: { elevenlabs: { dialogue: { voices: ["v1"], voiceSettings: { stability: 1 } } } } });
    expect(speakRequestOptions("v1", false)).toEqual({});
    expect(speakProviderOptions("v1", 0.5).elevenlabs.dialogue.voiceSettings).toEqual({ stability: 0.5 });
    expect(RT_SPEECH_STREAM_LINE).toBe("rt speech one stream per reply stability=1 (dialogue mode only)");
  });
});

describe("the Voice settings form (design review, 24 Nov 2026)", () => {
  const render = (model: string | null, speech: "model" | "elevenlabs", o: { elevenForBuyers?: boolean } = {}) => renderToStaticMarkup(
    // ElevenLabs Realtime (its own model, not "Voice from") is left out: these tests look for "ElevenLabs" as the speaker.
    <VoiceSettingsForm action={async () => ({})} slug="acme" models={voiceModelChoices().filter((m) => !m.id.startsWith("elevenlabs/"))} platformModel={GEMINI}
      initial={{ ...DEFAULT_VOICE_SETTINGS, model: model as never, speech }} version={3} closeHref="#" deploymentLimitSec={null} elevenForBuyers={o.elevenForBuyers} />,
  );

  it("GPT mini + ElevenLabs: \"Voice from\" under the model, the helper, \"Test calls hear: Rachel (ElevenLabs)\", the model's voice editable under \"Buyers hear\"", () => {
    const h = render(MINI, "elevenlabs");
    const at = (s: string) => h.indexOf(s);
    expect(at('name="model"')).toBeLessThan(at('name="speech"'));
    expect(at('name="speech"')).toBeLessThan(at('name="voice"'));
    expect(h).toContain('<label class="sas-input-label" for="vs-speech">Voice from</label>');
    expect(h).toMatch(/<option value="model">The model&#x27;s own voice<\/option><option value="elevenlabs" selected="">ElevenLabs \(testing\)<\/option>/);
    expect(h).toContain("Used in test calls only for now. Buyers hear the model&#x27;s own voice.");
    expect(h).toMatch(/Test calls hear<\/span>.*data-voice-test-voice="">Rachel \(ElevenLabs\)<\/output>/);
    expect(h).toContain('data-voice-buyers-label="">Buyers hear</span>');
    // Kept visible and editable (no disabled field anywhere).
    expect(h).toMatch(/<select class="sas-select" id="vs-voice" name="voice"/);
    expect(h).not.toContain("disabled");
    // The fillers (the model's own voice only) are in the "Buyers hear" group; pace and style stay where they are.
    expect(at("data-voice-buyers-hear")).toBeLessThan(at('name="fillers"'));
    expect(at('name="fillers"')).toBeLessThan(at('name="pace"'));
    expect(h).toContain('name="style"');
    expect(voiceSettingsSummary(resolveVoiceSettings({ model: MINI, speech: "elevenlabs" } as never), MINI)).toMatch(/^GPT-Realtime mini · Rachel \(ElevenLabs\) · /);
  });

  it("GPT + the model's own voice: the select, no helper, no test/buyer rows; the voice picker as before", () => {
    const h = render(GPT, "model");
    expect(h).toMatch(/<option value="model" selected="">The model&#x27;s own voice<\/option>/);
    expect(h).not.toContain("data-voice-speech-hint");
    expect(h).not.toContain("data-voice-test-hears");
    expect(h).not.toContain("Buyers hear");
    expect(h).toContain('name="voice"');
    expect(h.indexOf('name="voice"')).toBeLessThan(h.indexOf('name="fillers"'));
    expect(voiceSettingsSummary(resolveVoiceSettings({ model: GPT }), GPT)).toMatch(/^GPT-Realtime 2\.1 · Alloy/);
  });

  it("Gemini: nothing new (no \"Voice from\"; the model's own voice is posted)", () => {
    const h = render(null, "model");
    expect(h).not.toContain("Voice from");
    expect(h).not.toContain("ElevenLabs");
    expect(h).toContain('<input type="hidden" name="speech" value="model"/>');
  });

  it("when buyer calls get ElevenLabs too (the server constant), the \"Buyers hear\" group is not rendered (its values kept)", () => {
    const h = render(MINI, "elevenlabs", { elevenForBuyers: true });
    expect(h).not.toContain("Buyers hear");
    expect(h).toContain("Test calls and buyer calls hear ElevenLabs.");
    expect(h).toContain('<input type="hidden" name="voice" value=""/>');
    expect(h).toContain('<input type="hidden" name="fillers" value="on"/>');
  });
});

/**
 * ElevenLabs' speaking model, voice and steadiness (Voice settings › Voice, owner 24 Nov 2026) and the panel's
 * redesign (three sections; design review, 24 Nov): validation and resolution (admin vs non-admin, unknown ids,
 * defaults), the catalog's integrity, the speaker's attempt order with a chosen model and voice, the fallback line,
 * the Hebrew rule, the language lines for a Hebrew+English and an English-only company, the form's states, the
 * starter line and the call card. Free fakes only; no network.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_VOICE_SETTINGS, isElevenRealtimeModel, resolveVoiceSettings, validateVoiceSettings, voiceCapabilities, type ResolvedVoiceSettings } from "@/lib/voice/settings";
import { voiceSettingsSummary } from "@/lib/voice/lab";
import { voiceModelChoices, type VoiceModelChoice } from "@/lib/voice/model-choices";
import { VoiceSettingsForm } from "@/components/sas/voice/voice-settings-form";
import { VoiceCallStats } from "@/components/sas/voice/voice-call-stats";
import {
  DEFAULT_ELEVEN_CHOICE, ELEVEN_LANGUAGE_SUBSTITUTE, ELEVEN_MODELS, ELEVEN_VOICES, elevenLanguageLine, elevenModelOptionLabel, elevenModelSpeaks, elevenVoiceGroups, elevenVoiceLine,
} from "@/lib/voice-rt-eleven/catalog";
import { elevenAttempts, elevenAppliedOf, ElevenSpeaker, type ElevenLink } from "@/lib/voice-rt-eleven/speaker";
import { rtElevenCallInfo, rtElevenVoiceUsed, rtSpeakText } from "@/lib/voice-rt-eleven/summary";
import { rtSpeakCost } from "@/lib/voice-rt-eleven/cost";
import { PIPELINE_SPEAK_ATTEMPTS, SPEAK_MICROS_PER_CHAR } from "@/lib/voice-pipeline/models";
import { ScriptedSpeaker } from "@/lib/voice-pipeline/speaker";

const GEMINI = "google/gemini-3.8-live";
const GPT = "openai/gpt-realtime-2.1";
const MINI = "openai/gpt-realtime-mini";
const TURBO = "elevenlabs/eleven-v4-turbo";
const FLASH = "elevenlabs/eleven-flash-v2.5";
const MULTI = "elevenlabs/eleven-multilingual-v2";
const V3 = "elevenlabs/eleven-v3-conversational";
const RACHEL = "21m00Tcm4TlvDq8ikWAM";
const SARAH = "EXAVITQu4vr4xnSDxMaL";

async function collect(it: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of it) n += c.byteLength;
  return n;
}

describe("validation and resolution of elevenModel / elevenVoice / elevenStability", () => {
  it("defaults: v4 Turbo, Rachel, Steady (1); anything invalid stored resolves to the default", () => {
    expect(resolveVoiceSettings(null)).toMatchObject({ elevenModel: TURBO, elevenVoice: RACHEL, elevenStability: 1 });
    expect(resolveVoiceSettings({ elevenModel: "elevenlabs/eleven-v9", elevenVoice: "nope", elevenStability: 0.3 } as never))
      .toMatchObject({ elevenModel: TURBO, elevenVoice: RACHEL, elevenStability: 1 });
    expect(resolveVoiceSettings({ elevenModel: FLASH, elevenVoice: SARAH, elevenStability: 0 } as never)).toMatchObject({ elevenModel: FLASH, elevenVoice: SARAH, elevenStability: 0 });
  });

  it("a platform admin: posted values are checked; unknown ids are errors; defaults are not stored", () => {
    const ok = validateVoiceSettings({ model: MINI, speech: "elevenlabs", elevenModel: FLASH, elevenVoice: SARAH, elevenStability: "0.5" }, GEMINI, { canPickSpeech: true });
    expect(ok).toEqual({ ok: true, value: { model: MINI, speech: "elevenlabs", elevenModel: FLASH, elevenVoice: SARAH, elevenStability: 0.5 } });
    expect(validateVoiceSettings({ elevenModel: TURBO, elevenVoice: RACHEL, elevenStability: "1" }, MINI, { canPickSpeech: true })).toEqual({ ok: true, value: {} });
    const bad = validateVoiceSettings({ elevenModel: "elevenlabs/eleven-v9", elevenVoice: "x".repeat(20), elevenStability: "0.7" }, MINI, { canPickSpeech: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["elevenModel", "elevenStability", "elevenVoice"]);
    // A field not posted (its section not shown) keeps the version's.
    expect(validateVoiceSettings({ model: MINI }, MINI, { canPickSpeech: true, storedEleven: { elevenModel: FLASH, elevenVoice: SARAH, elevenStability: 0 } }))
      .toEqual({ ok: true, value: { model: MINI, elevenModel: FLASH, elevenVoice: SARAH, elevenStability: 0 } });
  });

  it("anyone else: posted values ignored, the version's kept (also a bad posted id is no error)", () => {
    expect(validateVoiceSettings({ elevenModel: FLASH, elevenVoice: SARAH, elevenStability: "0" }, MINI, { canPickSpeech: false })).toEqual({ ok: true, value: {} });
    expect(validateVoiceSettings({ elevenModel: "junk", elevenVoice: SARAH }, MINI, { canPickSpeech: false, storedEleven: { elevenModel: MULTI, elevenVoice: RACHEL } }))
      .toEqual({ ok: true, value: { elevenModel: MULTI, elevenVoice: RACHEL } });
    // Stored junk is dropped, never kept.
    expect(validateVoiceSettings({}, MINI, { storedEleven: { elevenModel: "junk", elevenStability: 3 } })).toEqual({ ok: true, value: {} });
  });
});

describe("the catalog", () => {
  it("unique ids; every attempt-chain model is in it; its prices match the cost table", () => {
    expect(new Set(ELEVEN_MODELS.map((m) => m.id)).size).toBe(ELEVEN_MODELS.length);
    expect(new Set(ELEVEN_VOICES.map((v) => v.id)).size).toBe(ELEVEN_VOICES.length);
    expect(new Set(ELEVEN_VOICES.map((v) => v.name)).size).toBe(ELEVEN_VOICES.length);
    for (const v of ELEVEN_VOICES) expect(v.id).toMatch(/^[A-Za-z0-9]{20}$/);
    for (const a of PIPELINE_SPEAK_ATTEMPTS) expect(ELEVEN_MODELS.map((m) => m.id)).toContain(a.model);
    for (const m of ELEVEN_MODELS) {
      expect(SPEAK_MICROS_PER_CHAR[m.id]).toBe(Math.round(m.usdPer1kChars * 1000));
      expect(rtSpeakCost(m.id, 1_000).known).toBe(true);
    }
    // Dialogue mode as the attempt chain encodes it: v4 / v4 Turbo / v3 conversational yes; Flash and Multilingual no.
    expect(ELEVEN_MODELS.filter((m) => m.dialogue).map((m) => m.id).sort()).toEqual(["elevenlabs/eleven-v3-conversational", "elevenlabs/eleven-v4", TURBO]);
    expect(PIPELINE_SPEAK_ATTEMPTS.find((a) => a.model === FLASH)?.dialogue).toBe(false);
    expect(PIPELINE_SPEAK_ATTEMPTS.find((a) => a.model === TURBO)?.dialogue).toBe(true);
    expect(DEFAULT_ELEVEN_CHOICE).toEqual({ model: TURBO, voice: RACHEL, stability: 1 });
    expect(elevenVoiceGroups().map((g) => `${g.label}:${g.voices.length}`)).toEqual(["Female:9", "Male:11", "Neutral:1"]);
  });

  it("languages: no Hebrew on Flash v2.5 and Multilingual v2; Hebrew on v3/v4", () => {
    expect(elevenModelSpeaks(FLASH, "he")).toBe(false);
    expect(elevenModelSpeaks(MULTI, "iw")).toBe(false);
    expect(elevenModelSpeaks(TURBO, "he-IL")).toBe(true);
    expect(elevenModelSpeaks(V3, "he")).toBe(true);
    expect(elevenModelSpeaks(FLASH, "en")).toBe(true);
    expect(elevenModelSpeaks(FLASH, "vi")).toBe(true);
    expect(elevenModelSpeaks(MULTI, "vi")).toBe(false);
    expect(elevenModelSpeaks(TURBO, "sw")).toBeNull();
  });
});

describe("language lines (the company's selling languages)", () => {
  it("a Hebrew + English company: options list what each model speaks; Flash warns, v4 Turbo is neutral", () => {
    const langs = ["en", "he"];
    expect(elevenModelOptionLabel(TURBO, langs)).toBe("v4 Turbo · English, Hebrew");
    expect(elevenModelOptionLabel(FLASH, langs)).toBe("Flash v2.5 · English only");
    expect(elevenModelOptionLabel(MULTI, ["he", "en"])).toBe("Multilingual v2 · English only");
    expect(elevenLanguageLine(TURBO, langs)).toEqual({ tone: "neutral", text: "Speaks all your selling languages (English, Hebrew)." });
    expect(elevenLanguageLine(FLASH, langs)).toEqual({ tone: "warning", text: "Hebrew is not supported by this model: Hebrew calls will use v4 Turbo." });
    expect(elevenVoiceLine(langs)).toBe("English voice; speaks Hebrew with an English accent on v4 and v3 models.");
  });

  it("an English-only company: every model speaks it; no Hebrew clause", () => {
    expect(elevenModelOptionLabel(FLASH, ["en"])).toBe("Flash v2.5 · English");
    expect(elevenLanguageLine(FLASH, ["en"])).toEqual({ tone: "neutral", text: "Speaks all your selling languages (English)." });
    expect(elevenVoiceLine(["en"])).toBe("English voice.");
  });
});

/** Fake speakers per attempt: `fail` names the (model, voice) pairs that refuse. */
function fakeSpeaker(choice: typeof DEFAULT_ELEVEN_CHOICE, fail: (l: ElevenLink) => string | null = () => null) {
  const made: { link: ElevenLink; speaker: ScriptedSpeaker }[] = [];
  const sp = new ElevenSpeaker(choice, (l) => {
    const f = fail(l);
    const s = new ScriptedSpeaker(l.model, { msPerChar: 2, maxMs: 200, voice: l.voice, ...(f ? { failWith: f } : {}) });
    made.push({ link: l, speaker: s });
    return s;
  });
  const logs: string[] = [];
  sp.setLog((level, line) => logs.push(`${level} ${line}`));
  return { sp, made, logs };
}

describe("the speaker: the chosen model and voice first, the fallback, the Hebrew rule", () => {
  it("attempt order: the chosen model with its dialogue flag, voice and stability, then the chain with Rachel (no duplicate)", () => {
    const at = elevenAttempts({ model: FLASH, voice: SARAH, stability: 0 });
    expect(at.map((l) => `${l.model} ${l.dialogue ? "dialogue" : "speech"} ${l.voice}${l.chosen ? " chosen" : ""}`)).toEqual([
      `${FLASH} speech ${SARAH} chosen`,
      `${TURBO} dialogue ${RACHEL}`,
      `${V3} speech ${RACHEL}`,
      `${V3} dialogue ${RACHEL}`,
      `${FLASH} speech ${RACHEL}`,
      `${MULTI} speech ${RACHEL}`,
    ]);
    // The default choice is the chain's own first attempt: not tried twice.
    const def = elevenAttempts(DEFAULT_ELEVEN_CHOICE);
    expect(def.filter((l) => l.model === TURBO && l.dialogue)).toHaveLength(1);
    expect(def[0]).toMatchObject({ model: TURBO, chosen: true, stability: 1 });
    // The steadiness only differs: v4 Turbo with Rachel at 1 stays as the fallback of v4 Turbo Rachel at 0.
    expect(elevenAttempts({ model: TURBO, voice: RACHEL, stability: 0 }).slice(0, 2).map((l) => l.stability)).toEqual([0, 1]);
  });

  it("the chosen voice works: it speaks, nothing else is tried, applied says so", async () => {
    const { sp, made, logs } = fakeSpeaker({ model: TURBO, voice: SARAH, stability: 0.5 });
    expect(await collect(sp.speak("Hello there.", { language: "en" }))).toBeGreaterThan(0);
    expect(made[0].speaker.said).toHaveLength(1);
    expect(made.slice(1).every((m) => m.speaker.said.length === 0)).toBe(true);
    expect(sp.modelId).toBe(TURBO);
    expect(sp.voice).toBe("Sarah (ElevenLabs)");
    expect(logs[0]).toBe(`info rt speech choice model=${TURBO} dialogue voice=Sarah (${SARAH}) stability=0.5`);
    expect(sp.applied()).toEqual({ chosen: { model: TURBO, voice: SARAH, stability: 0.5 }, model: TURBO, voice: SARAH, stability: 0.5, fallback: null, substituted: [] });
  });

  it("the chosen voice is refused: the fallback speaks the same text with Rachel, logged once", async () => {
    const { sp, made, logs } = fakeSpeaker({ model: TURBO, voice: SARAH, stability: 1 }, (l) => (l.voice === SARAH ? "voice_not_found: A voice with the voice_id EXAVITQu4vr4xnSDxMaL was not found." : null));
    expect(await collect(sp.speak("Hello there.", { language: "en" }))).toBeGreaterThan(0);
    expect(made[1].link).toMatchObject({ model: TURBO, voice: RACHEL });
    expect(made[1].speaker.said.map((x) => x.text)).toEqual(["Hello there."]);
    expect(logs.filter((l) => l.includes("rt speech fallback"))).toEqual([
      `warn rt speech fallback: ${TURBO} / Sarah failed: voice_not_found: A voice with the voice_id EXAVITQu4vr4xnSDxMaL was not found.; using ${TURBO} Rachel`,
    ]);
    await collect(sp.speak("Second.", { language: "en" }));
    expect(logs.filter((l) => l.includes("rt speech fallback"))).toHaveLength(1);
    expect(sp.applied()).toMatchObject({ model: TURBO, voice: RACHEL, fallback: expect.stringContaining("voice_not_found") });
  });

  it("Flash v2.5 on a Hebrew reply: not tried; v4 Turbo with the same voice speaks it, logged once; English stays on Flash", async () => {
    const { sp, made, logs } = fakeSpeaker({ model: FLASH, voice: SARAH, stability: 0 });
    await collect(sp.speak("שלום", { language: "he" }));
    await collect(sp.speak("עוד", { language: "he" }));
    expect(made.filter((m) => m.link.model === FLASH && m.link.voice === SARAH).every((m) => m.speaker.said.every((x) => x.language !== "he"))).toBe(true);
    const sub = made.find((m) => m.link.model === TURBO && m.link.voice === SARAH)!;
    expect(sub.link).toMatchObject({ dialogue: true, stability: 0, chosen: true });
    expect(sub.speaker.said.map((x) => x.text)).toEqual(["שלום", "עוד"]);
    expect(logs.filter((l) => l.includes("has no Hebrew"))).toEqual([`info rt speech: ${FLASH} has no Hebrew, using ${TURBO} for Hebrew`]);
    expect(sp.modelId).toBe(TURBO);
    await collect(sp.speak("Hi.", { language: "en" }));
    expect(sp.modelId).toBe(FLASH);
    expect(sp.applied()).toMatchObject({ model: FLASH, voice: SARAH, stability: null, substituted: ["he"] });
  });

  it("a scripted call (or a test's fake speaker): what applied is the choice, nothing sent", () => {
    expect(elevenAppliedOf(new ScriptedSpeaker(), { model: FLASH, voice: SARAH, stability: 1 }))
      .toEqual({ chosen: { model: FLASH, voice: SARAH, stability: 1 }, model: null, voice: SARAH, stability: null, fallback: null, substituted: [], scripted: true });
  });
});

describe("the call card and the starter line", () => {
  it("the starter line: \"GPT-Realtime mini · Sarah · ElevenLabs Flash v2.5 · …\"", () => {
    const s = resolveVoiceSettings({ model: MINI, speech: "elevenlabs", elevenModel: FLASH, elevenVoice: SARAH } as never);
    expect(voiceSettingsSummary(s, MINI)).toMatch(/^GPT-Realtime mini · Sarah · ElevenLabs Flash v2\.5 · Normal pace/);
  });

  it("the card says what applied: the chosen voice, or Rachel after a fallback; the go-live snapshot before the call ended", () => {
    const snap = { speech: "elevenlabs", voice: "Rachel (ElevenLabs)", elevenModel: TURBO, elevenVoice: SARAH, elevenStability: 0, rtEleven: { realtimeModel: MINI, speakModel: TURBO } };
    expect(rtElevenVoiceUsed(snap, null)).toEqual({ voice: "Sarah (ElevenLabs)", fillers: false });
    const ok = rtElevenCallInfo({ ...snap, elevenApplied: { chosen: { model: TURBO, voice: SARAH, stability: 0 }, model: TURBO, voice: SARAH, stability: 0, fallback: null, substituted: [] } }, { rtEleven: { speakModel: TURBO } })!;
    expect(rtSpeakText(ok)).toBe("ElevenLabs v4 Turbo · Expressive");
    const fell = { ...snap, elevenApplied: { chosen: { model: TURBO, voice: SARAH, stability: 0 }, model: TURBO, voice: RACHEL, stability: 1, fallback: "voice_not_found", substituted: [] } };
    expect(rtElevenVoiceUsed(fell, null)?.voice).toBe("Rachel (ElevenLabs)");
    const info = rtElevenCallInfo(fell, { rtEleven: { speakModel: TURBO } })!;
    expect(rtSpeakText(info)).toBe("ElevenLabs v4 Turbo");
    const html = renderToStaticMarkup(
      <VoiceCallStats durationSec={30} maxSec={300} costMicros={0} scripted={false} fx={null} answerMsAvg={900} live={false} model="GPT-Realtime mini"
        voiceUsed={rtElevenVoiceUsed(fell, null)} rtEleven={info} />,
    );
    expect(html).toContain('data-voice-used="">Rachel (ElevenLabs)</dd>');
    expect(html).toContain("The chosen voice failed (voice_not_found); the fallback spoke with Rachel.");
  });
});

describe("the panel (three sections; design review, 24 Nov 2026)", () => {
  const render = (initial: Partial<ResolvedVoiceSettings>, o: { languages?: string[]; models?: VoiceModelChoice[] } = {}) => renderToStaticMarkup(
    <VoiceSettingsForm action={async () => ({})} slug="acme" models={o.models ?? voiceModelChoices()} platformModel={GEMINI}
      initial={{ ...DEFAULT_VOICE_SETTINGS, ...initial }} version={3} closeHref="#" deploymentLimitSec={null} languages={o.languages ?? ["en", "he"]} />,
  );
  const sections = (h: string) => [...h.matchAll(/<h3 class="sas-vs-section__title" id="vs-sec-[a-z]+">([^<]+)<\/h3>/g)].map((m) => m[1]);

  it("Gemini: Voice model (no Voice from), Voice (its picker + fillers), Conversation (pace, longest call)", () => {
    const h = render({ model: null });
    expect(sections(h)).toEqual(["Voice model", "Voice", "Conversation"]);
    expect(h).not.toContain('name="speech" value="elevenlabs"');
    expect(h).toContain('<input type="hidden" name="speech" value="model"/>');
    expect(h).not.toContain("elevenModel");
    expect(h).not.toContain('name="style"');
    const at = (s: string) => h.indexOf(s);
    expect(at('data-vs-section="voice"')).toBeLessThan(at('name="voice"'));
    expect(at('name="fillers"')).toBeLessThan(at('data-vs-section="conversation"'));
    expect(at('data-vs-section="conversation"')).toBeLessThan(at('name="pace"'));
  });

  it("GPT + the model's own voice: Voice from is the last row of Voice model; its voice picker; no ElevenLabs fields", () => {
    const h = render({ model: GPT as never, speech: "model" });
    const at = (s: string) => h.indexOf(s);
    expect(at('name="model"')).toBeLessThan(at('name="speech"'));
    expect(at('name="speech"')).toBeLessThan(at('data-vs-section="voice"'));
    expect(h).not.toContain("elevenModel");
    expect(h).not.toContain("Buyers hear");
    expect(h).toContain('name="voice"');
    expect(h).toContain('name="style"');
    expect(h).toContain('name="pauseMs"');
  });

  it("GPT + ElevenLabs v4 Turbo (dialogue): speaking model with markers, the voice with optgroups, Steadiness, test row, Buyers hear collapsed", () => {
    const h = render({ model: MINI as never, speech: "elevenlabs", elevenModel: TURBO, elevenVoice: SARAH, elevenStability: 0.5 });
    expect(h).toContain('<option value="elevenlabs/eleven-v4-turbo" selected="">v4 Turbo · English, Hebrew</option>');
    expect(h).toContain('<option value="elevenlabs/eleven-flash-v2.5">Flash v2.5 · English only</option>');
    expect(h).not.toMatch(/✓|✔/);
    expect(h).toContain('data-voice-eleven-lang="neutral">Speaks all your selling languages (English, Hebrew).</span>');
    // The model note and its facts on ONE muted line; the language line on its own (UX review, 24 Nov).
    expect(h).toContain('<span class="sas-small sas-muted" id="vs-eleven-model-note" data-voice-eleven-note="">Newest, most natural and expressive; delivery can vary within an answer. 70+ languages · $0.04 per 1,000 characters.</span>');
    expect(h).not.toContain("data-voice-eleven-meta");
    expect(h).toContain('<span class="sas-small sas-vs-lang" id="vs-eleven-model-lang" data-voice-eleven-lang="neutral">');
    expect(h).toMatch(/<optgroup label="Female"><option value="21m00Tcm4TlvDq8ikWAM">Rachel<\/option><option value="EXAVITQu4vr4xnSDxMaL" selected="">Sarah<\/option>/);
    expect(h).toContain('<optgroup label="Male">');
    expect(h).toContain('<optgroup label="Neutral"><option value="SAz9YHcvj6GT2YYXdXww">River</option></optgroup>');
    expect(h).toContain("English voice; speaks Hebrew with an English accent on v4 and v3 models.");
    expect(h).toContain('data-voice-eleven-stability=""');
    expect(h).toMatch(/<input type="radio" class="sas-sr" name="elevenStability" checked="" value="0.5"\/>Natural/);
    // Two matching plain text lines (no read-only boxes): "Test calls hear: …" and "Buyers hear: … Change".
    expect(h).toContain('<div class="sas-vs-line" data-voice-test-hears=""><span class="sas-vs-line__value">Test calls hear: <output data-voice-test-voice="">Sarah · v4 Turbo</output></span></div>');
    expect(h).toContain('<span class="sas-vs-line"><span class="sas-vs-line__value" data-voice-buyers-summary="">Buyers hear: Alloy · fillers on</span>');
    expect(h).not.toContain("sas-vs-readonly");
    expect(h.indexOf("data-voice-test-hears")).toBeLessThan(h.indexOf("data-voice-buyers-hear"));
    // "Play sample" (owner approved, 24 Nov): one button per sample language the model speaks.
    expect([...h.matchAll(/data-voice-sample="([a-z]+)"/g)].map((m) => m[1])).toEqual(["en", "he"]);
  });

  it("GPT + ElevenLabs Flash v2.5 (not dialogue) on a Hebrew + English company: no Steadiness, the warning line", () => {
    const h = render({ model: MINI as never, speech: "elevenlabs", elevenModel: FLASH });
    expect(h).not.toContain("elevenStability");
    expect(h).toMatch(/data-voice-eleven-lang="warning">.*<span>Hebrew is not supported by this model: Hebrew calls will use v4 Turbo\.<\/span>/);
    expect(h).toContain("Older, plain and steady; lowest delay; no Hebrew.");
    expect(h).toContain('data-voice-eleven-note="">Older, plain and steady; lowest delay; no Hebrew. 32 languages · $0.04 per 1,000 characters.</span>');
    // Hebrew replies use the substitute model the speaker switches to (ELEVEN_LANGUAGE_SUBSTITUTE): shown on the row.
    expect(ELEVEN_LANGUAGE_SUBSTITUTE).toBe("elevenlabs/eleven-v4-turbo");
    expect(h).toContain('Test calls hear: <output data-voice-test-voice="">Rachel · Flash v2.5 (Hebrew: v4 Turbo)</output>');
    // The voice line follows the model: no Hebrew sentence on a model without Hebrew.
    expect(h).toContain('data-voice-eleven-voice-line="">English voice.</span>');
    expect(h).not.toContain("speaks Hebrew with an English accent");
    // Sample buttons: only the languages the model speaks.
    expect([...h.matchAll(/data-voice-sample="([a-z]+)"/g)].map((m) => m[1])).toEqual(["en"]);
  });

  it("GPT + ElevenLabs Multilingual v2 on an English-only company: neutral line, no Hebrew clause, no Steadiness", () => {
    const h = render({ model: GPT as never, speech: "elevenlabs", elevenModel: MULTI }, { languages: ["en"] });
    expect(h).toContain('data-voice-eleven-lang="neutral">Speaks all your selling languages (English).</span>');
    expect(h).toContain('<option value="elevenlabs/eleven-multilingual-v2" selected="">Multilingual v2 · English</option>');
    expect(h).toContain('data-voice-eleven-voice-line="">English voice.</span>');
    expect(h).not.toContain("elevenStability");
  });

  it("a model family with no voice list (a fake ElevenLabs Realtime entry): read-only voice row, the test-only helper, no Buyers hear", () => {
    const id = "elevenlabs/eleven-realtime-mini";
    expect(isElevenRealtimeModel(id)).toBe(true);
    expect(isElevenRealtimeModel(MINI)).toBe(false);
    const fake: VoiceModelChoice = {
      id, label: "ElevenLabs Realtime mini (testing)", note: "End to end.", proven: false, costHint: "No price on file.", short: "no price",
      caps: { ...voiceCapabilities("scripted"), voices: [] },
    };
    const h = render({ model: id as never, speech: "elevenlabs" }, { models: [...voiceModelChoices(), fake] });
    expect(h).toContain('<option value="elevenlabs/eleven-realtime-mini" selected="">ElevenLabs Realtime mini (testing) · no price</option>');
    expect(h).toContain("Used in test calls only for now. Buyer calls use the platform&#x27;s default voice model.");
    expect(h).toContain('<div class="sas-vs-line" data-voice-model-default=""><span class="sas-vs-line__value">Voice: the model&#x27;s default</span></div>');
    expect(h).not.toContain('id="vs-speech"');
    expect(h).not.toContain("Buyers hear");
    expect(h).not.toContain('name="voice"');
  });

  it("the list's own ElevenLabs Realtime entries: all five models offered; that state shows only what its capabilities allow", () => {
    const ids = voiceModelChoices().map((m) => m.id);
    expect(ids).toHaveLength(5);
    const h0 = render({ model: null });
    for (const id of ids) expect(h0).toContain(`<option value="${id}"`);
    const real = ids.find((id) => isElevenRealtimeModel(id))!;
    const h = render({ model: real as never });
    const caps = voiceCapabilities(real);
    expect(h).toContain("Used in test calls only for now. Buyer calls use the platform&#x27;s default voice model.");
    expect(h).toContain("Voice: the model&#x27;s default");
    expect(h).not.toContain("Buyers hear");
    expect(h).not.toContain('id="vs-speech"');
    expect(h.includes('name="pace"')).toBe(caps.pace);
    expect(h.includes('name="style"')).toBe(caps.style);
    expect(h.includes('name="pauseMs"')).toBe(caps.pauseMs);
    expect(h.includes('name="interrupt"')).toBe(caps.interruptSensitivity);
    expect(h.includes('name="fillers"')).toBe(caps.fillers);
  });
});

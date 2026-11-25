/**
 * One Voice settings panel for every model (owner, 25 Nov 2026; UX review): the same sections and order everywhere,
 * a control the model does not have is not rendered (no disabled rows), the remaining rows keep their order; exactly
 * one native "More options" fold per section, closed by default, open when a value inside is not its default, with a
 * "N changed" count while closed; "Not on this model: …" as the fold's last line; one test-only note per section; the
 * set-aside rows after a model switch. Static render (no DOM): the toggling itself is driven in
 * tests/e2e/voice/panel-shots.ts.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceSettingsForm } from "@/components/sas/voice/voice-settings-form";
import { DEFAULT_VOICE_SETTINGS, voiceCapabilities, type ResolvedVoiceSettings } from "@/lib/voice/settings";
import { voiceModelChoices } from "@/lib/voice/model-choices";
import { ALL_ROWS, moreOptionsCount, panelRows, rowChanged, setAsideRows, testOnlyRows } from "@/lib/voice/lab";
import en from "@/lib/i18n/messages/en.json";
import he from "@/lib/i18n/messages/he.json";

const GEMINI = "google/gemini-3.8-live";
const GPT = "openai/gpt-realtime-2.1";
const MINI = "openai/gpt-realtime-mini";
const ELEVEN_RT = "elevenlabs/eleven-realtime-v1-mini";

const render = (initial: Partial<ResolvedVoiceSettings>) => renderToStaticMarkup(
  <VoiceSettingsForm action={async () => ({})} slug="acme" models={voiceModelChoices()} platformModel={GEMINI}
    initial={{ ...DEFAULT_VOICE_SETTINGS, ...initial }} version={3} closeHref="#" deploymentLimitSec={null} languages={["en", "he"]} />,
);
/** The panel's rows in order (data-vs-row), and the fold each sits in. */
const rows = (h: string) => [...h.matchAll(/data-vs-row="([a-zA-Z]+)"/g)].map((m) => m[1]);
const folds = (h: string) => [...h.matchAll(/<details class="sas-vs-more"([^>]*)>/g)].map((m) => m[1]);
const between = (h: string, a: string, b: string) => h.slice(h.indexOf(a), h.indexOf(b, h.indexOf(a)));

describe("rows per model (same order, missing ones not rendered)", () => {
  const ORDER = ["elevenModel", "voice", "pace", "stability", "fillers", "style", "max", "pause", "interrupt", "turnEnd", "thinking", "opener"];
  const inOrder = (r: string[]) => expect(r).toEqual(ORDER.filter((x) => r.includes(x)));

  it("Gemini: voice, pace | fillers; style, longest call | pause, interruption, protect the opening line", () => {
    const h = render({ model: null });
    expect(rows(h)).toEqual(["voice", "pace", "fillers", "style", "max", "pause", "interrupt", "opener"]);
    expect(h).toContain("Not on this model: Steadiness.");
    expect(h).toContain("Not on this model: Turn ending, Thinking effort.");
    expect(h).toContain("Used in test calls only for now: Conversation style, Pause before answering, Interruption sensitivity, Protect the opening line. Buyer calls work as before.");
  });

  it("GPT-Realtime 2.1, own voice: every conversation row", () => {
    const h = render({ model: GPT as never });
    expect(rows(h)).toEqual(["voice", "pace", "fillers", "style", "max", "pause", "interrupt", "turnEnd", "thinking", "opener"]);
    expect(h).toContain("Not on this model: Steadiness.");
    expect(h).not.toContain("Not on this model: Turn");
    expect(h).toContain("Used in test calls only for now: Turn ending, Thinking effort, Protect the opening line. Buyer calls work as before.");
    expect(h).toMatch(/<option value="model" selected="">The model&#x27;s own voice<\/option>/);
  });

  it("GPT-Realtime mini + ElevenLabs v4 Turbo: speaking model first, steadiness in the fold; no thinking effort", () => {
    const h = render({ model: MINI as never, speech: "elevenlabs" });
    const r = rows(h);
    // "voice" twice: the ElevenLabs voice in VOICE and the buyers' voice under "Buyers hear".
    expect(r).toEqual(["elevenModel", "voice", "pace", "stability", "fillers", "voice", "style", "max", "pause", "interrupt", "turnEnd", "opener"]);
    expect(h).not.toContain("Not on this model: Steadiness");
    expect(h).toContain("Not on this model: Thinking effort.");
  });

  it("GPT-Realtime mini + Flash v2.5 (a plain text-to-speech model): no steadiness", () => {
    const h = render({ model: MINI as never, speech: "elevenlabs", elevenModel: "elevenlabs/eleven-flash-v2.5" });
    expect(rows(h)).not.toContain("stability");
    expect(h).toContain("Not on this model: Steadiness.");
  });

  it("ElevenLabs Realtime: no style, pause, interruption, turn ending or thinking; the opener switch still there", () => {
    const h = render({ model: ELEVEN_RT as never });
    expect(rows(h)).toEqual(["voice", "pace", "fillers", "max", "opener"]);
    expect(h).toContain("Not on this model: Conversation style, Pause before answering, Interruption sensitivity, Turn ending, Thinking effort.");
    expect(h).toContain("Used in test calls only for now: Protect the opening line. Buyer calls work as before.");
  });

  it("the order never changes between models; no disabled rows; never an \"Advanced\" fold", () => {
    for (const init of [{ model: null }, { model: GPT as never }, { model: MINI as never, speech: "elevenlabs" as const }, { model: ELEVEN_RT as never }]) {
      const h = render(init);
      inOrder(rows(h).filter((x, i, a) => a.indexOf(x) === i));
      expect(h).not.toContain("disabled");
      expect(h).not.toContain("Advanced");
      expect(folds(h)).toHaveLength(2);
      // The sections: model, voice, conversation, each fold labelled "More options".
      expect([...h.matchAll(/<span class="sas-vs-more__title">More options/g)]).toHaveLength(2);
    }
  });
});

describe("the folds", () => {
  it("closed by default (default values)", () => {
    const h = render({ model: GPT as never });
    expect(folds(h).every((attrs) => !/ open=""/.test(attrs))).toBe(true);
    expect(h).not.toContain("data-vs-more-count");
  });

  it("open when a value inside differs from its default (each section on its own)", () => {
    const conv = render({ model: GPT as never, thinking: "high" });
    expect(folds(conv)[0]).not.toMatch(/ open=""/);
    expect(folds(conv)[1]).toMatch(/ open=""/);
    expect(folds(conv)[1]).toMatch(/data-changed="1"/);
    const voice = render({ model: GPT as never, fillers: false });
    expect(folds(voice)[0]).toMatch(/ open=""/);
    expect(folds(voice)[1]).not.toMatch(/ open=""/);
    // Two changed in Conversation (the opener switch off counts; on, its default, does not).
    expect(folds(render({ model: GPT as never, pauseMs: 900, openerProtected: false }))[1]).toMatch(/data-changed="2"/);
    expect(folds(render({ model: GPT as never, openerProtected: true }))[1]).not.toMatch(/data-changed/);
  });

  it("the count shows only while the fold is closed: \"More options · 2 changed\"", () => {
    expect(moreOptionsCount(2, false)).toBe(2);
    expect(moreOptionsCount(2, true)).toBeNull();
    expect(moreOptionsCount(0, false)).toBeNull();
    expect(en["voice.settings.more"]).toBe("More options");
    expect(en["voice.settings.more_changed"]).toBe("{count} changed");
  });

  it("the switches: opener on by default with its helper; smart turn ending says the pause and interruption are its own", () => {
    const h = render({ model: GPT as never });
    expect(between(h, 'data-vs-row="opener"', "</label>")).toContain('name="openerProtected" checked=""');
    expect(h).toContain('<input type="hidden" name="openerProtectedShown" value="1"/>');
    expect(h).toContain("The buyer cannot interrupt the greeting and the recording notice.");
    const smart = render({ model: GPT as never, turnEnd: "smart" });
    expect(smart.match(/Smart turn ending decides this instead\./g)).toHaveLength(2);
    expect(smart).toMatch(/<input type="radio" class="sas-sr" name="turnEnd" checked="" value="smart"\/>Smart/);
  });
});

describe("set aside on a model switch (values kept in the form, not posted)", () => {
  it("rows the new model does not show, with a non-default value", () => {
    const v = { ...DEFAULT_VOICE_SETTINGS, thinking: "high" as const, turnEnd: "smart" as const, elevenStability: 0 as const, style: "quick" as const };
    expect(setAsideRows(panelRows(voiceCapabilities(MINI), { eleven: false, elevenDialogue: false }), v)).toEqual(["stability", "thinking"]);
    expect(setAsideRows(panelRows(voiceCapabilities(GEMINI), { eleven: false, elevenDialogue: false }), v)).toEqual(["stability", "turnEnd", "thinking"]);
    expect(setAsideRows(panelRows(voiceCapabilities(ELEVEN_RT), { eleven: false, elevenDialogue: false }), v)).toEqual(["stability", "style", "turnEnd", "thinking"]);
    // Back on GPT 2.1 with ElevenLabs v4: nothing set aside.
    expect(setAsideRows(panelRows(voiceCapabilities(GPT), { eleven: true, elevenDialogue: true }), v)).toEqual([]);
    expect(en["voice.settings.set_aside"]).toBe("{list} don't apply to this model and were set aside.");
  });

  it("defaults are never set aside", () => {
    for (const r of ALL_ROWS) expect(rowChanged(r, DEFAULT_VOICE_SETTINGS), r).toBe(false);
  });

  it("test-only rows per model follow the constants", () => {
    expect(testOnlyRows(GEMINI)).toEqual(["style", "pause", "interrupt", "turnEnd", "thinking", "opener"]);
    expect(testOnlyRows(GPT)).toEqual(["turnEnd", "thinking", "opener"]);
  });
});

describe("strings", () => {
  it("every new voice.settings key has a Hebrew text with the same placeholders", () => {
    const keys = Object.keys(he).filter((k) => k.startsWith("voice.settings."));
    expect(keys.length).toBeGreaterThanOrEqual(22);
    for (const k of keys) {
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph((he as Record<string, string>)[k]), k).toEqual(ph((en as Record<string, string>)[k]));
    }
    expect(Object.keys(en).filter((k) => k.startsWith("voice.settings.advanced"))).toEqual([]);
  });
});

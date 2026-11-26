"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import {
  callLimitShort, CONVERSATION_FOLD, CONVERSATION_ROWS, defaultVoiceOf, limitOptions, moreOptionsCount, panelRows, ROW_LABEL, rowChanged, setAsideRows, speechAfterModelSwitch, testOnlyRows, VOICE_FOLD,
  voiceChangeOnModel, voiceLabel, voiceOptions, type PanelRow,
} from "@/lib/voice/lab";
import {
  DEFAULT_VOICE_SETTINGS, geminiActivityDetectionFor, INTERRUPT_LEVELS, isOpenAiVoiceModel, PAUSE_MS_RANGE, PLATFORM_MAX_CALL_SEC, styleTurnTaking, THINKING_LEVELS, TURN_ENDS, voiceFamilyOf, VOICE_PACES, VOICE_STYLES,
  type ResolvedVoiceSettings, type ThinkingLevel, type VoiceSettingsErrors, type VoiceSpeech,
} from "@/lib/voice/settings";
import type { VoiceModelChoice } from "@/lib/voice/model-choices";
import {
  DEFAULT_ELEVEN_MODEL, DEFAULT_ELEVEN_STABILITY, DEFAULT_ELEVEN_VOICE, ELEVEN_LANGUAGE_SUBSTITUTE, ELEVEN_MODELS, ELEVEN_STABILITIES, elevenChoiceText, elevenLanguageLine,
  elevenModelInfo, elevenModelLanguages, elevenModelOptionLabel, elevenModelSpeaks, elevenVoiceGroups, elevenVoiceLine, languageName, sampleLanguagesFor, type ElevenModelId, type ElevenStability, type ElevenVoiceId, type SampleLanguage,
} from "@/lib/voice-rt-eleven/catalog";

export type VoiceSettingsFormState = { ok?: boolean; errors?: VoiceSettingsErrors; failed?: boolean };

const STABILITY_WORD = { 0: "expressive", 0.5: "natural", 1: "steady" } as const satisfies Record<ElevenStability, string>;

/** A segmented choice (real radio buttons, so arrow keys work). */
function Segmented<T extends string>({ name, label, value, options, onChange, describedBy }: {
  name: string; label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; describedBy?: string;
}) {
  return (
    <fieldset className="sas-vs-field" aria-describedby={describedBy}>
      <legend className="sas-input-label">{label}</legend>
      <span className="sas-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <label key={o.value} className="sas-seg__opt" data-on={value === o.value ? "" : undefined}>
            <input type="radio" className="sas-sr" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </span>
    </fieldset>
  );
}

/**
 * "Play sample" (design review, 24 Nov): one button per sample language (the company's selling languages the model
 * speaks), on its own line under the voice's helper line, side by side (small buttons; they wrap only when they do not fit). It plays the CURRENT (unsaved) model, voice and steadiness
 * through the server (app/app/[account]/voice-sample, platform admins only; generated once per combination, then
 * replayed from storage). While loading it is busy; while playing it reads "Stop" at the same width (the labels share
 * one grid cell); starting another sample stops the first; leaving the panel stops it. Errors: one quiet line.
 */
function SampleButtons({ slug, model, voice, stability, languages }: { slug: string; model: string; voice: string; stability: number; languages: readonly string[] }) {
  const langs = sampleLanguagesFor(model, languages);
  const [now, setNow] = useState<{ lang: SampleLanguage; phase: "loading" | "playing" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const seq = useRef(0);
  const release = () => {
    seq.current++;
    audio.current?.pause();
    audio.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  useEffect(() => release, []);
  if (!langs.length) return null;
  const play = async (lang: SampleLanguage) => {
    const wasThis = now?.lang === lang;
    release();
    setNow(null);
    setError(null);
    if (wasThis) return; // the button was "Stop" (or still loading): stopped
    const my = seq.current;
    setNow({ lang, phase: "loading" });
    try {
      const r = await fetch(`/app/${encodeURIComponent(slug)}/voice-sample`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, voice, stability, language: lang }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `error ${r.status}`);
      const blob = await r.blob();
      if (my !== seq.current) return;
      const u = URL.createObjectURL(blob);
      objectUrl.current = u;
      const a = new Audio(u);
      audio.current = a;
      a.onended = () => {
        if (my !== seq.current) return;
        release();
        setNow(null);
      };
      setNow({ lang, phase: "playing" });
      await a.play();
    } catch (e) {
      if (my !== seq.current) return;
      release();
      setNow(null);
      setError(String((e as { message?: unknown })?.message ?? e).slice(0, 120));
    }
  };
  return (
    <div className="sas-stack-2" data-voice-samples="">
      <span className="sas-vs-samples">
        {langs.map((l) => {
          const label = langs.length > 1 ? t("voice.settings.sample_lang", { language: languageName(l) }) : t("voice.settings.sample");
          const phase = now?.lang === l ? now.phase : null;
          return (
            <button key={l} type="button" className={`${buttonClass("secondary", "sm")} sas-vs-sample`} onClick={() => void play(l)}
              aria-busy={phase === "loading" ? true : undefined} data-voice-sample={l} data-phase={phase ?? "idle"}>
              <Icon name={phase === "playing" ? "pause" : phase === "loading" ? "loader" : "play"} />
              {/* All three labels share one grid cell: the button keeps its width when it reads "Stop". */}
              <span className="sas-vs-sample__labels">
                <span data-on={phase === null ? "" : undefined}>{label}</span>
                <span data-on={phase === "loading" ? "" : undefined}>{t("voice.settings.sample_loading")}</span>
                <span data-on={phase === "playing" ? "" : undefined}>{t("voice.settings.sample_stop")}</span>
              </span>
            </button>
          );
        })}
      </span>
      {error ? <span className="sas-small" role="status" data-voice-sample-error="">{t("voice.settings.sample_error", { reason: error })}</span> : null}
    </div>
  );
}

/** One of the panel's three sections, with its small heading. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="sas-vs-section" aria-labelledby={`vs-sec-${id}`} data-vs-section={id}>
      <h3 className="sas-vs-section__title" id={`vs-sec-${id}`}>{title}</h3>
      {children}
    </section>
  );
}

/**
 * A section's ONE fold (UX review, 25 Nov): a native <details> labelled "More options" (its <summary> is focusable and
 * announces expanded/collapsed by itself), closed by default and open when a value inside differs from its default.
 * Closed with changed values inside: "More options · 2 changed" (one unit that never wraps apart). Its last line: the
 * section's controls this model does not have ("Not on this model: …"), plain text, only when there are any.
 */
function MoreOptions({ id, changed, missing, openKey, note, children }: { id: string; changed: number; missing: string[]; openKey: string; note?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(changed > 0);
  // Another model (or "Voice from") brings back a non-default value inside: the fold opens to show it.
  const [seenKey, setSeenKey] = useState(openKey);
  if (seenKey !== openKey) {
    setSeenKey(openKey);
    if (changed > 0 && !open) setOpen(true);
  }
  return (
    <details className="sas-vs-more" open={open} onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)} data-vs-more={id} data-changed={changed || undefined}>
      <summary>
        <Icon name="chevron-down" />
        <span className="sas-vs-more__title">
          {t("voice.settings.more")}
          {moreOptionsCount(changed, open) ? <span className="sas-vs-more__count" data-vs-more-count="">{` · ${t("voice.settings.more_changed", { count: changed })}`}</span> : null}
        </span>
      </summary>
      <div className="sas-vs-more__body">
        {children}
        {missing.length ? <p className="sas-small sas-muted sas-vs-missing" data-vs-missing="">{t("voice.settings.not_on_model", { list: missing.join(", ") })}</p> : null}
        {/* The section's test-only note, when every control it names is in this fold. */}
        {note}
      </div>
    </details>
  );
}

/** "A, B and C" (English list) for the set-aside line. */
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The voice settings of the draft version (board VoiceSettingsPanel), inside the test lab's side panel. ONE panel for
 * every voice model (owner, 25 Nov 2026): the same sections, rows and order everywhere; a control the model does not
 * have is simply not shown (never disabled), and the rows that remain keep their order.
 * 1. "Voice model": the model select (from the model list, so new entries appear by themselves) with its hint lines;
 *    for an end-to-end ElevenLabs realtime model the test-only helper; "Voice from" (GPT-Realtime only).
 * 2. "Voice": [with ElevenLabs: the speaking model and its language line], the voice, Play sample (ElevenLabs), the
 *    speaking pace; More options: Steadiness (ElevenLabs dialogue models), Filler phrases; then, as the section's last
 *    lines, "Test calls hear" / "Buyers hear" (ElevenLabs).
 * 3. "Conversation": conversation style, longest call; More options: pause before answering, interruption
 *    sensitivity, turn ending (GPT-Realtime), thinking effort (GPT-Realtime 2.1), protect the opening line (every model).
 * Each section has exactly one "More options" fold (MoreOptions). Controls that run on test calls only for now get ONE
 * note per section. Switching the model (or "Voice from") sets aside the values of controls the new choice does not
 * have, with one line under the model select; switching back before saving restores them (they stay in the form's
 * state; hidden controls are not posted, so the server does not store them for that model). The whole panel is platform
 * admins only, and the server ignores "Voice from" and the ElevenLabs fields from anyone else. `action` saves to the
 * draft on the server and checks the role there.
 */
export function VoiceSettingsForm({
  action,
  slug,
  models,
  platformModel,
  initial,
  version,
  closeHref,
  deploymentLimitSec,
  elevenForBuyers = false,
  languages = ["en"],
}: {
  action: (prev: VoiceSettingsFormState, form: FormData) => Promise<VoiceSettingsFormState>;
  slug: string;
  /** The models a version may pick, with what each supports and its cost hint (lib/voice/model-choices.ts). */
  models: VoiceModelChoice[];
  /** The platform's default model: what a version without its own model uses. */
  platformModel: string;
  initial: ResolvedVoiceSettings;
  version: number;
  closeHref: string;
  /** This deployment ends test calls sooner than the setting (the hosting function's limit), or null. */
  deploymentLimitSec: number | null;
  /** Buyer calls hear ElevenLabs too (server constant ELEVEN_FOR_BUYER_CALLS): no "Buyers hear" group. */
  elevenForBuyers?: boolean;
  /** The company's selling languages (the account's buyer languages, e.g. ["en", "he"]): the ElevenLabs language lines. */
  languages?: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const cap = deploymentLimitSec && deploymentLimitSec < PLATFORM_MAX_CALL_SEC ? deploymentLimitSec : null;
  const options_ = limitOptions(cap);
  // A stored value above this deployment's cap shows (and saves) as the cap.
  const clampMax = (x: ResolvedVoiceSettings) => ({ ...x, maxCallSec: Math.min(x.maxCallSec, options_[options_.length - 1]) });
  const [v, setV] = useState<ResolvedVoiceSettings>(() => clampMax(initial));
  const set = <K extends keyof ResolvedVoiceSettings>(k: K, val: ResolvedVoiceSettings[K]) => setV((x) => ({ ...x, [k]: val }));
  const modelId = v.model ?? platformModel;
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const caps = model.caps;
  // The voice a model change replaced (one line under Voice until the voice or the model changes again).
  const [voiceNote, setVoiceNote] = useState<{ from: string; to: string } | null>(null);
  // "Voice from" was set back to the model's own voice by a switch to a model ElevenLabs does not work with.
  const [speechReset, setSpeechReset] = useState(false);
  // The model or "Voice from" was switched in this panel: the set-aside line may show.
  const [switched, setSwitched] = useState(false);
  // "Buyers hear" is collapsed until "Change" opens it.
  const [buyersOpen, setBuyersOpen] = useState(false);
  const pickModel = (id: string) => {
    const next = models.find((m) => m.id === id);
    if (!next) return;
    setVoiceNote(voiceChangeOnModel(v.voice, next.caps));
    const sp = speechAfterModelSwitch(v.speech, next.id);
    setSpeechReset(sp.reset);
    setSwitched(true);
    setV((x) => ({ ...x, model: next.id as ResolvedVoiceSettings["model"], voice: x.voice && next.caps.voices.includes(x.voice) ? x.voice : null, speech: sp.speech }));
  };
  const speechOffered = isOpenAiVoiceModel(model.id);
  const eleven = speechOffered && v.speech === "elevenlabs";
  // ElevenLabs Realtime (its own family; test calls only, buyer calls use the platform default model).
  const e2eEleven = voiceFamilyOf(model.id) === "elevenlabs";
  // ElevenLabs for buyers too: the model's own voice (and its fillers) is heard by nobody, so its group is not shown.
  const buyersGroup = !(eleven && elevenForBuyers);
  const options = voiceOptions(caps);
  const voiceValue = v.voice && options.some((o) => o.value === v.voice) ? v.voice : "";
  const heard = voiceValue || defaultVoiceOf(caps);
  const e = state.errors ?? {};
  // What the style alone sets (the default of the pause; GPT's interruption level too).
  const fromStyle = styleTurnTaking(v.style);
  const gpt = voiceFamilyOf(model.id) === "openai";
  const styleInterrupt = fromStyle.threshold >= 0.6 ? "low" : fromStyle.threshold <= 0.45 ? "high" : "medium";
  const pauses: number[] = [];
  for (let ms = PAUSE_MS_RANGE.min; ms <= PAUSE_MS_RANGE.max; ms += PAUSE_MS_RANGE.step) pauses.push(ms);
  const smart = caps.turnEnd && v.turnEnd === "smart";

  // ElevenLabs: the speaking model, voice and steadiness.
  const elModel: ElevenModelId = v.elevenModel ?? DEFAULT_ELEVEN_MODEL;
  const elInfo = elevenModelInfo(elModel)!;
  const elVoice: ElevenVoiceId = v.elevenVoice ?? DEFAULT_ELEVEN_VOICE;
  const elStability: ElevenStability = v.elevenStability ?? DEFAULT_ELEVEN_STABILITY;
  const langLine = elevenLanguageLine(elModel, languages);
  // The selling languages the chosen model does not speak: a call speaks them with the substitute model (the speaker's
  // chainFor in lib/voice-rt-eleven/speaker.ts switches exactly when elevenModelSpeaks(...) === false).
  const substituted = elevenModelLanguages(elModel, languages).missing.filter((l) => elevenModelSpeaks(elModel, l) === false);
  const testHears = elevenChoiceText({ model: elModel, voice: elVoice }, { short: true })
    + (substituted.length ? ` (${substituted.map(languageName).join(", ")}: ${elevenModelInfo(ELEVEN_LANGUAGE_SUBSTITUTE)!.label})` : "");

  // Which rows this model (and "Voice from") has, the fold rows that differ from their defaults, and what is set aside.
  const shown = panelRows(caps, { eleven, elevenDialogue: eleven && elInfo.dialogue });
  const changedOf = (rows: readonly PanelRow[]) => rows.filter((r) => shown.has(r) && rowChanged(r, v)).length;
  const missingOf = (rows: readonly PanelRow[]) => rows.filter((r) => !shown.has(r)).map((r) => t(ROW_LABEL[r]));
  const setAside = switched ? setAsideRows(shown, v).map((r) => t(ROW_LABEL[r])) : [];
  // The controls of a section that run on test calls only for now (one note per section).
  // In the panel's order; inside the fold when every control it names is in the fold, else at the section's end.
  const testOnlyIds = CONVERSATION_ROWS.filter((r) => shown.has(r) && testOnlyRows(model.id).includes(r));
  const testOnly = testOnlyIds.map((r) => t(ROW_LABEL[r]));
  const testNoteInFold = testOnlyIds.every((r) => CONVERSATION_FOLD.includes(r));
  // The folds open by themselves when the model (or "Voice from") changes and a value inside is not its default.
  const foldKey = `${model.id}:${eleven ? "el" : "own"}`;

  const fillers = (
    <label className="sas-switch-row" data-vs-row="fillers">
      <input type="checkbox" role="switch" className="sas-switch" name="fillers" checked={v.fillers} onChange={(ev) => set("fillers", ev.target.checked)} aria-describedby="vs-fillers-hint" />
      <span className="sas-stack-2" style={{ gap: 2 }}>
        <b>{t("voice.settings.fillers")}</b>
        <span className="sas-small" id="vs-fillers-hint">{t(eleven ? "voice.settings.fillers_hint_buyers" : "voice.settings.fillers_hint")}</span>
      </span>
    </label>
  );
  // The model's own voice picker (with ElevenLabs: what buyers hear).
  const voicePicker = (hint: string) => (
    <div className="sas-input-group" data-voice-name-field="" data-vs-row="voice">
      <label className={eleven ? "sas-input-label" : "sas-input-label sas-sr"} htmlFor="vs-voice">{t("voice.settings.voice")}</label>
      <select className="sas-select" id="vs-voice" name="voice" aria-describedby="vs-voice-hint" value={voiceValue} onChange={(ev) => { setVoiceNote(null); set("voice", ev.target.value || null); }} aria-invalid={e.voice ? true : undefined}>
        {options.map((o) => <option key={o.value || "default"} value={o.value}>{o.isDefault ? t("voice.settings.default", { label: o.label }) : o.label}</option>)}
      </select>
      {voiceNote ? <span className="sas-small" role="status" data-voice-changed="">{t("voice.settings.voice_changed", voiceNote)}</span> : null}
      <span className="sas-small" id="vs-voice-hint">{hint}</span>
      {e.voice ? <span className="sas-small sas-vs-err" role="alert">{e.voice}</span> : null}
    </div>
  );
  const longest = (
    <div className="sas-input-group" data-vs-row="max">
      <label className="sas-input-label" htmlFor="vs-max">{t("voice.settings.max")}</label>
      <select className="sas-select sas-vs-max" id="vs-max" name="maxCallSec" value={v.maxCallSec} onChange={(ev) => set("maxCallSec", Number(ev.target.value))} aria-invalid={e.maxCallSec ? true : undefined}>
        {options_.map((sec) => <option key={sec} value={sec}>{callLimitShort(sec)}</option>)}
      </select>
      {cap ? <span className="sas-small">{t("voice.settings.max_hint", { limit: callLimitShort(cap) })}</span> : null}
      {e.maxCallSec ? <span className="sas-small sas-vs-err" role="alert">{e.maxCallSec}</span> : null}
    </div>
  );
  const pace = caps.pace ? (
    <div data-vs-row="pace">
      <Segmented name="pace" label={t("voice.settings.pace")} value={v.pace} onChange={(x) => set("pace", x)}
        options={VOICE_PACES.map((p) => ({ value: p, label: t(`voice.settings.pace.${p}`) }))} />
    </div>
  ) : null;

  // VOICE: the voice rows (ElevenLabs: its speaking model, its voice and Play sample; else the model's own voice).
  const voiceRows = eleven ? (
    <>
      <div className="sas-input-group" data-voice-eleven-model-field="" data-vs-row="elevenModel">
        <label className="sas-input-label" htmlFor="vs-eleven-model">{t("voice.settings.eleven_model")}</label>
        <select className="sas-select" id="vs-eleven-model" name="elevenModel" value={elModel} onChange={(ev) => set("elevenModel", ev.target.value as ElevenModelId)}
          aria-describedby="vs-eleven-model-note vs-eleven-model-lang" aria-invalid={e.elevenModel ? true : undefined}>
          {ELEVEN_MODELS.map((m) => <option key={m.id} value={m.id}>{elevenModelOptionLabel(m.id, languages)}</option>)}
        </select>
        {/* One muted line (the note and the facts); the language line under it is the one that stands out. */}
        <span className="sas-small sas-muted" id="vs-eleven-model-note" data-voice-eleven-note="">
          {`${elInfo.note} ${t("voice.settings.eleven_model_meta", { languages: elInfo.languages.count, price: elInfo.usdPer1kChars.toFixed(2) })}.`}
        </span>
        {langLine.tone === "warning" ? (
          <span className="sas-small sas-vs-warn" id="vs-eleven-model-lang" role="status" data-voice-eleven-lang="warning"><Icon name="alert-triangle" /><span>{langLine.text}</span></span>
        ) : <span className="sas-small sas-vs-lang" id="vs-eleven-model-lang" data-voice-eleven-lang="neutral">{langLine.text}</span>}
        {e.elevenModel ? <span className="sas-small sas-vs-err" role="alert">{e.elevenModel}</span> : null}
      </div>
      <div className="sas-input-group" data-voice-eleven-voice-field="" data-vs-row="voice">
        <label className="sas-input-label" htmlFor="vs-eleven-voice">{t("voice.settings.eleven_voice")}</label>
        <select className="sas-select" id="vs-eleven-voice" name="elevenVoice" value={elVoice} onChange={(ev) => set("elevenVoice", ev.target.value as ElevenVoiceId)}
          aria-describedby="vs-eleven-voice-hint" aria-invalid={e.elevenVoice ? true : undefined}>
          {elevenVoiceGroups().map((g) => (
            <optgroup key={g.gender} label={g.label}>
              {g.voices.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </optgroup>
          ))}
        </select>
        <span className="sas-small" id="vs-eleven-voice-hint" data-voice-eleven-voice-line="">{elevenVoiceLine(elevenModelLanguages(elModel, languages).supported)}</span>
        <SampleButtons slug={slug} model={elModel} voice={elVoice} stability={elInfo.dialogue ? elStability : DEFAULT_ELEVEN_STABILITY} languages={languages} />
        {e.elevenVoice ? <span className="sas-small sas-vs-err" role="alert">{e.elevenVoice}</span> : null}
      </div>
    </>
  ) : caps.voices.length ? voicePicker(t("voice.settings.voice_hint")) : (
    <div className="sas-vs-line" data-voice-model-default="" data-vs-row="voice">
      <span className="sas-vs-line__value">{t("voice.settings.model_default_voice")}</span>
    </div>
  );

  // VOICE, after its fold: what test calls and buyers hear (ElevenLabs).
  const hearLines = eleven ? (
    <>
      <div className="sas-vs-line" data-voice-test-hears="">
        <span className="sas-vs-line__value">{`${t(elevenForBuyers ? "voice.settings.all_hear" : "voice.settings.test_hears")}: `}<output data-voice-test-voice="">{testHears}</output></span>
      </div>
      {caps.voices.length && buyersGroup ? (
        <div className="sas-input-group" data-voice-buyers-hear="" data-open={buyersOpen ? "" : undefined}>
          <span className="sas-vs-line">
            <span className="sas-vs-line__value" data-voice-buyers-summary="">
              {t("voice.settings.buyers_hear_value", { voice: heard ? voiceLabel(heard).split(" · ")[0] : "—", fillers: t(`voice.settings.fillers_state.${caps.fillers && v.fillers ? "on" : "off"}`) })}
            </span>
            <button type="button" className={buttonClass("ghost")} aria-expanded={buyersOpen} aria-controls="vs-buyers-body" onClick={() => setBuyersOpen((o) => !o)} data-voice-buyers-toggle="">
              {t(buyersOpen ? "voice.settings.hide" : "voice.settings.change")}
            </button>
          </span>
          {/* Collapsed with `hidden`: its field still posts (the buyers' voice is saved either way). */}
          <div className="sas-stack-2" id="vs-buyers-body" hidden={!buyersOpen}>
            {voicePicker(t("voice.settings.voice_hint_buyers"))}
          </div>
        </div>
      ) : null}
      {caps.voices.length && !buyersGroup ? <input type="hidden" name="voice" value={voiceValue} /> : null}
    </>
  ) : null;

  const testNote = (rows: string[]) => rows.length
    ? <p className="sas-small sas-muted sas-vs-testing" data-vs-testing="">{t("voice.settings.testing_note", { list: rows.join(", ") })}</p>
    : null;

  return (
    <form action={formAction} className="sas-vs-form" data-voice-settings="" data-vs-model={model.id}>
      <input type="hidden" name="slug" value={slug} />
      <div className="sas-vs-body">
        {state.failed || Object.keys(e).length ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("voice.settings.error")}</span></div> : null}
        <Section id="model" title={t("voice.settings.section.model")}>
          <div className="sas-input-group" data-voice-model-field="">
            <label className="sas-input-label sas-sr" htmlFor="vs-model">{t("voice.settings.model")}</label>
            <select className="sas-select" id="vs-model" name="model" value={model.id} onChange={(ev) => pickModel(ev.target.value)} aria-describedby="vs-model-hint" aria-invalid={e.model ? true : undefined}>
              {models.map((m) => <option key={m.id} value={m.id}>{`${m.label} · ${m.short}`}</option>)}
            </select>
            {setAside.length ? (
              <span className="sas-small sas-vs-info" role="status" data-vs-set-aside="">
                <Icon name="info" />
                <span>{t(setAside.length === 1 ? "voice.settings.set_aside_one" : "voice.settings.set_aside", { list: listText(setAside) })}</span>
              </span>
            ) : null}
            <span className="sas-small" id="vs-model-hint">
              {model.note}
              {model.proven ? null : <> <span className="sas-muted" data-voice-model-unproven="">{t("voice.settings.model_unproven")}</span></>}
            </span>
            <span className="sas-small sas-muted" data-voice-model-cost="">{model.costHint}</span>
            {e2eEleven ? <span className="sas-small" data-voice-e2e-hint="">{t("voice.settings.e2e_test_only")}</span> : null}
            {e.model ? <span className="sas-small sas-vs-err" role="alert">{e.model}</span> : null}
            {speechReset ? <span className="sas-small" role="status" data-voice-speech-reset="">{t("voice.settings.speech_reset")}</span> : null}
          </div>
          {speechOffered ? (
            <div className="sas-input-group" data-voice-speech-field="">
              <label className="sas-input-label" htmlFor="vs-speech">{t("voice.settings.speech")}</label>
              <select className="sas-select" id="vs-speech" name="speech" value={eleven ? "elevenlabs" : "model"}
                onChange={(ev) => { setSpeechReset(false); setSwitched(true); set("speech", ev.target.value as VoiceSpeech); }}
                aria-describedby={eleven ? "vs-speech-hint" : undefined} aria-invalid={e.speech ? true : undefined}>
                <option value="model">{t("voice.settings.speech.model")}</option>
                <option value="elevenlabs">{t("voice.settings.speech.elevenlabs")}</option>
              </select>
              {eleven ? <span className="sas-small" id="vs-speech-hint" data-voice-speech-hint="">{t(elevenForBuyers ? "voice.settings.speech_hint_all" : "voice.settings.speech_hint")}</span> : null}
              {e.speech ? <span className="sas-small sas-vs-err" role="alert">{e.speech}</span> : null}
            </div>
          ) : <input type="hidden" name="speech" value="model" />}
        </Section>
        <Section id="voice" title={t("voice.settings.section.voice")}>
          {voiceRows}
          {pace}
          <MoreOptions id="voice" changed={changedOf(VOICE_FOLD)} missing={missingOf(VOICE_FOLD)} openKey={foldKey}>
            {shown.has("stability") ? (
              <div className="sas-stack-2" data-voice-eleven-stability="" data-vs-row="stability">
                <Segmented name="elevenStability" label={t("voice.settings.eleven_stability")} value={String(elStability)} describedBy="vs-eleven-stability-hint"
                  onChange={(x) => set("elevenStability", Number(x) as ElevenStability)}
                  options={ELEVEN_STABILITIES.map((s) => ({ value: String(s), label: t(`voice.settings.eleven_stability.${STABILITY_WORD[s]}`) }))} />
                <span className="sas-small" id="vs-eleven-stability-hint">{t("voice.settings.eleven_stability_hint")}</span>
                {e.elevenStability ? <span className="sas-small sas-vs-err" role="alert">{e.elevenStability}</span> : null}
              </div>
            ) : null}
            {shown.has("fillers") ? fillers : null}
          </MoreOptions>
          {hearLines}
        </Section>
        <Section id="conversation" title={t("voice.settings.section.conversation")}>
          {shown.has("style") ? (
            <div className="sas-stack-2" data-vs-row="style">
              <Segmented name="style" label={t("voice.settings.style")} value={v.style} onChange={(x) => set("style", x)} describedBy="vs-style-hint"
                options={VOICE_STYLES.map((p) => ({ value: p, label: t(`voice.settings.style.${p}`) }))} />
              <span className="sas-small" id="vs-style-hint">{t("voice.settings.style_hint")}</span>
            </div>
          ) : null}
          {longest}
          <MoreOptions id="conversation" changed={changedOf(CONVERSATION_FOLD)} missing={missingOf(CONVERSATION_ROWS)} openKey={foldKey} note={testNoteInFold ? testNote(testOnly) : null}>
            {shown.has("turnEnd") ? (
              <div className="sas-stack-2" data-vs-row="turnEnd">
                <Segmented name="turnEnd" label={t("voice.settings.turn_end")} value={v.turnEnd ?? "pause"} onChange={(x) => set("turnEnd", x)} describedBy="vs-turn-end-hint"
                  options={TURN_ENDS.map((x) => ({ value: x, label: t(`voice.settings.turn_end.${x}`) }))} />
                <span className="sas-small" id="vs-turn-end-hint">{t("voice.settings.turn_end_hint")}</span>
                {e.turnEnd ? <span className="sas-small sas-vs-err" role="alert">{e.turnEnd}</span> : null}
              </div>
            ) : null}
            {shown.has("pause") ? (
              <div className="sas-input-group" data-vs-row="pause" data-vs-inert={smart ? "" : undefined}>
                {/* Smart: read-only, its value still posted (kept for Fixed pause). */}
                {smart ? <input type="hidden" name="pauseMs" value={v.pauseMs ?? ""} /> : null}
                <label className="sas-input-label" htmlFor="vs-pause">{t("voice.settings.pause")}</label>
                <select className="sas-select" id="vs-pause" name={smart ? undefined : "pauseMs"} disabled={smart} value={v.pauseMs ?? ""} onChange={(ev) => set("pauseMs", ev.target.value ? Number(ev.target.value) : null)} aria-describedby="vs-pause-hint" aria-invalid={e.pauseMs ? true : undefined}>
                  {/* Gemini with nothing to send (default style, no interruption level): Google's own pause. */}
                  <option value="">{!gpt && !geminiActivityDetectionFor({ ...v, pauseMs: null }) ? t("voice.settings.model_default_option") : t("voice.settings.from_style", { value: `${(fromStyle.silenceMs / 1000).toFixed(1)} s` })}</option>
                  {pauses.map((ms) => <option key={ms} value={ms}>{(ms / 1000).toFixed(1)} s</option>)}
                </select>
                <span className="sas-small" id="vs-pause-hint">{t(smart ? "voice.settings.smart_decides" : "voice.settings.pause_hint")}</span>
                {e.pauseMs ? <span className="sas-small sas-vs-err" role="alert">{e.pauseMs}</span> : null}
              </div>
            ) : null}
            {shown.has("interrupt") ? (
              <div className="sas-input-group" data-vs-row="interrupt" data-vs-inert={smart ? "" : undefined}>
                {smart ? <input type="hidden" name="interrupt" value={v.interrupt ?? ""} /> : null}
                <label className="sas-input-label" htmlFor="vs-interrupt">{t("voice.settings.interrupt")}</label>
                <select className="sas-select" id="vs-interrupt" name={smart ? undefined : "interrupt"} disabled={smart} value={v.interrupt ?? ""} onChange={(ev) => set("interrupt", (ev.target.value || null) as ResolvedVoiceSettings["interrupt"])} aria-describedby="vs-interrupt-hint" aria-invalid={e.interrupt ? true : undefined}>
                  <option value="">{gpt ? t("voice.settings.from_style", { value: t(`voice.settings.${styleInterrupt}`) }) : t("voice.settings.model_default_option")}</option>
                  {INTERRUPT_LEVELS.map((l) => <option key={l} value={l}>{t(`voice.settings.${l}`)}</option>)}
                </select>
                <span className="sas-small" id="vs-interrupt-hint">{t(smart ? "voice.settings.smart_decides" : "voice.settings.interrupt_hint")}</span>
                {e.interrupt ? <span className="sas-small sas-vs-err" role="alert">{e.interrupt}</span> : null}
              </div>
            ) : null}
            {shown.has("thinking") ? (
              <div className="sas-input-group" data-vs-row="thinking">
                <label className="sas-input-label" htmlFor="vs-thinking">{t("voice.settings.thinking")}</label>
                <select className="sas-select" id="vs-thinking" name="thinking" value={v.thinking ?? "default"} onChange={(ev) => set("thinking", ev.target.value as ThinkingLevel)} aria-describedby="vs-thinking-hint" aria-invalid={e.thinking ? true : undefined}>
                  {THINKING_LEVELS.map((x) => <option key={x} value={x}>{t(`voice.settings.thinking.${x}`)}</option>)}
                </select>
                <span className="sas-small" id="vs-thinking-hint">{t("voice.settings.thinking_hint")}</span>
                {e.thinking ? <span className="sas-small sas-vs-err" role="alert">{e.thinking}</span> : null}
              </div>
            ) : null}
            {shown.has("opener") ? (
              <label className="sas-switch-row" data-vs-row="opener">
                <input type="hidden" name="openerProtectedShown" value="1" />
                <input type="checkbox" role="switch" className="sas-switch" name="openerProtected" checked={v.openerProtected !== false} onChange={(ev) => set("openerProtected", ev.target.checked)} aria-describedby="vs-opener-hint" />
                <span className="sas-stack-2" style={{ gap: 2 }}>
                  <b>{t("voice.settings.opener")}</b>
                  <span className="sas-small" id="vs-opener-hint">{t("voice.settings.opener_hint")}</span>
                </span>
              </label>
            ) : null}
          </MoreOptions>
          {testNoteInFold ? null : testNote(testOnly)}
        </Section>
      </div>
      <div className="sas-vs-foot">
        <p className="sas-small sas-vs-note">{t("voice.settings.note", { version })}</p>
        <div className="sas-vs-actions">
          <button type="submit" className={buttonClass("primary")} disabled={pending} data-voice-save="">{pending ? t("voice.settings.saving") : t("voice.settings.save")}</button>
          <a className={buttonClass("ghost")} href={closeHref}>{t("voice.settings.cancel")}</a>
          <button type="button" className={`${buttonClass("ghost")} sas-vs-reset`} onClick={() => setV(clampMax({ ...DEFAULT_VOICE_SETTINGS, model: v.model }))}>{t("voice.settings.reset")}</button>
        </div>
      </div>
    </form>
  );
}

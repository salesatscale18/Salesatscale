"use client";

import { useActionState, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { callLimitShort, defaultVoiceOf, hasAdvancedTuning, limitOptions, voiceOptions } from "@/lib/voice/lab";
import { DEFAULT_VOICE_SETTINGS, INTERRUPT_LEVELS, PAUSE_MS_RANGE, PLATFORM_MAX_CALL_SEC, VOICE_PACES, VOICE_STYLES, turnTakingFor, type ResolvedVoiceSettings, type VoiceSettingsErrors } from "@/lib/voice/settings";
import type { VoiceModelChoice } from "@/lib/voice/model-choices";

export type VoiceSettingsFormState = { ok?: boolean; errors?: VoiceSettingsErrors; failed?: boolean };

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
 * The voice settings of the draft version (board VoiceSettingsPanel), inside
 * the test lab's side panel. "Voice model" comes first; the rest shows only what
 * the chosen model supports (its capabilities, passed in from the server per
 * model, so changing the model re-renders the settings before saving).
 * Unsupported settings are hidden, never disabled. When nothing but "Filler
 * phrases" and "Longest call" is left of the advanced settings, there is no
 * "Advanced" fold. The footer stays at the bottom of the panel. `action` saves
 * to the draft on the server and checks the role there.
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
  sampleUrl,
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
  /** A short sample of a voice, where one exists. Without it the Listen button is not shown. */
  sampleUrl?: (voice: string) => string | null;
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
  /** Another model: its own voices (a voice it does not have goes back to its default), the rest as it supports. */
  const pickModel = (id: string) => {
    const next = models.find((m) => m.id === id);
    if (!next) return;
    setV((x) => ({ ...x, model: next.id as ResolvedVoiceSettings["model"], voice: x.voice && next.caps.voices.includes(x.voice) ? x.voice : null }));
  };
  const options = voiceOptions(caps);
  const voiceValue = v.voice && options.some((o) => o.value === v.voice) ? v.voice : "";
  const heard = voiceValue || defaultVoiceOf(caps);
  const sample = heard ? sampleUrl?.(heard) ?? null : null;
  const advanced = hasAdvancedTuning(caps);
  const e = state.errors ?? {};
  // What the style alone would set (shown as the default of the two Advanced values).
  const fromStyle = turnTakingFor(v.style, caps.pauseMs ? model.id : "") ?? { silenceMs: 600, threshold: 0.5 };
  const styleInterrupt = fromStyle.threshold >= 0.6 ? "low" : fromStyle.threshold <= 0.45 ? "high" : "medium";
  const pauses: number[] = [];
  for (let ms = PAUSE_MS_RANGE.min; ms <= PAUSE_MS_RANGE.max; ms += PAUSE_MS_RANGE.step) pauses.push(ms);

  const fillers = (
    <label className="sas-switch-row">
      <input type="checkbox" role="switch" className="sas-switch" name="fillers" checked={v.fillers} onChange={(ev) => set("fillers", ev.target.checked)} aria-describedby="vs-fillers-hint" />
      <span className="sas-stack-2" style={{ gap: 2 }}>
        <b>{t("voice.settings.fillers")}</b>
        <span className="sas-small" id="vs-fillers-hint">{t("voice.settings.fillers_hint")}</span>
      </span>
    </label>
  );
  const longest = (
    <div className="sas-input-group">
      <label className="sas-input-label" htmlFor="vs-max">{t("voice.settings.max")}</label>
      <select className="sas-select sas-vs-max" id="vs-max" name="maxCallSec" value={v.maxCallSec} onChange={(ev) => set("maxCallSec", Number(ev.target.value))} aria-invalid={e.maxCallSec ? true : undefined}>
        {options_.map((sec) => <option key={sec} value={sec}>{callLimitShort(sec)}</option>)}
      </select>
      {cap ? <span className="sas-small">{t("voice.settings.max_hint", { limit: callLimitShort(cap) })}</span> : null}
      {e.maxCallSec ? <span className="sas-small sas-vs-err" role="alert">{e.maxCallSec}</span> : null}
    </div>
  );

  return (
    <form action={formAction} className="sas-vs-form" data-voice-settings="">
      <input type="hidden" name="slug" value={slug} />
      <div className="sas-vs-body">
        {state.failed || Object.keys(e).length ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("voice.settings.error")}</span></div> : null}
        <div className="sas-input-group" data-voice-model-field="">
          <label className="sas-input-label" htmlFor="vs-model">{t("voice.settings.model")}</label>
          <select className="sas-select" id="vs-model" name="model" value={model.id} onChange={(ev) => pickModel(ev.target.value)} aria-describedby="vs-model-hint" aria-invalid={e.model ? true : undefined}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span className="sas-small" id="vs-model-hint">
            {model.note}
            {model.proven ? null : <> <span className="sas-muted" data-voice-model-unproven="">{t("voice.settings.model_unproven")}</span></>}
          </span>
          <span className="sas-small sas-muted" data-voice-model-cost="">{model.costHint}</span>
          {e.model ? <span className="sas-small sas-vs-err" role="alert">{e.model}</span> : null}
        </div>
        {caps.voices.length ? (
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="vs-voice">{t("voice.settings.voice")}</label>
            <span className="sas-vs-row">
              <select className="sas-select" id="vs-voice" name="voice" aria-describedby={sample ? undefined : "vs-voice-hint"} value={voiceValue} onChange={(ev) => set("voice", ev.target.value || null)} aria-invalid={e.voice ? true : undefined}>
                {options.map((o) => <option key={o.value || "default"} value={o.value}>{o.isDefault ? t("voice.settings.default", { label: o.label }) : o.label}</option>)}
              </select>
              {sample ? (
                <button type="button" className={buttonClass("secondary")} onClick={() => void new Audio(sample).play().catch(() => undefined)}>
                  <Icon name="play" />{t("voice.settings.listen")}
                </button>
              ) : null}
            </span>
            {sample ? null : <span className="sas-small" id="vs-voice-hint">{t("voice.settings.voice_hint")}</span>}
            {e.voice ? <span className="sas-small sas-vs-err" role="alert">{e.voice}</span> : null}
          </div>
        ) : null}
        {caps.pace ? (
          <Segmented name="pace" label={t("voice.settings.pace")} value={v.pace} onChange={(x) => set("pace", x)}
            options={VOICE_PACES.map((p) => ({ value: p, label: t(`voice.settings.pace.${p}`) }))} />
        ) : null}
        {caps.style ? (
          <div className="sas-stack-2">
            <Segmented name="style" label={t("voice.settings.style")} value={v.style} onChange={(x) => set("style", x)} describedBy="vs-style-hint"
              options={VOICE_STYLES.map((p) => ({ value: p, label: t(`voice.settings.style.${p}`) }))} />
            <span className="sas-small" id="vs-style-hint">{t("voice.settings.style_hint")}</span>
          </div>
        ) : null}
        {advanced ? (
          <details className="sas-vs-adv" open>
            <summary><Icon name="chevron-down" /><span className="sas-vs-adv__title">{t("voice.settings.advanced")}</span>{caps.style ? <span className="sas-small">{t("voice.settings.advanced_hint", { style: t(`voice.settings.style.${v.style}`) })}</span> : null}</summary>
            <div className="sas-vs-adv__body">
              {caps.pauseMs ? (
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="vs-pause">{t("voice.settings.pause")}</label>
                  <select className="sas-select" id="vs-pause" name="pauseMs" value={v.pauseMs ?? ""} onChange={(ev) => set("pauseMs", ev.target.value ? Number(ev.target.value) : null)} aria-describedby="vs-pause-hint" aria-invalid={e.pauseMs ? true : undefined}>
                    <option value="">{t("voice.settings.from_style", { value: `${(fromStyle.silenceMs / 1000).toFixed(1)} s` })}</option>
                    {pauses.map((ms) => <option key={ms} value={ms}>{(ms / 1000).toFixed(1)} s</option>)}
                  </select>
                  <span className="sas-small" id="vs-pause-hint">{t("voice.settings.pause_hint")}</span>
                  {e.pauseMs ? <span className="sas-small sas-vs-err" role="alert">{e.pauseMs}</span> : null}
                </div>
              ) : null}
              {caps.interruptSensitivity ? (
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="vs-interrupt">{t("voice.settings.interrupt")}</label>
                  <select className="sas-select" id="vs-interrupt" name="interrupt" value={v.interrupt ?? ""} onChange={(ev) => set("interrupt", (ev.target.value || null) as ResolvedVoiceSettings["interrupt"])} aria-describedby="vs-interrupt-hint" aria-invalid={e.interrupt ? true : undefined}>
                    <option value="">{t("voice.settings.from_style", { value: t(`voice.settings.${styleInterrupt}`) })}</option>
                    {INTERRUPT_LEVELS.map((l) => <option key={l} value={l}>{t(`voice.settings.${l}`)}</option>)}
                  </select>
                  <span className="sas-small" id="vs-interrupt-hint">{t("voice.settings.interrupt_hint")}</span>
                  {e.interrupt ? <span className="sas-small sas-vs-err" role="alert">{e.interrupt}</span> : null}
                </div>
              ) : null}
              {caps.fillers ? fillers : null}
              {longest}
            </div>
          </details>
        ) : (
          <>
            {caps.fillers ? fillers : null}
            {longest}
          </>
        )}
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

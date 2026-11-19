"use client";

import { useActionState, useState } from "react";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { callLimitShort, callLimitText, defaultVoiceOf, hasAdvancedTuning, voiceOptions } from "@/lib/voice/lab";
import { DEFAULT_VOICE_SETTINGS, MIN_CALL_SEC, PLATFORM_MAX_CALL_SEC, VOICE_PACES, VOICE_STYLES, turnTakingFor, type ResolvedVoiceSettings, type VoiceCapabilities, type VoiceSettingsErrors } from "@/lib/voice/settings";

export type VoiceSettingsFormState = { ok?: boolean; errors?: VoiceSettingsErrors; failed?: boolean };

const LIMIT_OPTIONS = Array.from({ length: PLATFORM_MAX_CALL_SEC / 60 - MIN_CALL_SEC / 60 + 1 }, (_, i) => MIN_CALL_SEC + i * 60);

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

/** A read-only meter for a value the conversation style sets (board: Advanced). */
function Meter({ label, at, low, mid, high, hint }: { label: string; at: number; low: string; mid: string; high: string; hint: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, at)) * 100);
  return (
    <div className="sas-vs-field">
      <span className="sas-input-label">{label}</span>
      <span className="sas-vs-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={mid} aria-label={label}>
        <span className="sas-vs-meter__fill" style={{ width: `${pct}%` }} />
        <span className="sas-vs-meter__knob" style={{ insetInlineStart: `calc(${pct}% - 8px)` }} />
      </span>
      <span className="sas-small sas-vs-meter__scale"><span>{low}</span><b className="sas-num">{mid}</b><span>{high}</span></span>
      <span className="sas-small">{hint}</span>
    </div>
  );
}

/**
 * The voice settings of the draft version (board VoiceSettingsPanel), inside
 * the test lab's side panel. Shows only what the realtime model supports
 * (voiceCapabilities); unsupported settings are hidden, never disabled. When
 * nothing but "Filler phrases" and "Longest call" is left of the advanced
 * settings, there is no "Advanced" fold. The footer stays at the bottom of
 * the panel. `action` saves to the draft on the server and checks the role there.
 */
export function VoiceSettingsForm({
  action,
  slug,
  caps,
  initial,
  version,
  closeHref,
  deploymentLimitSec,
  sampleUrl,
}: {
  action: (prev: VoiceSettingsFormState, form: FormData) => Promise<VoiceSettingsFormState>;
  slug: string;
  caps: VoiceCapabilities;
  initial: ResolvedVoiceSettings;
  version: number;
  closeHref: string;
  /** This deployment ends test calls sooner than the setting (the hosting function's limit), or null. */
  deploymentLimitSec: number | null;
  /** A short sample of a voice, where one exists. Without it the Listen button is not shown. */
  sampleUrl?: (voice: string) => string | null;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [v, setV] = useState<ResolvedVoiceSettings>(initial);
  const set = <K extends keyof ResolvedVoiceSettings>(k: K, val: ResolvedVoiceSettings[K]) => setV((x) => ({ ...x, [k]: val }));
  const options = voiceOptions(caps);
  const voiceValue = v.voice && options.some((o) => o.value === v.voice) ? v.voice : "";
  const heard = voiceValue || defaultVoiceOf(caps);
  const sample = heard ? sampleUrl?.(heard) ?? null : null;
  const advanced = hasAdvancedTuning(caps);
  const e = state.errors ?? {};
  const tt = turnTakingFor(v.style, caps.pauseMs ? "openai/gpt-realtime" : "") ?? { silenceMs: 600, threshold: 0.5 };

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
        {LIMIT_OPTIONS.map((sec) => <option key={sec} value={sec}>{callLimitText(sec)}</option>)}
      </select>
      {deploymentLimitSec && deploymentLimitSec < v.maxCallSec ? <span className="sas-small">{t("voice.settings.max_hint", { limit: callLimitShort(deploymentLimitSec) })}</span> : null}
      {e.maxCallSec ? <span className="sas-small sas-vs-err" role="alert">{e.maxCallSec}</span> : null}
    </div>
  );

  return (
    <form action={formAction} className="sas-vs-form" data-voice-settings="">
      <input type="hidden" name="slug" value={slug} />
      <div className="sas-vs-body">
        {state.failed || Object.keys(e).length ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("voice.settings.error")}</span></div> : null}
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
                <Meter label={t("voice.settings.pause")} at={(tt.silenceMs - 300) / 1200} low="0.3 s" mid={`${(tt.silenceMs / 1000).toFixed(1)} s`} high="1.5 s" hint={t("voice.settings.pause_hint")} />
              ) : null}
              {caps.interruptSensitivity ? (
                <Meter label={t("voice.settings.interrupt")} at={1 - (tt.threshold - 0.3) / 0.5} low={t("voice.settings.low")} high={t("voice.settings.high")}
                  mid={tt.threshold >= 0.6 ? t("voice.settings.low") : tt.threshold <= 0.45 ? t("voice.settings.high") : t("voice.settings.medium")} hint={t("voice.settings.interrupt_hint")} />
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
          <button type="button" className={`${buttonClass("ghost")} sas-vs-reset`} onClick={() => setV({ ...DEFAULT_VOICE_SETTINGS })}>{t("voice.settings.reset")}</button>
        </div>
      </div>
    </form>
  );
}

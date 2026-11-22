import { Button } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { t } from "@/lib/i18n";
import type { SellerAccount } from "@/db/schema";
import { appDb } from "@/lib/auth/account";
import { listVersions } from "@/lib/agent/service";
import { usdMicrosToMinor } from "@/lib/ai/models";
import { formatMoney } from "@/lib/domain/money";
import { buyerVoiceMonth } from "@/lib/voice/buyer";
import { callLimitShort, voiceSettingsSummary } from "@/lib/voice/lab";
import { maxCallSeconds, resolveVoiceSettings, versionModelId, voiceModelLabel } from "@/lib/voice/settings";
import { deploymentCallLimitSec } from "@/lib/voice/socket-limits";
import { RECORDING_KEEP_DAYS, RECORDING_NOTICE, resolveRecordingSettings } from "@/lib/voice/recording-settings";
import { saveVoiceBuyerCallsAction } from "./voice-actions";

const Row = ({ title, hint, children, id }: { title: string; hint: string; children?: React.ReactNode; id: string }) => (
  <div className="st-voice__row">
    <span className="sas-stack-2" style={{ gap: 2 }}>
      <b id={id}>{title}</b>
      <span className="sas-small">{hint}</span>
    </span>
    {children}
  </div>
);

/**
 * Settings › Voice (board VoiceSettings), shown only while voice calls are on
 * for the platform: "Let buyers call the agent" (checked unless the account's voiceBuyerCallsOff,
 * call recording and its spoken notice (company level, both on by default), and read-only what the call uses
 * and what buyers are told. This month: the paid buyer
 * calls (live model only).
 */
export async function VoiceSection({ account, saved }: { account: SellerAccount; saved: boolean }) {
  const [versions, month] = await Promise.all([listVersions(appDb, account.id), buyerVoiceMonth(appDb, account.id)]);
  const live = versions.find((v) => v.status === "live") ?? versions.find((v) => v.status === "draft");
  const settings = resolveVoiceSettings(live?.voiceSettings);
  const recording = resolveRecordingSettings(account.voiceSettings);
  const limit = maxCallSeconds({ settings: live?.voiceSettings ?? null, deadlineSec: deploymentCallLimitSec() });
  const minor = usdMicrosToMinor(month.costMicros, account.currency);
  const cost = minor === null ? formatMoney(Math.round(month.costMicros / 10_000), "USD") : formatMoney(minor, account.currency);
  const base = `/app/${account.slug}`;
  return (
    // One form and one Save for the page (its switches), in a bar that stays at the bottom.
    <form action={saveVoiceBuyerCallsAction} className="sas-stack-4 st-voice-page">
      <input type="hidden" name="slug" value={account.slug} />
      {saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("settings.voice.saved")}</span></div> : null}
      <section className="sas-panel" aria-labelledby="voice-h" data-settings-voice="">
        <div className="sas-panel__body sas-stack-2">
          <h2 id="voice-h" className="sas-heading">{t("settings.voice.title")}</h2>
          <span className="sas-small">{t("settings.voice.intro")}</span>
        </div>
        <div className="st-voice">
          <label className="st-voice__row">
            <span className="sas-stack-2" style={{ gap: 2 }}>
              <b>{t("settings.voice.buyer_calls")}</b>
              <span className="sas-small" id="voice-calls-hint">{t("settings.voice.buyer_calls_hint")}</span>
            </span>
            <input type="checkbox" role="switch" className="sas-switch" name="buyerCalls" defaultChecked={!account.voiceBuyerCallsOff} aria-describedby="voice-calls-hint" data-voice-buyer-calls="" />
          </label>
          <Row id="voice-lang" title={t("settings.voice.language")} hint={t("settings.voice.language_hint")}><span className="sas-pill">{t("settings.voice.language_value")}</span></Row>
          {/* The live version's model is what buyer calls use; it is picked per version in Versions and test lab. */}
          <Row id="voice-model" title={t("settings.voice.model")} hint={t("settings.voice.model_hint")}>
            <span className="st-voice__value">
              <span className="sas-small" data-voice-live-model="">{voiceModelLabel(versionModelId(live?.voiceSettings))}</span>
              <span className="sas-small st-voice__ro">{t("voice.settings.model_live_hint")}</span>
            </span>
          </Row>
          <Row id="voice-voice" title={t("settings.voice.voice")} hint={t("settings.voice.voice_hint")}>
            <span className="st-voice__value">
              <span className="sas-small">{voiceSettingsSummary(settings, versionModelId(live?.voiceSettings))}</span>
              <span className="sas-small st-voice__ro">{t("settings.voice.voice_ro")}</span>
            </span>
          </Row>
          <Row id="voice-max" title={t("settings.voice.longest")} hint={t("settings.voice.longest_hint")}>
            <span className="st-voice__value">
              <span className="sas-num" data-voice-longest="">{callLimitShort(limit)}</span>
              <span className="sas-small st-voice__ro">{t("settings.voice.longest_ro")}</span>
            </span>
          </Row>
        </div>
      </section>
      <section className="sas-panel" aria-labelledby="voice-told-h">
        <div className="sas-panel__body sas-stack-2">
          <h2 id="voice-told-h" className="sas-heading">{t("settings.voice.told")}</h2>
          <span className="sas-small">{t("settings.voice.told_intro")}</span>
        </div>
        <div className="st-voice">
          <Row id="voice-tr" title={t("settings.voice.transcript")} hint={t("settings.voice.transcript_hint")}><span className="sas-pill">{t("settings.voice.platform")}</span></Row>
        </div>
      </section>
      {/* Call recordings (company level: seller_accounts.voice_settings), saved with the page's one Save. */}
      <section className="sas-panel" aria-labelledby="voice-rec-h" data-settings-recordings="">
        <div className="sas-panel__body sas-stack-2">
          <h2 id="voice-rec-h" className="sas-heading">{t("settings.voice.rec.title")}</h2>
          <span className="sas-small">{t("settings.voice.rec.intro")}</span>
        </div>
        <div className="st-voice">
          <label className="st-voice__row">
            <span className="sas-stack-2" style={{ gap: 2 }}>
              <b>{t("settings.voice.rec.record")}</b>
              <span className="sas-small" id="voice-rec-hint">{t("settings.voice.rec.record_hint")}</span>
            </span>
            <input type="checkbox" role="switch" className="sas-switch" name="recordCalls" defaultChecked={recording.recordCalls} aria-describedby="voice-rec-hint" data-voice-record-calls="" />
          </label>
          <label className="st-voice__row">
            <span className="sas-stack-2" style={{ gap: 2 }}>
              <b>{t("settings.voice.rec.keep")}</b>
              <span className="sas-small" id="voice-keep-hint">{t("settings.voice.rec.keep_hint")}</span>
            </span>
            <select className="sas-select" name="recordingKeepDays" defaultValue={String(recording.keepDays)} aria-describedby="voice-keep-hint" data-voice-keep-days="" style={{ width: "auto" }}>
              {RECORDING_KEEP_DAYS.map((d) => <option key={d} value={d}>{d ? t("settings.voice.rec.days", { n: d }) : t("settings.voice.rec.until_deleted")}</option>)}
            </select>
          </label>
          <Row id="voice-rec-hears" title={t("settings.voice.rec.hears")} hint={t("settings.voice.rec.hears_hint", { line: RECORDING_NOTICE.en })} />
          <div className="st-voice__row" style={{ alignItems: "flex-start" }}>
            <span className="sas-stack-2" style={{ gap: 6 }}>
              <label htmlFor="voice-rec-line"><b>{t("settings.voice.rec.line")}</b></label>
              <span className="sas-small" id="voice-line-hint">{t("settings.voice.rec.line_hint")}</span>
              <span className="sas-alert sas-alert--warning st-voice__warn" id="voice-line-warn" data-voice-line-warning=""><Icon name="alert-triangle" /><span>{t("settings.voice.rec.line_warning")}</span></span>
            </span>
            <input type="checkbox" role="switch" className="sas-switch" id="voice-rec-line" name="recordingNotice" defaultChecked={recording.recordingNotice} aria-describedby="voice-line-hint voice-line-warn" data-voice-recording-notice="" />
          </div>
          <div className="st-voice__row">
            <span className="sas-small st-voice__law" data-voice-rec-law=""><Icon name="info" />{t("settings.voice.rec.law")}</span>
          </div>
        </div>
      </section>
      <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="voice-month-h">
        <h2 id="voice-month-h" className="sas-heading">{t("settings.voice.month")}</h2>
        <dl className="sas-vstats__kv">
          <dt>{t("settings.voice.calls")}</dt><dd className="sas-num">{month.calls}</dd>
          <dt>{t("settings.voice.minutes")}</dt><dd className="sas-num">{month.minutes}</dd>
          <dt>{t("settings.voice.cost")}</dt><dd className="sas-num">{cost}</dd>
        </dl>
        <span className="sas-small">{t("settings.voice.month_note")} <a href={`${base}/settings`}>{t("settings.voice.usage_link")}</a></span>
      </section>
      <div className="st-voice__save"><Button type="submit" variant="primary" data-voice-save="">{t("settings.voice.save")}</Button></div>
    </form>
  );
}

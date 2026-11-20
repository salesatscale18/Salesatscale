import { Button } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { t } from "@/lib/i18n";
import type { SellerAccount } from "@/db/schema";
import { appDb } from "@/lib/auth/account";
import { listVersions } from "@/lib/agent/service";
import { buyerNames } from "@/lib/agent/core/names";
import { usdMicrosToMinor } from "@/lib/ai/models";
import { formatMoney } from "@/lib/domain/money";
import { buyerVoiceMonth } from "@/lib/voice/buyer";
import { continuingLine } from "@/lib/voice/instructions";
import { callLimitShort, voiceSettingsSummary } from "@/lib/voice/lab";
import { maxCallSeconds, resolveVoiceSettings, voiceModelId } from "@/lib/voice/settings";
import { deploymentCallLimitSec } from "@/lib/voice/socket-limits";
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
 * for the platform: "Let buyers call the agent" (the account's voiceBuyerCalls,
 * the only setting here), and read-only what the call uses and what buyers
 * are told. Recordings stay off (transcript only). This month: the paid buyer
 * calls (live model only).
 */
export async function VoiceSection({ account, saved }: { account: SellerAccount; saved: boolean }) {
  const [versions, month] = await Promise.all([listVersions(appDb, account.id), buyerVoiceMonth(appDb, account.id)]);
  const live = versions.find((v) => v.status === "live") ?? versions.find((v) => v.status === "draft");
  const settings = resolveVoiceSettings(live?.voiceSettings);
  const limit = maxCallSeconds({ settings: live?.voiceSettings ?? null, deadlineSec: deploymentCallLimitSec() });
  const names = buyerNames(live?.playbook ?? null, account, "en");
  const opener = continuingLine({ firstName: t("settings.voice.example_buyer"), agent: names.agent, seller: names.seller });
  const minor = usdMicrosToMinor(month.costMicros, account.currency);
  const cost = minor === null ? formatMoney(Math.round(month.costMicros / 10_000), "USD") : formatMoney(minor, account.currency);
  const base = `/app/${account.slug}`;
  return (
    // One form and one Save for the page (the switch is its only setting), in a bar that stays at the bottom.
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
            <input type="checkbox" role="switch" className="sas-switch" name="buyerCalls" defaultChecked={account.voiceBuyerCalls} aria-describedby="voice-calls-hint" data-voice-buyer-calls="" />
          </label>
          <Row id="voice-lang" title={t("settings.voice.language")} hint={t("settings.voice.language_hint")}><span className="sas-pill">{t("settings.voice.english")}</span></Row>
          <Row id="voice-voice" title={t("settings.voice.voice")} hint={t("settings.voice.voice_hint")}>
            <span className="st-voice__value">
              <span className="sas-small">{voiceSettingsSummary(settings, voiceModelId())}</span>
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
          <Row id="voice-open" title={t("settings.voice.opening")} hint={t("settings.voice.opening_hint", { example: opener })}>
            <span className="sas-pill">{t("settings.voice.platform")}</span>
          </Row>
          <Row id="voice-tr" title={t("settings.voice.transcript")} hint={t("settings.voice.transcript_hint")}><span className="sas-pill">{t("settings.voice.platform")}</span></Row>
          <Row id="voice-rec" title={t("settings.voice.recordings")} hint={t("settings.voice.recordings_hint")}>
            <span className="sas-pill" data-voice-recordings="off"><Icon name="mic-off" />{t("settings.voice.off")}</span>
          </Row>
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

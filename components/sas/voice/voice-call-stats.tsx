import { t } from "@/lib/i18n";
import { answerSpeedText, callClock } from "@/lib/voice/lab";
import { costText, endReasonText, errorText, type CostFormat } from "@/lib/voice/client/view";

/**
 * The "This call" card (board VoiceLab): length against the limit, the
 * estimated cost in the account currency ("No cost" for a scripted test) and
 * the average answer speed, with the line that explains voice cost. After the
 * call (`ended`), also how it ended and any error the person saw. Plain
 * props, so the live call (client) and the saved call (server) both use it.
 */
export function VoiceCallStats({
  durationSec,
  maxSec,
  costMicros,
  scripted,
  fx,
  answerMsAvg,
  live,
  costEstimated = false,
  endReason,
  errorCode,
  standby = null,
  headingId = "voice-stats-h",
}: {
  durationSec: number;
  maxSec: number | null;
  costMicros: number;
  scripted: boolean;
  fx: CostFormat | null;
  answerMsAvg: number | null;
  /** The call is running: the cost reads "so far". */
  live: boolean;
  costEstimated?: boolean;
  endReason?: string | null;
  errorCode?: string | null;
  /** Saved calls that went on standby: time with the agent connected (paid) and on standby. */
  standby?: { activeSec: number; standbySec: number } | null;
  headingId?: string;
}) {
  const length = maxSec ? t("voice.stats.length_value", { time: callClock(durationSec), max: callClock(maxSec) }) : callClock(durationSec);
  const money = costText(costMicros, fx);
  const cost = scripted ? t("voice.no_cost") : live ? t("voice.stats.cost_so_far", { cost: money }) : costEstimated ? t("voice.stats.cost_estimated", { cost: money }) : money;
  const ended = endReasonText(endReason);
  const error = errorText(errorCode);
  return (
    <section className="sas-panel sas-panel__body sas-stack-2 sas-vstats" aria-labelledby={headingId} data-voice-stats="">
      <h2 id={headingId} className="sas-heading">{t("voice.stats.title")}</h2>
      <dl className="sas-vstats__kv">
        <dt>{t("voice.stats.length")}</dt><dd className="sas-num" data-voice-length="">{length}</dd>
        <dt>{t("voice.stats.cost")}</dt><dd className="sas-num" data-voice-cost="">{cost}</dd>
        <dt>{t("voice.stats.answer")}</dt>
        <dd className="sas-num" data-voice-answer="">{answerMsAvg === null ? "—" : t("voice.stats.answer_value", { time: answerSpeedText(answerMsAvg) })}</dd>
        {standby ? (
          <>
            <dt>{t("voice.stats.standby")}</dt>
            <dd className="sas-num" data-voice-standby="">{t("voice.stats.standby_value", { standby: callClock(standby.standbySec), active: callClock(standby.activeSec) })}</dd>
          </>
        ) : null}
        {ended ? <><dt>{t("voice.stats.ended")}</dt><dd data-voice-ended="">{ended}</dd></> : null}
        {error ? <><dt>{t("voice.stats.error")}</dt><dd data-voice-error="">{error}</dd></> : null}
      </dl>
      <span className="sas-small">{scripted ? t("voice.stats.note_scripted") : t("voice.stats.note")}</span>
    </section>
  );
}

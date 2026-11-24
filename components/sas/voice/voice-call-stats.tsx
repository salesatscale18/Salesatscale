import { t } from "@/lib/i18n";
import { answerSpeedText, callClock } from "@/lib/voice/lab";
import { costText, endReasonText, errorText, type CostFormat } from "@/lib/voice/client/view";
import { voiceModelLabel, type CallVoiceInfo } from "@/lib/voice/settings";
import { thinkModelLabel, type PipelineCallInfo } from "@/lib/voice-pipeline/summary";
import type { RtElevenCallInfo } from "@/lib/voice-rt-eleven/summary";

/** "Puck" / "Model default" / "Not recorded" (an older call). */
export function callVoiceText(voice: CallVoiceInfo["voice"]): string {
  return voice === null ? t("voice.stats.not_recorded") : voice === "default" ? t("voice.stats.voice_default") : voice;
}

/** "On (short filler phrases)" / "Off" / "Not recorded" (an older call). */
export function callFillersText(fillers: CallVoiceInfo["fillers"]): string {
  return fillers === null ? t("voice.stats.not_recorded") : fillers ? t("voice.stats.fillers_on") : t("voice.stats.fillers_off");
}

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
  technical = null,
  headingId = "voice-stats-h",
  model = null,
  engine = null,
  voiceUsed = null,
  pipeline = null,
  rtEleven = null,
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
  /** Platform admins only: the technical line of how it ended (lib/voice/client/view.ts endDetailText). */
  technical?: string | null;
  headingId?: string;
  /** The voice model's label ("Gemini 3.8 Live"): the call's own (its session row), so calls on different models are told apart. */
  model?: string | null;
  /** Test lab: the voice engine's label ("Classic (20 Nov)"), when the page shows it. */
  engine?: string | null;
  /** The voice and fillers the call ran with (the session's, or the call being started's), next to the model. */
  voiceUsed?: CallVoiceInfo | null;
  /** Test lab, a pipeline-proof call: its three models (listening, thinking, speaking) and its median answer time. */
  pipeline?: PipelineCallInfo | null;
  /** Test lab, a call where ElevenLabs spoke (text output): the model, the speaking model, the median answer time. */
  rtEleven?: RtElevenCallInfo | null;
}) {
  const length = maxSec ? t("voice.stats.length_value", { time: callClock(durationSec), max: callClock(maxSec) }) : callClock(durationSec);
  const money = costText(costMicros, fx);
  const cost = scripted ? t("voice.no_cost") : live ? t("voice.stats.cost_so_far", { cost: money }) : costEstimated ? t("voice.stats.cost_estimated", { cost: money }) : money;
  const ended = endReasonText(endReason);
  const error = errorText(errorCode);
  return (
    <section className="sas-panel sas-panel__body sas-stack-2 sas-vstats" aria-labelledby={headingId} data-voice-stats="">
      <h2 id={headingId} className="sas-heading">{t("voice.stats.title")}</h2>
      {/* Model, Voice, Engine, in that order (owner, 24 Nov 2026): what ran, never what was only asked for. */}
      <dl className="sas-vstats__kv">
        {pipeline ? (
          <>
            <dt>{t("voice.stats.pipeline_listen")}</dt><dd data-voice-pipeline-listen="">{pipeline.listenModel || "—"}</dd>
            <dt>{t("voice.stats.pipeline_think")}</dt><dd data-voice-pipeline-think="" title={pipeline.thinkModel || undefined}>{thinkModelLabel(pipeline.thinkModel) || "—"}</dd>
            <dt>{t("voice.stats.pipeline_speak")}</dt><dd data-voice-pipeline-speak="">{pipeline.speakModel || "—"}</dd>
            <dt>{t("voice.stats.pipeline_median")}</dt>
            <dd className="sas-num" data-voice-pipeline-median="">{pipeline.medianAnswerMs === null ? "—" : answerSpeedText(pipeline.medianAnswerMs)}</dd>
            {/* Thinking counts every answered turn, also those whose speech failed (no answer time then). */}
            <dt>{t("voice.stats.pipeline_think_median")}</dt>
            <dd className="sas-num" data-voice-pipeline-think-median="">{pipeline.medianThinkMs == null ? "—" : answerSpeedText(pipeline.medianThinkMs)}</dd>
            <dt>{t("voice.stats.pipeline_rounds_median")}</dt><dd className="sas-num" data-voice-pipeline-rounds="">{pipeline.medianRounds ?? "—"}</dd>
            <dt>{t("voice.stats.pipeline_round_ms_median")}</dt><dd className="sas-num" data-voice-pipeline-round-ms="">{pipeline.medianRoundMs == null ? "—" : answerSpeedText(pipeline.medianRoundMs)}</dd>
          </>
        ) : null}
        {rtEleven ? (
          <>
            {/* ElevenLabs spoke: the model listened, decided and wrote the replies (text output). */}
            <dt>{t("voice.stats.model")}</dt>
            <dd data-voice-rt-model="" data-voice-model="" title={rtEleven.realtimeModel || undefined}>{(rtEleven.realtimeModel ? voiceModelLabel(rtEleven.realtimeModel) : model) || "—"}{scripted ? <span className="sas-small"> · {t("voice.stats.model_scripted")}</span> : null}</dd>
          </>
        ) : null}
        {model && !pipeline && !rtEleven ? <><dt>{t("voice.stats.model")}</dt><dd data-voice-model="">{model}{scripted ? <span className="sas-small"> · {t("voice.stats.model_scripted")}</span> : null}</dd></> : null}
        {voiceUsed ? <><dt>{t("voice.stats.voice")}</dt><dd data-voice-used="">{callVoiceText(voiceUsed.voice)}</dd></> : null}
        {rtEleven ? <><dt>{t("voice.stats.pipeline_speak")}</dt><dd data-voice-rt-speak="">{rtEleven.speakModel || "—"}</dd></> : null}
        {engine ? <><dt>{t("voice.stats.engine")}</dt><dd data-voice-engine="">{engine}</dd></> : null}
        {voiceUsed ? <><dt>{t("voice.stats.fillers")}</dt><dd data-voice-fillers="">{callFillersText(voiceUsed.fillers)}</dd></> : null}
        {rtEleven ? (
          <>
            <dt>{t("voice.stats.pipeline_median")}</dt>
            <dd className="sas-num" data-voice-rt-median="">{rtEleven.medianAnswerMs === null ? "—" : answerSpeedText(rtEleven.medianAnswerMs)}</dd>
          </>
        ) : null}
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
        {ended ? (
          <>
            <dt>{t("voice.stats.ended")}</dt>
            <dd data-voice-ended="">
              {ended}
              {technical ? <span className="sas-small" style={{ display: "block", overflowWrap: "anywhere" }} data-voice-ended-detail="">{technical}</span> : null}
            </dd>
          </>
        ) : null}
        {error ? <><dt>{t("voice.stats.error")}</dt><dd data-voice-error="">{error}</dd></> : null}
      </dl>
      <span className="sas-small">{scripted ? t("voice.stats.note_scripted") : t("voice.stats.note")}</span>
    </section>
  );
}

import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { DateField } from "@/components/sas/date-field";
import type { CallbackRequest } from "@/lib/callbacks/rules";
import { shownZone, viewerTime, yourTimeSuffix } from "@/lib/viewer-zone";
import { t, type MessageKey } from "@/lib/i18n";
import { zonePlainName } from "@/lib/format";
import { cancelCallbackAction, changeCallbackAction } from "./callback-actions";

/** "YYYY-MM-DD" and "HH:MM" of an instant in a time zone (the Change time fields' starting values). */
function localParts(at: Date, timezone: string): { date: string; time: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}

/** "Times are Israel time (Asia/Jerusalem).": the plain zone name with its code (lib/format.ts), the code alone when there is no plain name. */
export function callbackZoneLine(timezone: string, at = new Date()): string {
  const name = zonePlainName(timezone, at);
  return name ? t("callback.zone_named", { name, tz: timezone }) : t("callback.zone", { tz: timezone });
}

const NOTICE: Record<string, MessageKey> = { confirmed: "callback.notice.confirmed", changed: "callback.notice.changed", cancelled: "callback.notice.cancelled" };
const ERROR: Record<string, MessageKey> = {
  forbidden: "callback.error.forbidden", not_found: "callback.error.not_found", already_confirmed: "callback.error.already_confirmed",
  past: "callback.error.past", invalid_time: "callback.error.invalid_time",
};
const NOT_TOLD: Record<string, MessageKey> = {
  no_conversation: "callback.not_told.no_conversation", closed: "callback.not_told.closed", opted_out: "callback.not_told.opted_out", window_closed: "callback.not_told.window_closed",
};

/**
 * Lead card (O6): an older call request the agent recorded with a time, from
 * before the buyer booked calls in the chat (reach boards). "Call requested:
 * Wed 18 Nov 10:00" with the agent's brief, Change time and Cancel; the seller
 * confirmation step ("Confirm") is gone: setting the time confirms it and tells
 * the buyer in the chat. Booked and confirmed calls show on the Team call card
 * (team-call.tsx). The chat stays with the agent.
 */
export function CallbackPanel({ slug, leadId, request, canManage, notice, error, notTold, viewerZone = null }: {
  slug: string; leadId: string; request: CallbackRequest | null; canManage: boolean;
  /** The viewer's own zone (the sas_tz cookie): the time reads in it, " · your time" when it differs. Null: the request's zone. */
  viewerZone?: string | null;
  notice?: string; error?: string; notTold?: string;
}) {
  if (!request && !notice && !error) return null;
  const confirmed = request?.status === "confirmed";
  const start = request ? localParts(request.at, request.timezone) : null;
  const hidden = request ? (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="callbackId" value={request.id} />
    </>
  ) : null;
  return (
    <section id="callback" aria-labelledby="cb-h" className="sas-stack-2" data-testid="callback" style={{ padding: "0 16px 16px", borderBlockEnd: "1px solid var(--line)" }}>
      <h2 id="cb-h" className="sas-group-label" style={{ padding: "16px 0 0" }}>{t("callback.title")}</h2>
      {notice && NOTICE[notice] ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(NOTICE[notice])}</span></div> : null}
      {notTold && NOT_TOLD[notTold] ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="alert-triangle" /><span>{t(NOT_TOLD[notTold])}</span></div> : null}
      {error && ERROR[error] ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(ERROR[error])}</span></div> : null}
      {request ? (
        <>
          <span data-testid="callback-time" data-status={request.status} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontWeight: 600, color: "var(--ink)" }}>
            <Icon name={confirmed ? "check-circle" : "phone-call"} />
            <span>{t(confirmed ? "callback.confirmed" : "callback.requested", { time: `${viewerTime(request.at, viewerZone, request.timezone)}${yourTimeSuffix(request.at, viewerZone, request.timezone)}` })}</span>
          </span>
          {request.brief ? <span className="sas-small" style={{ overflowWrap: "anywhere" }} data-testid="callback-brief">{t("callback.brief", { brief: request.brief })}</span> : null}
          <span className="sas-small">{t(confirmed ? "callback.hint_confirmed" : "callback.hint", { zone: callbackZoneLine(shownZone(viewerZone, request.timezone), request.at) })}</span>
          {canManage ? (
            <div className="sas-stack-2">
              <details data-testid="callback-change" open={error === "past" || error === "invalid_time" || undefined}>
                <summary className="sas-small">{t("callback.change")}</summary>
                <form action={changeCallbackAction} className="sas-stack-2" style={{ paddingBlockStart: 8 }}>
                  {hidden}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
                    <div className="sas-input-group" style={{ flex: "1 1 140px", minWidth: 0 }}>
                      <label className="sas-input-label" htmlFor="cb-date">{t("callback.date")}</label>
                      <DateField id="cb-date" name="date" defaultValue={start?.date} required />
                    </div>
                    <div className="sas-input-group" style={{ flex: "0 1 110px", minWidth: 0 }}>
                      <label className="sas-input-label" htmlFor="cb-time">{t("callback.time")}</label>
                      <input className="sas-input sas-num" id="cb-time" name="time" type="time" step={900} defaultValue={start?.time} required />
                    </div>
                  </div>
                  <span className="sas-hint">{t("callback.change_hint", { tz: request.timezone })}</span>
                  <div><button type="submit" className={buttonClass("secondary", "sm")} data-testid="callback-change-submit">{t("callback.change_submit")}</button></div>
                </form>
              </details>
              {/* Cancel call, with a confirm step: the request closes and the buyer is told in the chat. */}
              <details data-testid="callback-cancel">
                <summary className="sas-small">{t("callback.cancel")}</summary>
                <form action={cancelCallbackAction} className="sas-stack-2" style={{ paddingBlockStart: 8 }}>
                  {hidden}
                  <span className="sas-small">{t("callback.cancel_confirm")}</span>
                  <div><button type="submit" className={buttonClass("danger", "sm")} data-testid="callback-cancel-submit">{t("callback.cancel_submit")}</button></div>
                </form>
              </details>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

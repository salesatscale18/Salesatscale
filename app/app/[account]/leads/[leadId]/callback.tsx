import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { DateField } from "@/components/sas/date-field";
import type { CallbackRequest } from "@/lib/callbacks/rules";
import { formatDueLocal } from "@/lib/follow-ups/rules";
import { t, type MessageKey } from "@/lib/i18n";
import { zonePlainName } from "@/lib/format";
import { afterCallAction, cancelCallbackAction, changeCallbackAction, confirmCallbackAction } from "./callback-actions";

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
 * Lead card (O6): the call the agent arranged with the buyer. "Call requested:
 * Wed 18 Nov 10:00" with the agent's brief, Confirm and Change time; once
 * confirmed, "Call confirmed" with Change time. Confirming or changing tells
 * the buyer in the chat. A time the buyer asked for outside contact hours
 * carries a small note until the seller sets another time. The chat stays with the agent. Shown only when there
 * is a request (or right after acting on one).
 */
export function CallbackPanel({ slug, leadId, request, canManage, notice, error, notTold }: {
  slug: string; leadId: string; request: CallbackRequest | null; canManage: boolean;
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
            <span>{t(confirmed ? "callback.confirmed" : "callback.requested", { time: formatDueLocal(request.at, request.timezone) })}</span>
          </span>
          {/* The buyer named a time outside contact hours (allowed, owner 20 Nov 2026): the seller still confirms or changes it. */}
          {request.outsideHoursAsked ? (
            <span className="sas-small" data-testid="callback-outside-hours" style={{ display: "inline-flex", gap: 6, alignItems: "flex-start" }}>
              <Icon name="clock" />
              <span>{t("callback.outside_hours_asked")}</span>
            </span>
          ) : null}
          {request.brief ? <span className="sas-small" style={{ overflowWrap: "anywhere" }} data-testid="callback-brief">{t("callback.brief", { brief: request.brief })}</span> : null}
          <span className="sas-small">{t(confirmed ? "callback.hint_confirmed" : "callback.hint", { zone: callbackZoneLine(request.timezone, request.at) })}</span>
          {canManage ? (
            <div className="sas-stack-2">
              {!confirmed ? (
                <form action={confirmCallbackAction}>
                  {hidden}
                  <button type="submit" className={buttonClass("primary", "sm")} data-testid="callback-confirm"><Icon name="check" />{t("callback.confirm")}</button>
                </form>
              ) : null}
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

const AFTER_NOTICE: Record<string, MessageKey> = { agent: "callback.after.notice_agent", seller: "callback.after.notice_seller" };
const AFTER_ERROR: Record<string, MessageKey> = {
  forbidden: "callback.error.forbidden", not_found: "callback.error.not_found", closed: "callback.after.error_closed", opted_out: "callback.after.error_opted_out",
};

/**
 * After the call (UX, O6 follow-up): once the call card has gone (two hours
 * after the call time), "How did the call go?" stays on the lead page until
 * answered: "Hand back to the agent" or "I'm handling this deal" (the seller
 * takes over the conversation, so the agent pauses). Admins only.
 */
export function AfterCallPrompt({ slug, leadId, call, canManage, notice, error }: {
  slug: string; leadId: string; call: CallbackRequest | null; canManage: boolean; notice?: string; error?: string;
}) {
  const shownNotice = notice && AFTER_NOTICE[notice] ? AFTER_NOTICE[notice] : null;
  const shownError = error && AFTER_ERROR[error] ? AFTER_ERROR[error] : null;
  if (!(call && canManage) && !shownNotice && !shownError) return null;
  return (
    <section id="after-call" aria-labelledby="ac-h" className="sas-stack-2" data-testid="after-call" style={{ padding: "0 16px 16px", borderBlockEnd: "1px solid var(--line)" }}>
      <h2 id="ac-h" className="sas-group-label" style={{ padding: "16px 0 0" }}>{t("callback.after.title")}</h2>
      {shownNotice ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(shownNotice)}</span></div> : null}
      {shownError ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(shownError)}</span></div> : null}
      {call && canManage ? (
        <>
          <span className="sas-small">{t("callback.after.hint", { time: formatDueLocal(call.at, call.timezone) })}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {(["agent", "seller"] as const).map((choice) => (
              <form key={choice} action={afterCallAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="leadId" value={leadId} />
                <input type="hidden" name="callbackId" value={call.id} />
                <input type="hidden" name="choice" value={choice} />
                <button type="submit" className={buttonClass(choice === "agent" ? "secondary" : "takeover", "sm")} data-testid={`after-call-${choice}`}>
                  <Icon name={choice === "agent" ? "sparkles" : "user"} />{t(choice === "agent" ? "callback.after.agent" : "callback.after.seller")}
                </button>
              </form>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

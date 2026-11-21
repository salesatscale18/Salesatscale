import { buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { CopyButton } from "@/components/sas/copy-button";
import { DateField } from "@/components/sas/date-field";
import { CALL_NOTE_MAX, callNeedsLog, callUpcoming, TEAM_CALL_MINUTES, type CallbackRequest, type CallOutcome } from "@/lib/callbacks/rules";
import { formatDueLocal } from "@/lib/follow-ups/rules";
import { zonePlainName } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { isolate } from "@/lib/leads/bidi";
import { MAX_CALL_MINUTES } from "@/lib/team-calls/service";
import { cancelCallbackAction, changeCallbackAction } from "./callback-actions";
import { logTeamCallAction } from "./team-call-actions";

/** "YYYY-MM-DD" and "HH:MM" of an instant in a time zone (form starting values). */
function localParts(at: Date, timezone: string): { date: string; time: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}

const NOTICE: Record<string, MessageKey> = {
  save: "team_call.notice.save", agent: "team_call.notice.agent", seller: "team_call.notice.seller", chat_link: "team_call.notice.chat_link",
  order_form: "team_call.notice.order_form", order_form_failed: "team_call.notice.order_form_failed", no_answer: "team_call.notice.no_answer", moved: "team_call.notice.moved",
};
const ERROR: Record<string, MessageKey> = {
  forbidden: "team_call.error.forbidden", not_found: "team_call.error.not_found", too_early: "team_call.error.too_early", invalid_outcome: "team_call.error.invalid_outcome",
  invalid_next: "team_call.error.invalid_next", invalid_started: "team_call.error.invalid_started", invalid_length: "team_call.error.invalid_length",
  closed: "team_call.error.closed", opted_out: "team_call.error.opted_out",
};
const CB_NOTICE: Record<string, MessageKey> = { changed: "callback.notice.changed", confirmed: "callback.notice.confirmed", cancelled: "callback.notice.cancelled" };
const CB_ERROR: Record<string, MessageKey> = { forbidden: "callback.error.forbidden", not_found: "callback.error.not_found", past: "callback.error.past", invalid_time: "callback.error.invalid_time" };
const CB_NOT_TOLD: Record<string, MessageKey> = {
  no_conversation: "callback.not_told.no_conversation", closed: "callback.not_told.closed", opted_out: "callback.not_told.opted_out", window_closed: "callback.not_told.window_closed",
};

const NEXT: { value: "agent" | "seller" | "order_form" | "chat_link"; icon: IconName; key: MessageKey }[] = [
  { value: "agent", icon: "sparkles", key: "team_call.next.agent" },
  { value: "seller", icon: "user", key: "team_call.next.seller" },
  { value: "order_form", icon: "file-signature", key: "team_call.next.order_form" },
  { value: "chat_link", icon: "message-square", key: "team_call.next.chat_link" },
];

/** Whether the buyer's own zone reads another wall-clock time than the market's at the call. */
const differs = (at: Date, a: string, b: string) => localParts(at, a).time !== localParts(at, b).time || localParts(at, a).date !== localParts(at, b).date;

export type TeamCallMessages = { notice?: string; error?: string; cbNotice?: string; cbError?: string; notTold?: string };

/**
 * Deal tab › Team call (board ReachSeller). Before the call: the time, "Booked
 * by {buyer} in the chat", the buyer's zone when it differs, who calls, the
 * phone in full with Copy (the only place it is not masked), Change time,
 * "Cancel and tell the buyer", and the hint. After the slot the card becomes
 * the log form ("Log the call"): how it went, when it started, the length and
 * a note the agent reads, then the four next steps, each saving the log first.
 * "No answer" texts the buyer the chat link with "pick a new time"; "Moved"
 * reopens the time. `edit`: the thread's Edit on a logged call. Admins only
 * act; everything is re-checked on the server.
 */
export function TeamCallPanel({ slug, leadId, call, buyerName, leadPhone, canManage, edit = false, msg = {}, now = new Date() }: {
  slug: string; leadId: string; call: CallbackRequest | null; buyerName: string;
  /** The lead's own number (E.164), or null for a simulated buyer. */
  leadPhone: string | null;
  canManage: boolean; edit?: boolean; msg?: TeamCallMessages; now?: Date;
}) {
  const upcoming = callUpcoming(call, now);
  const toLog = !!call && (callNeedsLog(call, now) || (edit && !!call.log));
  const notices = (
    <>
      {msg.notice && NOTICE[msg.notice] ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(NOTICE[msg.notice])}</span></div> : null}
      {msg.cbNotice && CB_NOTICE[msg.cbNotice] ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(CB_NOTICE[msg.cbNotice])}</span></div> : null}
      {msg.notTold && CB_NOT_TOLD[msg.notTold] ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="alert-triangle" /><span>{t(CB_NOT_TOLD[msg.notTold])}</span></div> : null}
      {msg.error && ERROR[msg.error] ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(ERROR[msg.error])}</span></div> : null}
      {msg.cbError && CB_ERROR[msg.cbError] ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t(CB_ERROR[msg.cbError])}</span></div> : null}
    </>
  );
  const hasMsg = Object.values(msg).some(Boolean);
  if (!call || (!upcoming && !toLog)) {
    return hasMsg ? <section id="callback" className="sas-teamcall" data-testid="team-call" aria-label={t("team_call.title")}>{notices}</section> : null;
  }
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="callbackId" value={call.id} />
    </>
  );
  const when = formatDueLocal(call.at, call.timezone);
  const start = localParts(call.at, call.timezone);
  const changeCancel = canManage ? (
    <div className="sas-teamcall__actions">
      <details data-testid="team-call-change" open={msg.cbError === "past" || msg.cbError === "invalid_time" || call.log?.outcome === "moved" || msg.notice === "moved" || undefined}>
        <summary className={buttonClass("ghost", "sm")}>{t("team_call.change")}</summary>
        <form action={changeCallbackAction} className="sas-stack-2 sas-teamcall__sub">
          {hidden}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            <div className="sas-input-group" style={{ flex: "1 1 140px", minWidth: 0 }}>
              <label className="sas-input-label" htmlFor="tc-date">{t("callback.date")}</label>
              <DateField id="tc-date" name="date" defaultValue={start.date} required />
            </div>
            <div className="sas-input-group" style={{ flex: "0 1 110px", minWidth: 0 }}>
              <label className="sas-input-label" htmlFor="tc-time">{t("callback.time")}</label>
              <input className="sas-input sas-num" id="tc-time" name="time" type="time" step={900} defaultValue={start.time} required />
            </div>
          </div>
          <span className="sas-hint">{t("callback.change_hint", { tz: call.timezone })}</span>
          <div><button type="submit" className={buttonClass("secondary", "sm")} data-testid="team-call-change-submit">{t("callback.change_submit")}</button></div>
        </form>
      </details>
      <details data-testid="team-call-cancel">
        <summary className={buttonClass("ghost", "sm")}>{t("team_call.cancel")}</summary>
        <form action={cancelCallbackAction} className="sas-stack-2 sas-teamcall__sub">
          {hidden}
          <span className="sas-small">{t("callback.cancel_confirm")}</span>
          <div><button type="submit" className={buttonClass("danger", "sm")} data-testid="team-call-cancel-submit">{t("callback.cancel_submit")}</button></div>
        </form>
      </details>
    </div>
  ) : null;

  if (!toLog) {
    // Before the call.
    const phone = call.phone ?? leadPhone;
    const first = buyerName.trim().split(/\s+/)[0] || buyerName;
    const zone = call.buyerTimezone && differs(call.at, call.buyerTimezone, call.timezone)
      ? t("team_call.zone_differs", { time: isolate(localParts(call.at, call.buyerTimezone).time), zone: zonePlainName(call.buyerTimezone, call.at) ?? call.buyerTimezone })
      : t("team_call.zone_same", { zone: zonePlainName(call.timezone, call.at) ?? call.timezone });
    return (
      <section id="callback" aria-labelledby="tc-h" className="sas-teamcall" data-testid="team-call" data-state="upcoming">
        <h2 id="tc-h" className="sas-group-label sas-teamcall__label">{t("team_call.title")}</h2>
        {notices}
        <span className="sas-teamcall__when" data-testid="team-call-time"><Icon name="calendar" /><span className="sas-num">{t("team_call.when", { when, minutes: TEAM_CALL_MINUTES })}</span></span>
        <span className="sas-small">
          {call.setBy === "buyer" ? t("team_call.booked_by", { name: isolate(first) }) : t("team_call.set_by_team")}{" "}
          {zone}
        </span>
        {call.brief ? <span className="sas-small" style={{ overflowWrap: "anywhere" }} data-testid="team-call-brief">{t("callback.brief", { brief: call.brief })}</span> : null}
        <dl className="sas-teamcall__facts">
          <dt>{t("team_call.who")}</dt><dd>{t("team_call.who_anyone")}</dd>
          {phone ? (
            <>
              <dt>{t("team_call.phone")}</dt>
              {/* The full number, here only (everywhere else it is masked). */}
              <dd><span className="sas-num" dir="ltr" data-testid="team-call-phone">{phone}</span> <CopyButton value={phone} label={t("team_call.copy")} variant="ghost" /></dd>
            </>
          ) : null}
        </dl>
        {changeCancel}
        <p className="sas-small sas-teamcall__hint">{t("team_call.hint")}</p>
      </section>
    );
  }

  // After the slot: the log form (or Edit of a logged call).
  const log = call.log;
  const outcome: CallOutcome = log?.outcome ?? "spoke";
  const started = localParts(log?.startedAt ?? call.at, call.timezone).time;
  const editing = !!log;
  return (
    <section id="callback" aria-labelledby="tc-h" className="sas-teamcall sas-teamcall--log" data-testid="team-call" data-state="log">
      <div className="sas-teamcall__head">
        <h2 id="tc-h" className="sas-group-label sas-teamcall__label sas-teamcall__label--log">{editing && edit ? t("team_call.edit_title") : t("team_call.log_title")}</h2>
        <span className="sas-small sas-num">{t("team_call.log_booked", { when })}</span>
      </div>
      <span id="after-call" />
      {notices}
      {canManage ? (
        <form action={logTeamCallAction} className="sas-calllog" data-testid="team-call-log">
          {hidden}
          <fieldset className="sas-calllog__outcome">
            <legend className="sas-input-label">{t("team_call.how")}</legend>
            <div className="sas-outcome" role="radiogroup">
              {(["spoke", "no_answer", "moved"] as const).map((o) => (
                <label key={o} className="sas-outcome__opt">
                  <input type="radio" name="outcome" value={o} defaultChecked={outcome === o} data-outcome={o} />
                  <span>{t(`team_call.outcome.${o}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="sas-calllog__row">
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="tc-started">{t("team_call.started")}</label>
              <input className="sas-input sas-num" id="tc-started" name="started" type="time" defaultValue={started} />
            </div>
            <div className="sas-input-group">
              <label className="sas-input-label" htmlFor="tc-length">{t("team_call.length")}</label>
              <input className="sas-input sas-num" id="tc-length" name="lengthMin" type="number" inputMode="numeric" min={1} max={MAX_CALL_MINUTES} defaultValue={log?.lengthMin ?? undefined} />
            </div>
          </div>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor="tc-note">{t("team_call.note")}</label>
            <textarea className="sas-textarea" id="tc-note" name="note" rows={3} maxLength={CALL_NOTE_MAX} defaultValue={log?.note ?? ""} aria-describedby="tc-note-hint" />
            <span id="tc-note-hint" className="sas-hint">{t("team_call.note_hint")}</span>
          </div>
          {/* We spoke: the four next steps, stacked full width; each saves the log first. */}
          <div className="sas-calllog__group sas-calllog__group--spoke">
            <span className="sas-group-label sas-calllog__next-label">{t("team_call.next")}</span>
            {NEXT.map((n) => (
              <button key={n.value} type="submit" name="next" value={n.value} className={`${buttonClass("secondary", "sm")} sas-calllog__next`} data-next={n.value}>
                <Icon name={n.icon} />{t(n.key)}
              </button>
            ))}
            {editing ? <button type="submit" name="next" value="save" className={buttonClass("ghost", "sm")} data-next="save">{t("team_call.save")}</button> : null}
          </div>
          <div className="sas-calllog__group sas-calllog__group--no_answer">
            <button type="submit" name="next" value="save" className={buttonClass("primary", "sm")} data-next="no_answer">{t("team_call.no_answer_submit")}</button>
            <span className="sas-hint">{t("team_call.no_answer_hint")}</span>
          </div>
          <div className="sas-calllog__group sas-calllog__group--moved">
            <button type="submit" name="next" value="save" className={buttonClass("primary", "sm")} data-next="moved">{t("team_call.moved_submit")}</button>
            <span className="sas-hint">{t("team_call.moved_hint")}</span>
          </div>
          <p className="sas-small sas-calllog__foot">{t("team_call.next_hint")}</p>
        </form>
      ) : null}
      {changeCancel}
    </section>
  );
}

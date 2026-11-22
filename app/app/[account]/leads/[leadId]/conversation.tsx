import { buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import type { ReactNode } from "react";
import { AgentStepsSwitch, ChatMessage, ChatThread, ThreadMarkerLine, type TraceItem } from "@/components/sas/chat";
import type { ThreadMarker } from "@/lib/agent/thread-markers";
import type { SmsEntry } from "@/lib/sms/thread";
import { MessageBody } from "@/components/sas/message-body";
import { APP_MESSAGE_CALL, appMessageKinds, isAppText, isTeamText } from "@/lib/agent/app-message";
import type { ConversationView, SellerFormCard } from "@/lib/agent/conversation";
import { describeCall } from "@/lib/agent/trace";
import { displayName, personName } from "@/lib/auth/display";
import { formatClockIn, formatDateTimeIn, formatDayIn, localDateIso } from "@/lib/format";
import { formatDueLocal } from "@/lib/follow-ups/rules";
import { isLocale, messages, t, type Locale, type MessageKey } from "@/lib/i18n";
import { handBackAction, humanReplyAction, takeOverAction } from "../actions";
import { WindowTimer } from "@/components/sas/record";
import { SuggestedReplyBox } from "./suggested-reply";
import { QuoteCardMessage } from "./quote-card-message";
import type { WindowState } from "@/lib/channels/rules";
import { isWebChat, SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { SimulatedChip, TestLabChip } from "../simulated-chip";
import { CopyButton } from "@/components/sas/copy-button";
import { isolate } from "@/lib/leads/bidi";
import { TOOL_ICON } from "@/components/sas/tool-chip";
import { callLength } from "@/lib/voice/client/buyer-ui";
import { callClock } from "@/lib/voice/lab";

/** "18h 20m" until the window closes. */
export function remainingText(closesAt: Date, now: Date): string {
  const mins = Math.max(0, Math.floor((closesAt.getTime() - now.getTime()) / 60000));
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** The 24-hour window as the WindowTimer shows it: closing in the last two hours. */
export function windowTimerProps(w: WindowState, now: Date) {
  if (!w.open || !w.closesAt) return { state: "closed" as const };
  const closing = w.closesAt.getTime() - now.getTime() < 2 * 60 * 60 * 1000;
  return { state: closing ? ("closing" as const) : ("open" as const), remaining: remainingText(w.closesAt, now) };
}

/** Delivery of a message sent on a real channel, as a short label after its time. */
export function deliveryLabel(m: { deliveryStatus: string | null; deliveryError: string | null }): string | null {
  if (!m.deliveryStatus) return null;
  const label = maybe(`conv.delivery.${m.deliveryStatus}`) ?? m.deliveryStatus;
  if (m.deliveryStatus === "not_sent" && m.deliveryError) {
    const why = maybe(`conv.delivery.reason.${m.deliveryError}`) ?? m.deliveryError;
    return `${label}: ${why}`;
  }
  return label;
}

type Person = { firstName: string | null; lastName: string | null; email: string | null };
const firstName = (p: Person) => p.firstName || displayName(p);
/** The text for a key built at runtime, or null when there is no such key. */
const maybe = (key: string) => messages.en[key as MessageKey] ?? null;

/** A tool's plain label in the seller's thread ("Deal details updated"), never its internal name (round-4 review C1). */
export function toolLabel(name: string): string {
  return maybe(`conv.tool.${name}`) ?? t("conv.tool.other");
}

/**
 * Trace chips for an agent message: the seller-readable label, plus Refused/Failed when the tool did not succeed.
 * `raw`: platform admins also get the internal name ("deal_state.update") as the chip's tooltip.
 */
export function traceChips(calls: ConversationView["thread"][number]["calls"], raw = false): TraceItem[] {
  // The app's own messages (after a seller approval) are linked by an app_message row: no tool, no chip.
  return calls.filter((c) => c.name !== APP_MESSAGE_CALL).map((c) => ({
    kind: c.name === "lookup_knowledge" ? "knowledge" : "tool",
    label: toolLabel(c.name),
    ...(TOOL_ICON[c.name] ? { icon: TOOL_ICON[c.name] } : {}),
    outcome: c.outcome === "ok" ? undefined : c.outcome,
    ...(raw ? { title: describeCall(c.name, c.input, c.result, c.outcome).label } : {}),
  }));
}

/** A marker's words (board ConvSteps). The person is named as everywhere else: never a raw email, "you" for the viewer. */
export function markerText(m: ThreadMarker, meId: string | null, buyer?: string): string {
  if (m.kind === "handoff") return t("conv.marker.handoff");
  // "Dana opened the chat · Sat 21:03" (board ReachSeller): the buyer's first name.
  if (m.kind === "chat_opened") return t("conv.marker.chat_opened", { name: isolate((buyer ?? "").trim().split(/\s+/)[0] || t("conv.who.buyer")) });
  if (m.kind === "sms") return smsStateText(m.sms);
  // "Team call booked · Mon 23 Nov 15:30 · 15 min": the time in the zone it was booked in (the lead's market).
  if (m.kind === "team_call_booked") return t("conv.marker.team_call_booked", { when: isolate(formatDueLocal(m.callAt, m.timezone)), minutes: m.minutes });
  if (m.kind === "team_call_logged") return teamCallTitle(m);
  if (m.kind === "handed_back") return t("conv.marker.handed_back");
  if (m.kind === "spend_cap") return t("conv.marker.spend_cap");
  // A voice call's boundaries: "Voice call started · 15:44" and "Voice call · 30 s · 15:45" (the time is the marker's).
  if (m.kind === "voice_started") return t("conv.marker.voice_started");
  if (m.kind === "voice_ended") return t("conv.marker.voice_ended", { length: callLength(m.durationSec, t) });
  return m.by ? t("conv.marker.taken_over", { name: isolate(personName(m.by, meId, t("people.you_lower"))) }) : t("conv.marker.taken_over_unknown");
}

/** Markers placed by time (take-over, hand-back) and those that follow one reply (the agent's hand-off). */
export function splitMarkers(markers: ThreadMarker[] | undefined) {
  const timed = (markers ?? []).filter((m) => m.kind !== "handoff").sort((a, b) => a.at.getTime() - b.at.getTime());
  const after = new Map<string, ThreadMarker[]>();
  for (const m of markers ?? []) if (m.kind === "handoff") after.set(m.afterMessageId, [...(after.get(m.afterMessageId) ?? []), m]);
  return { timed, after };
}

export function MarkerEntry({ marker, meId, time, timeTitle, buyer, editHref }: {
  marker: ThreadMarker; meId: string | null; time: string; timeTitle: string; buyer?: string;
  /** A logged team call: its Edit link (the Deal tab's log form). */
  editHref?: string;
}) {
  if (marker.kind === "sms") return <SmsThreadEntry sms={marker.sms} time={time} timeTitle={timeTitle} />;
  if (marker.kind === "team_call_logged") return <TeamCallEntry call={marker} meId={meId} editHref={editHref} />;
  // The booked marker holds its own date and time.
  return <ThreadMarkerLine kind={marker.kind} text={markerText(marker, meId, buyer)} time={marker.kind === "team_call_booked" ? "" : time} timeTitle={timeTitle} dateTime={marker.at.toISOString()} />;
}

type LoggedCall = Extract<ThreadMarker, { kind: "team_call_logged" }>;

/** "Team call · 12 min · Mon 23 Nov 15:32"; "No answer · Mon 23 Nov 15:30" for a call that did not happen. */
export function teamCallTitle(m: LoggedCall): string {
  const when = isolate(formatDueLocal(m.startedAt, m.timezone));
  if (m.outcome !== "spoke") return `${t("team_call.title")} · ${t("team_call.logged_outcome", { outcome: t(`team_call.outcome.${m.outcome}`), when })}`;
  return m.lengthMin ? t("team_call.logged_title", { length: m.lengthMin, when }) : t("team_call.logged_title_short", { when });
}

/**
 * A logged team call in the seller's thread (board ReachSeller): "Team call · 12 min ·
 * Mon 23 Nov 15:32", "{who} called +972 50-•••-4567 · logged by {who}", the note, and Edit.
 * The phone is masked here (only the Deal tab card shows it in full).
 */
export function TeamCallEntry({ call, meId, editHref }: { call: LoggedCall; meId: string | null; editHref?: string }) {
  // Who calls is not recorded yet (anyone on the team): the person who logged it, "You" / "you" for the viewer.
  const who = call.by ? isolate(personName(call.by, meId, t("people.you"))) : t("conv.who.team");
  const by = call.by ? isolate(personName(call.by, meId, t("people.you_lower"))) : t("conv.who.team");
  return (
    <div className="sas-teamcall-entry" role="note" data-team-call-entry={call.outcome}>
      <span className="sas-teamcall-entry__icon" aria-hidden="true"><Icon name="phone-call" /></span>
      <div className="sas-teamcall-entry__body">
        <div className="sas-teamcall-entry__head">
          <strong>{teamCallTitle(call)}</strong>
          {editHref ? <a href={editHref} className="sas-teamcall-entry__edit" data-team-call-edit="">{t("team_call.edit")}</a> : null}
        </div>
        <span className="sas-small">{call.phone ? t("team_call.logged_by", { who, by, phone: call.phone }) : t("team_call.logged_by_nophone", { who, by })}</span>
        {call.note ? <p className="sas-teamcall-entry__note" dir="auto">{call.note}</p> : null}
      </div>
    </div>
  );
}

const SMS_STATE_ICON: Record<SmsEntry["state"], IconName> = {
  delivered: "check", sent: "clock", test_mode: "flask-conical", not_delivered: "alert-triangle", not_sent: "alert-triangle",
};

/** Why an SMS was not sent or not delivered, in plain words: a rule's reason, or Twilio's error code. */
export function smsReasonText(reason: string | null): string | null {
  if (!reason) return null;
  const code = /^(\d{5})\b/.exec(reason)?.[1];
  return maybe(`conv.sms.reason.${reason}`) ?? (code ? maybe(`conv.sms.err.${code}`) ?? t("conv.sms.err.other", { code }) : reason);
}

/** The SMS card's state words: "Delivered", "Not sent: test mode", "Not delivered: number unreachable". */
export function smsStateText(s: Pick<SmsEntry, "state" | "reason">): string {
  const why = smsReasonText(s.reason);
  if (s.state === "not_delivered") return why ? t("conv.sms.state.not_delivered_why", { reason: why }) : t("conv.sms.state.not_delivered");
  if (s.state === "not_sent") return t("conv.sms.state.not_sent_why", { reason: why ?? s.reason ?? "" });
  return t(`conv.sms.state.${s.state}`);
}

/**
 * An SMS to the buyer in the seller's thread (board ReachSeller): a dashed card on the
 * seller's side, "SMS to +972 50-•••-4567", the text, and its state on the right with an
 * icon (Delivered: muted check; Not sent: test mode: amber flask; Not delivered: red alert).
 */
export function SmsThreadEntry({ sms, time, timeTitle }: { sms: SmsEntry; time: string; timeTitle: string }) {
  const timed = sms.state === "delivered" || sms.state === "sent";
  return (
    <div className="sas-sms-entry" role="note" data-sms-entry={sms.state}>
      <div className="sas-sms-entry__head">
        <Icon name="message-square" />
        <strong>{t("conv.sms.label")}</strong>
        <span className="sas-sms-entry__to">{t("conv.sms.to", { phone: sms.to })}</span>
        <span className={`sas-sms-entry__state sas-sms-entry__state--${sms.state}`} title={timeTitle}>
          <Icon name={SMS_STATE_ICON[sms.state]} />
          <span>{smsStateText(sms)}</span>
          {timed ? <><span aria-hidden="true">·</span><time className="sas-num" dateTime={sms.at.toISOString()}>{time}</time></> : null}
        </span>
      </div>
      <p className="sas-sms-entry__text" dir="auto">{sms.text ?? t(`conv.sms.kind.${sms.kind}`)}</p>
    </div>
  );
}

/**
 * An order-form link from the seller's side, as the card the buyer sees in the chat (seller, "Order form · Q-2041",
 * totals, "Open order form"), in the chat's language; never the raw /f/… URL. Any other text of the message
 * shows in its bubble above the card.
 */
export function FormCardMessage({ actor, who, time, timeTitle, locale, text, cards }: {
  actor: "buyer" | "agent" | "human" | "system"; who: string; time: string; timeTitle: string; locale: Locale; text: string; cards: SellerFormCard[];
}) {
  return (
    <div className={`sas-msg sas-msg--${actor}`} data-app-message="order_form">
      <div className="sas-msg__meta">
        <span className="sas-msg__who">{who}</span>
        <span className="sas-msg__time" title={timeTitle}>{time}</span>
      </div>
      {text ? <div className="sas-msg__bubble" lang={locale} dir="auto">{text}</div> : null}
      {cards.map(({ preview: p }) => <OrderFormCard key={p.url} p={p} locale={locale} />)}
    </div>
  );
}

function OrderFormCard({ p, locale }: { p: SellerFormCard["preview"]; locale: Locale }) {
  const initials = p.seller.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="sas-fcard" lang={locale} dir={locale === "he" ? "rtl" : "ltr"} data-form-card="">
      <div className="sas-fcard__top">
        <span className="sas-fcard__logo" aria-hidden="true">{initials}</span>
        <span className="sas-fcard__text">
          <b dir="auto">{p.seller}</b>
          {/* The buyer sees a version only from v2 on, as on the buyer's card. */}
          {/* A signed form waiting for payment: "Payment · Q-1002" and "Pay now", as the buyer's card. */}
          <span>{t(p.pay ? "buyer.sim.pay_label" : "buyer.sim.form_label", undefined, locale)} · <bdi className="sas-id sas-id--plain">{p.ref.replace(/ v1$/, "")}</bdi></span>
          {p.oneTime || p.recurring ? (
            <span className="sas-fcard__sum">
              {p.oneTime ? <><bdi className="sas-num">{p.oneTime}</bdi> {t("buyer.sim.today_word", undefined, locale)}</> : null}
              {p.oneTime && p.recurring ? " + " : null}
              {p.recurring ? <><bdi className="sas-num">{p.recurring}</bdi>{t("buyer.sim.per_month", undefined, locale)}</> : null}
            </span>
          ) : null}
        </span>
      </div>
      <a className="sas-fcard__btn" href={p.url} target="_blank" rel="noreferrer" data-card-pay={p.pay ? "" : undefined}>{t(p.pay ? "buyer.sim.pay_now" : "buyer.sim.open_form", undefined, locale)}</a>
    </div>
  );
}

/** Lead statuses whose deal is over while the agent still answers in the chat. */
const DEAL_ENDED = ["won", "lost"] as const;
export const dealEnded = (leadStatus: string | null | undefined): leadStatus is "won" | "lost" => (DEAL_ENDED as readonly string[]).includes(leadStatus ?? "");

/** One line on who has the conversation: agent, a person, or closed. A won or lost deal says so (round-4 review E2). */
export function conversationStatusText(view: Pick<ConversationView, "conversation" | "takenOverBy">, leadOptedOut: boolean, leadStatus?: string | null): string {
  const { conversation: c, takenOverBy } = view;
  if (c.status === "closed" || leadOptedOut) return t(leadOptedOut ? "conv.status.closed_opted_out" : "conv.status.closed");
  if (c.status === "human") return takenOverBy ? t("conv.status.human", { name: displayName(takenOverBy) }) : t("conv.status.human_unknown");
  if (dealEnded(leadStatus)) return t(leadStatus === "won" ? "conv.status.won" : "conv.status.lost");
  return t("conv.status.open");
}

/** An order form a person sent, shown in the seller's thread where it happened (round-4 review F2). */
export type FormNote = { id: string; at: Date; who: string; url: string | null; closed: boolean };

/**
 * Thread notes from the forms a person sent (lib/orders/service.ts personSentForms):
 * the sender ("you" for the viewer), and the link while it still works.
 */
export function formNotes(
  rows: { id: string; status: string; expiresAt: Date; createdAt: Date; sender: { id: string; firstName: string | null; lastName: string | null; email: string | null } }[],
  meId: string | null,
  linkOf: (id: string) => string,
  now = new Date(),
): FormNote[] {
  return rows.map((r) => {
    const open = (r.status === "sent" || r.status === "opened") && r.expiresAt.getTime() > now.getTime();
    return {
      id: r.id, at: r.createdAt, who: isolate(personName(r.sender, meId, t("people.you_lower"))),
      url: open ? linkOf(r.id) : null, closed: !open && r.status !== "signed",
    };
  });
}

function FormNoteEntry({ note, time, timeTitle }: { note: FormNote; time: string; timeTitle: string }) {
  return (
    <div className="sas-thread-note" data-thread-note="order_form" role="note">
      <Icon name="send" />
      <strong>{t("conv.form_note.sent", { who: note.who })}</strong>
      <span className="sas-msg__time" title={timeTitle}>{time}</span>
      {note.url ? (
        <>
          <a href={note.url} target="_blank" rel="noreferrer">{t("conv.form_note.open")}</a>
          <CopyButton value={note.url} label={t("conv.form_note.copy")} variant="ghost" />
        </>
      ) : note.closed ? <span>{t("conv.form_note.closed")}</span> : null}
      <span style={{ flexBasis: "100%" }}>{t("conv.form_note.only_you")}</span>
    </div>
  );
}

/**
 * A lead with no conversation yet: the forms a person sent still show, as the
 * thread would show them, in place of "No messages yet" (round-4 review F2 follow-up).
 */
export function FormNotesOnly({ notes, timezone, hint }: { notes: FormNote[]; timezone?: string | null; hint?: string }) {
  let lastDay = "";
  const sorted = [...notes].sort((a, b) => a.at.getTime() - b.at.getTime());
  return (
    <section id="conversation" aria-labelledby="conv-h" data-testid="form-notes-only" style={{ borderBlockEnd: "1px solid var(--line)" }}>
      <div className="sas-page-head" style={{ padding: "16px 16px 8px", gap: 8 }}>
        <h2 id="conv-h" className="sas-label" style={{ margin: 0 }}>{t("conv.label")}</h2>
      </div>
      <ChatThread label={t("conv.label")}>
        {sorted.flatMap((n) => {
          const day = localDateIso(n.at, timezone);
          const divider = day === lastDay ? null : <div key={`day-${day}`} className="sas-day" role="separator" aria-label={t("conv.day", { day: formatDayIn(n.at, timezone) })}><span>{formatDayIn(n.at, timezone)}</span></div>;
          lastDay = day;
          return [divider, <FormNoteEntry key={`note-${n.id}`} note={n} time={formatClockIn(n.at, timezone)} timeTitle={formatDateTimeIn(n.at, timezone)} />];
        })}
      </ChatThread>
      {hint ? <p className="sas-small" style={{ margin: 0, padding: "0 16px 16px" }}>{hint}</p> : null}
    </section>
  );
}

/**
 * Take over / reply as a person / hand back (canvas: Main). Every action is a
 * server action that re-checks access; this only decides which form to show.
 */
export function ConversationControls({
  slug, from, view, me, buyerName, leadOptedOut, notice, takeOverInHeader = false, leadStatus = null,
}: {
  /** The lead's status: a won or lost deal says so and keeps Take over as a secondary button. */
  leadStatus?: string | null;
  /** The lead page shows Take over in its header: here only the status line. */
  takeOverInHeader?: boolean;
  slug: string;
  from: "lead" | "lab" | "inbox";
  view: Pick<ConversationView, "conversation" | "takenOverBy" | "suggestedReply">;
  me: Person;
  buyerName: string;
  leadOptedOut: boolean;
  notice?: string;
}) {
  const { conversation: c, suggestedReply } = view;
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="conversationId" value={c.id} />
      <input type="hidden" name="from" value={from} />
    </>
  );
  const noticeText = notice ? maybe(`conv.notice.${notice}`) : null;
  const success = notice === "sent" || notice === "started" || notice === "sent_sim" || notice === "sent_chat" || notice === "started_sim" || notice === "quote_approved" || notice === "quote_in_limit" || notice === "quote_declined";
  const status = conversationStatusText(view, leadOptedOut, leadStatus);
  const ended = dealEnded(leadStatus);
  const replyId = `reply-${from}`;

  return (
    <div className="sas-stack-2" style={{ padding: 16, borderBlockStart: "1px solid var(--line)" }}>
      {noticeText ? (
        <div className={`sas-alert ${success ? "sas-alert--success" : "sas-alert--warning"}`} role="status">
          <Icon name={success ? "check-circle" : "alert-triangle"} /><span>{noticeText}</span>
        </div>
      ) : null}
      {c.status === "closed" || leadOptedOut ? (
        <p className="sas-small" role="status" style={{ margin: 0, display: "flex", gap: 6, alignItems: "center" }}><Icon name="x-circle" />{status}</p>
      ) : c.status === "open" && takeOverInHeader ? (
        <p className="sas-small" role="status" style={{ margin: 0 }}>{status}{ended ? null : <> {t("conv.take_over_hint_header")}</>}</p>
      ) : c.status === "open" ? (
        <form action={takeOverAction} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {hidden}
          <span className="sas-small" style={{ flex: "1 1 240px" }}>
            {status}{ended ? null : <> {from === "lab" ? t("lab.take_over_hint") : t("conv.take_over_hint", { name: buyerName })}</>}
          </span>
          <button type="submit" className={buttonClass(ended ? "secondary" : "takeover", "sm")} data-take-over={ended ? "secondary" : "primary"}><Icon name="user" />{t("conv.take_over")}</button>
        </form>
      ) : (
        <>
          <form action={humanReplyAction} className="sas-stack-2">
            {hidden}
            {/* Conversations states the pause in its banner: the composer only says "Reply as {name}" there (S2). */}
            {from === "inbox" ? null : <span className="sas-small" role="status" style={{ display: "flex", gap: 6, alignItems: "center" }}><Icon name="pause" />{status}</span>}
            <label className="sas-input-label" htmlFor={replyId}>{t("conv.reply_as", { name: firstName(me) })}</label>
            <SuggestedReplyBox
              id={replyId}
              suggested={suggestedReply ?? null}
              label={t("conv.suggested_label")}
              clearLabel={t("conv.suggested_clear")}
              describedBy={c.channel !== "testlab" ? `${replyId}-hint` : undefined}
            />
            {c.channel !== "testlab" ? (
              <span id={`${replyId}-hint`} className="sas-small">
                {c.channel === "whatsapp" ? t("conv.whatsapp_hint") : c.channel === SIMULATOR_CHANNEL ? t("sim.reply_hint") : isWebChat(c.channel) ? t("conv.chat_hint") : t("conv.not_sent_hint")}
              </span>
            ) : null}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="submit" className={buttonClass("primary", "sm")}><Icon name="send" />{t("conv.send")}</button>
            </div>
          </form>
          <form action={handBackAction} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {hidden}
            <span className="sas-small" style={{ flex: "1 1 240px" }}>{t("conv.hand_back_hint")}</span>
            <button type="submit" className={buttonClass("secondary", "sm")}><Icon name="sparkles" />{t("conv.hand_back")}</button>
          </form>
        </>
      )}
    </div>
  );
}

/** The lead's latest conversation as a chat thread with trace chips, a status line and the hand-off controls. */
export function ConversationPanel({
  slug, view, me, buyerName, leadOptedOut, notice, chatWindow, from = "lead", timezone, takeOverInHeader = false,
  leadStatus = null, notes = [], rawToolNames = false, steps,
}: {
  /**
   * "Show agent steps" (board ConvSteps): off hides the tool chips under agent
   * replies; markers, quote cards, form notes and voice entries always show.
   * `back` is where the switch returns to. Without it the chips show and there is no switch.
   */
  steps?: { show: boolean; back: string };
  /** The lead's status (won or lost: the status line says the deal is over). */
  leadStatus?: string | null;
  /** Order forms a person sent, placed in the thread by time (round-4 review F2). */
  notes?: FormNote[];
  /** Platform admins: the tool's internal name as the trace chip's tooltip. */
  rawToolNames?: boolean;
  /** The viewer's time zone (the account's until people have their own): message times and day dividers. */
  timezone?: string | null;
  takeOverInHeader?: boolean;
  /** Where the controls send the seller back to after an action. */
  from?: "lead" | "inbox";
  /** WhatsApp only: the 24-hour window of an active conversation. */
  chatWindow?: WindowState | null;
  slug: string;
  view: ConversationView;
  me: Person;
  buyerName: string;
  leadOptedOut: boolean;
  notice?: string;
}) {
  const { conversation: c, thread, authors } = view;
  // Messages the app wrote (the quote message) are known from the tool call that wrote them.
  const kinds = appMessageKinds(thread.flatMap((x) => x.calls));
  const meId = (me as { id?: string }).id ?? null;
  // Times in the viewer's zone, the zone named on hover; a divider when the day changes.
  const clock = (d: Date) => formatClockIn(d, timezone);
  const full = (d: Date) => formatDateTimeIn(d, timezone);
  let lastDay = "";
  const divider = (d: Date) => {
    const day = localDateIso(d, timezone);
    if (day === lastDay) return null;
    lastDay = day;
    return <div key={`day-${day}`} className="sas-day" role="separator" aria-label={t("conv.day", { day: formatDayIn(d, timezone) })}><span>{formatDayIn(d, timezone)}</span></div>;
  };
  const showSteps = steps?.show ?? true;
  const { timed, after } = splitMarkers(view.markers);
  // A form note whose form is a card in this thread follows that card (the form is posted after the chat's intro,
  // but the form row is created first): never above the intro.
  const formCards = view.formCards ?? {};
  const cardOfForm = new Map<string, string>();
  for (const [messageId, cards] of Object.entries(formCards)) for (const c of cards) if (c.formId && !cardOfForm.has(c.formId)) cardOfForm.set(c.formId, messageId);
  const notesAfter = new Map<string, FormNote[]>();
  for (const n of notes) {
    const mid = cardOfForm.get(n.id);
    if (mid) notesAfter.set(mid, [...(notesAfter.get(mid) ?? []), n]);
  }
  const noteAfter = (id: string) => (notesAfter.get(id) ?? []).map((n) => <FormNoteEntry key={`note-${n.id}`} note={n} time={clock(n.at)} timeTitle={full(n.at)} />);
  // Form notes and take-over / hand-back markers, merged by time and placed before the first later message.
  let pending: { at: Date; node: () => ReactNode }[] = [
    ...notes.filter((n) => !cardOfForm.has(n.id)).map((n) => ({ at: n.at, node: () => <FormNoteEntry key={`note-${n.id}`} note={n} time={clock(n.at)} timeTitle={full(n.at)} /> })),
    ...timed.map((mk, i) => ({
      at: mk.at,
      node: () => <MarkerEntry key={`mk-${i}`} marker={mk} meId={meId} time={clock(mk.at)} timeTitle={full(mk.at)} buyer={buyerName} editHref={`/app/${slug}/leads/${c.leadId}?tab=deal&team_call=edit#callback`} />,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const noteNode = (n: (typeof pending)[number]) => [divider(n.at), n.node()];
  // The agent's hand-off: right after the reply that made it.
  const afterNodes = (id: string) => (after.get(id) ?? []).map((mk) => <MarkerEntry key={`mk-${id}`} marker={mk} meId={meId} time={clock(mk.at)} timeTitle={full(mk.at)} />);
  return (
    <section id="conversation" aria-labelledby="conv-h" style={{ borderBlockEnd: "1px solid var(--line)" }}>
      <div className="sas-page-head" style={{ padding: "16px 16px 8px", gap: 8 }}>
        <h2 id="conv-h" className="sas-label" style={{ margin: 0 }}>{t("conv.label")}</h2>
        {c.channel === SIMULATOR_CHANNEL ? <SimulatedChip /> : c.channel === "testlab" ? <TestLabChip /> : <span className="sas-chip sas-chip--plain">{maybe(`conv.channel.${c.channel}`) ?? c.channel}</span>}
        {chatWindow ? <WindowTimer {...windowTimerProps(chatWindow, new Date())} /> : null}
        {steps ? <span className="sas-steps-switch__slot"><AgentStepsSwitch slug={slug} scope="workspace" show={steps.show} back={steps.back} /></span> : null}
      </div>
      <ChatThread label={t("conv.label")}>
        {thread.length === 0 && notes.length === 0 ? <p className="sas-small" style={{ margin: 0 }}>{t("conv.empty")}</p> : null}
        {thread.flatMap(({ message: m, calls }) => {
          // Notes (forms a person sent) that happened before this message come first.
          const before = pending.filter((n) => n.at.getTime() <= m.createdAt.getTime());
          pending = pending.slice(before.length);
          const noteNodes = before.flatMap(noteNode);
          const day = divider(m.createdAt);
          // The quote message the app wrote shows as the card the buyer saw (the stored text is the fallback).
          const card = view.quoteCards?.[m.id];
          if (card) {
            const back = from === "inbox" ? `/app/${slug}/conversations?c=${c.id}` : `/app/${slug}/leads/${c.leadId}#conversation`;
            return [...noteNodes, day, <QuoteCardMessage key={m.id} card={card} time={clock(m.createdAt)} timeTitle={full(m.createdAt)} slug={slug} approve={{ back }} />, ...afterNodes(m.id)];
          }
          const kind = kinds.get(m.id);
          // A message a team action sent (callback time, team answer, declined price) reads "Team" in the human colour (O7, UX).
          const actor = m.actor === "buyer" ? "buyer" : m.actor === "agent" ? (isTeamText(kind) ? "human" : "agent") : m.actor === "human" ? "human" : "system";
          // Voice call entries (m.voiceSessionId): only test lab calls exist today, and the test lab renders their
          // spoken/typed marks itself. When calls reach leads, pass ChatMessage's `spoken` here as the test lab does;
          // like quote cards and form notes they must show whether or not the agent steps are shown.
          const author = m.actorUserId ? authors[m.actorUserId] : undefined;
          const delivery = actor === "agent" || actor === "human" ? deliveryLabel(m) : null;
          const fcards = actor !== "buyer" ? formCards[m.id] : undefined;
          // Text the app wrote itself (the close after an approval) reads "Agent", as the timeline does (round-4 review B8).
          const who = actor === "buyer" ? buyerName : actor === "agent" ? (isAppText(kind) ? t("conv.qcard.sent_by_app") : t("conv.who.agent")) : actor === "human" ? (author && !isTeamText(kind) ? personName({ id: m.actorUserId ?? "", ...author }, meId, t("people.you")) : t("conv.who.team")) : t("conv.who.system");
          if (fcards?.length) {
            // An order form sent in the chat shows as the card the buyer sees, then the private note on who sent it.
            const rest = fcards.reduce((b, c) => b.split(c.preview.url).join(""), m.body).replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
            return [...noteNodes, day, (
              <FormCardMessage
                key={m.id} actor={actor} who={who} timeTitle={full(m.createdAt)} time={delivery ? `${clock(m.createdAt)} · ${delivery}` : clock(m.createdAt)}
                locale={m.language && isLocale(m.language) ? m.language : "en"} text={rest} cards={fcards}
              />
            ), ...noteAfter(m.id), ...afterNodes(m.id)];
          }
          return [...noteNodes, day, (
            <ChatMessage
              key={m.id} actor={actor} who={who} timeTitle={full(m.createdAt)}
              // A line of a voice call shows the time in the call with a mic (or keyboard) mark; the clock time stays on hover.
              time={m.voiceSessionId && m.spokenAtMs !== null ? undefined : delivery ? `${clock(m.createdAt)} · ${delivery}` : clock(m.createdAt)}
              spoken={m.voiceSessionId && m.spokenAtMs !== null ? {
                at: callClock(m.spokenAtMs / 1000), typed: m.typedInCall,
                label: t(m.typedInCall ? "voice.typed_at" : "voice.spoken_at", { time: callClock(m.spokenAtMs / 1000) }),
                title: `${t(m.typedInCall ? "voice.typed_at" : "voice.spoken_at", { time: callClock(m.spokenAtMs / 1000) })} · ${full(m.createdAt)}`,
              } : undefined}
              locale={m.language && isLocale(m.language) ? m.language : "en"}
              trace={actor === "agent" && showSteps ? traceChips(calls, rawToolNames) : undefined}
            >
              {/* Each message takes its own direction (R5-2): an English reply in a Hebrew chat stays left to right. */}
              <div dir="auto" data-msg-dir="">
                <MessageBody body={m.body} kind={kind} />
              </div>
            </ChatMessage>
          ), ...afterNodes(m.id)];
        })}
        {pending.flatMap(noteNode)}
      </ChatThread>
      <ConversationControls slug={slug} from={from} view={view} me={me} buyerName={buyerName} leadOptedOut={leadOptedOut} notice={notice} takeOverInHeader={takeOverInHeader} leadStatus={leadStatus} />
    </section>
  );
}

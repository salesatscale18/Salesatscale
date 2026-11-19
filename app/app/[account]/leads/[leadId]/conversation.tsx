import { buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import type { ReactNode } from "react";
import { AgentStepsSwitch, ChatMessage, ChatThread, ThreadMarkerLine, type TraceItem } from "@/components/sas/chat";
import type { ThreadMarker } from "@/lib/agent/thread-markers";
import { MessageBody } from "@/components/sas/message-body";
import { APP_MESSAGE_CALL, appMessageKinds, isAppText } from "@/lib/agent/app-message";
import type { ConversationView } from "@/lib/agent/conversation";
import { describeCall } from "@/lib/agent/trace";
import { displayName, personName } from "@/lib/auth/display";
import { formatClockIn, formatDateTimeIn, formatDayIn, localDateIso } from "@/lib/format";
import { isLocale, messages, t, type MessageKey } from "@/lib/i18n";
import { handBackAction, humanReplyAction, takeOverAction } from "../actions";
import { WindowTimer } from "@/components/sas/record";
import { SuggestedReplyBox } from "./suggested-reply";
import { QuoteCardMessage } from "./quote-card-message";
import type { WindowState } from "@/lib/channels/rules";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { SimulatedChip, TestLabChip } from "../simulated-chip";
import { CopyButton } from "@/components/sas/copy-button";
import { isolate } from "@/lib/leads/bidi";
import { TOOL_ICON } from "@/components/sas/tool-chip";

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
export function markerText(m: ThreadMarker, meId: string | null): string {
  if (m.kind === "handoff") return t("conv.marker.handoff");
  if (m.kind === "handed_back") return t("conv.marker.handed_back");
  if (m.kind === "spend_cap") return t("conv.marker.spend_cap");
  return m.by ? t("conv.marker.taken_over", { name: isolate(personName(m.by, meId, t("people.you_lower"))) }) : t("conv.marker.taken_over_unknown");
}

/** Markers placed by time (take-over, hand-back) and those that follow one reply (the agent's hand-off). */
export function splitMarkers(markers: ThreadMarker[] | undefined) {
  const timed = (markers ?? []).filter((m) => m.kind !== "handoff").sort((a, b) => a.at.getTime() - b.at.getTime());
  const after = new Map<string, ThreadMarker[]>();
  for (const m of markers ?? []) if (m.kind === "handoff") after.set(m.afterMessageId, [...(after.get(m.afterMessageId) ?? []), m]);
  return { timed, after };
}

export function MarkerEntry({ marker, meId, time, timeTitle }: { marker: ThreadMarker; meId: string | null; time: string; timeTitle: string }) {
  return <ThreadMarkerLine kind={marker.kind} text={markerText(marker, meId)} time={time} timeTitle={timeTitle} dateTime={marker.at.toISOString()} />;
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
  const success = notice === "sent" || notice === "started" || notice === "sent_sim" || notice === "started_sim" || notice === "quote_approved" || notice === "quote_in_limit";
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
                {c.channel === "whatsapp" ? t("conv.whatsapp_hint") : c.channel === SIMULATOR_CHANNEL ? t("sim.reply_hint") : t("conv.not_sent_hint")}
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
  // Form notes and take-over / hand-back markers, merged by time and placed before the first later message.
  let pending: { at: Date; node: () => ReactNode }[] = [
    ...notes.map((n) => ({ at: n.at, node: () => <FormNoteEntry key={`note-${n.id}`} note={n} time={clock(n.at)} timeTitle={full(n.at)} /> })),
    ...timed.map((mk, i) => ({ at: mk.at, node: () => <MarkerEntry key={`mk-${i}`} marker={mk} meId={meId} time={clock(mk.at)} timeTitle={full(mk.at)} /> })),
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
          const actor = m.actor === "buyer" ? "buyer" : m.actor === "agent" ? "agent" : m.actor === "human" ? "human" : "system";
          // Voice call entries (m.voiceSessionId): only test lab calls exist today, and the test lab renders their
          // spoken/typed marks itself. When calls reach leads, pass ChatMessage's `spoken` here as the test lab does;
          // like quote cards and form notes they must show whether or not the agent steps are shown.
          const author = m.actorUserId ? authors[m.actorUserId] : undefined;
          const delivery = actor === "agent" || actor === "human" ? deliveryLabel(m) : null;
          const kind = kinds.get(m.id);
          // Text the app wrote itself (the close after an approval) reads "Agent", as the timeline does (round-4 review B8).
          const who = actor === "buyer" ? buyerName : actor === "agent" ? (isAppText(kind) ? t("conv.qcard.sent_by_app") : t("conv.who.agent")) : actor === "human" ? (author ? personName({ id: m.actorUserId ?? "", ...author }, meId, t("people.you")) : t("conv.who.team")) : t("conv.who.system");
          return [...noteNodes, day, (
            <ChatMessage
              key={m.id} actor={actor} who={who} time={delivery ? `${clock(m.createdAt)} · ${delivery}` : clock(m.createdAt)} timeTitle={full(m.createdAt)}
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

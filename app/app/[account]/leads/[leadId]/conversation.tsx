import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ChatMessage, ChatThread, type TraceItem } from "@/components/sas/chat";
import { MessageBody } from "@/components/sas/message-body";
import { appMessageKinds } from "@/lib/agent/app-message";
import type { ConversationView } from "@/lib/agent/conversation";
import { describeCall } from "@/lib/agent/trace";
import { displayName } from "@/lib/auth/display";
import { exactTime } from "@/lib/format";
import { isLocale, messages, t, type MessageKey } from "@/lib/i18n";
import { handBackAction, humanReplyAction, takeOverAction } from "../actions";
import { WindowTimer } from "@/components/sas/record";
import { SuggestedReplyBox } from "./suggested-reply";
import type { WindowState } from "@/lib/channels/rules";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { SimulatedChip } from "../simulated-chip";

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

/** Trace chips for an agent message: the seller-readable label, plus Refused/Failed when the tool did not succeed. */
export function traceChips(calls: ConversationView["thread"][number]["calls"]): TraceItem[] {
  return calls.map((c) => ({
    kind: c.name === "lookup_knowledge" ? "knowledge" : "tool",
    label: describeCall(c.name, c.input, c.result, c.outcome).label,
    outcome: c.outcome === "ok" ? undefined : c.outcome,
  }));
}

/** One line on who has the conversation: agent, a person, or closed. */
export function conversationStatusText(view: Pick<ConversationView, "conversation" | "takenOverBy">, leadOptedOut: boolean): string {
  const { conversation: c, takenOverBy } = view;
  if (c.status === "closed" || leadOptedOut) return t(leadOptedOut ? "conv.status.closed_opted_out" : "conv.status.closed");
  if (c.status === "human") return takenOverBy ? t("conv.status.human", { name: displayName(takenOverBy) }) : t("conv.status.human_unknown");
  return t("conv.status.open");
}

/**
 * Take over / reply as a person / hand back (canvas: Main). Every action is a
 * server action that re-checks access; this only decides which form to show.
 */
export function ConversationControls({
  slug, from, view, me, buyerName, leadOptedOut, notice,
}: {
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
  const success = notice === "sent" || notice === "started" || notice === "sent_sim" || notice === "started_sim";
  const status = conversationStatusText(view, leadOptedOut);
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
      ) : c.status === "open" ? (
        <form action={takeOverAction} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {hidden}
          <span className="sas-small" style={{ flex: "1 1 240px" }}>
            {status} {from === "lab" ? t("lab.take_over_hint") : t("conv.take_over_hint", { name: buyerName })}
          </span>
          <button type="submit" className={buttonClass("takeover", "sm")}><Icon name="user" />{t("conv.take_over")}</button>
        </form>
      ) : (
        <>
          <form action={humanReplyAction} className="sas-stack-2">
            {hidden}
            <span className="sas-small" role="status" style={{ display: "flex", gap: 6, alignItems: "center" }}><Icon name="pause" />{status}</span>
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
  slug, view, me, buyerName, leadOptedOut, notice, chatWindow, from = "lead",
}: {
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
  return (
    <section id="conversation" aria-labelledby="conv-h" style={{ borderBlockEnd: "1px solid var(--line)" }}>
      <div className="sas-page-head" style={{ padding: "16px 16px 8px", gap: 8 }}>
        <h2 id="conv-h" className="sas-label" style={{ margin: 0 }}>{t("conv.label")}</h2>
        {c.channel === SIMULATOR_CHANNEL ? <SimulatedChip /> : <span className="sas-chip">{maybe(`conv.channel.${c.channel}`) ?? c.channel}</span>}
        {chatWindow ? <WindowTimer {...windowTimerProps(chatWindow, new Date())} /> : null}
      </div>
      <ChatThread label={t("conv.label")}>
        {thread.length === 0 ? <p className="sas-small" style={{ margin: 0 }}>{t("conv.empty")}</p> : null}
        {thread.map(({ message: m, calls }) => {
          const actor = m.actor === "buyer" ? "buyer" : m.actor === "agent" ? "agent" : m.actor === "human" ? "human" : "system";
          const author = m.actorUserId ? authors[m.actorUserId] : undefined;
          const delivery = actor === "agent" || actor === "human" ? deliveryLabel(m) : null;
          const who = actor === "buyer" ? buyerName : actor === "agent" ? t("conv.who.agent") : actor === "human" ? (author ? displayName(author) : t("conv.who.team")) : t("conv.who.system");
          return (
            <ChatMessage
              key={m.id} actor={actor} who={who} time={delivery ? `${exactTime(m.createdAt)} · ${delivery}` : exactTime(m.createdAt)}
              locale={m.language && isLocale(m.language) ? m.language : "en"}
              trace={actor === "agent" ? traceChips(calls) : undefined}
            >
              <MessageBody body={m.body} kind={kinds.get(m.id)} />
            </ChatMessage>
          );
        })}
      </ChatThread>
      <ConversationControls slug={slug} from={from} view={view} me={me} buyerName={buyerName} leadOptedOut={leadOptedOut} notice={notice} />
    </section>
  );
}

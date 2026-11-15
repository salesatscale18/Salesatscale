import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { ChatMessage, ChatThread, type TraceItem } from "@/components/sas/chat";
import type { ConversationView } from "@/lib/agent/conversation";
import { describeCall } from "@/lib/agent/trace";
import { displayName } from "@/lib/auth/display";
import { exactTime } from "@/lib/format";
import { isLocale, messages, t, type MessageKey } from "@/lib/i18n";
import { handBackAction, humanReplyAction, takeOverAction } from "../actions";

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
  from: "lead" | "lab";
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
  const status = conversationStatusText(view, leadOptedOut);
  const replyId = `reply-${from}`;

  return (
    <div className="sas-stack-2" style={{ padding: 16, borderBlockStart: "1px solid var(--line)" }}>
      {noticeText ? (
        <div className={`sas-alert ${notice === "saved_not_sent" ? "sas-alert--success" : "sas-alert--warning"}`} role="status">
          <Icon name={notice === "saved_not_sent" ? "check-circle" : "alert-triangle"} /><span>{noticeText}</span>
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
            <textarea
              className="sas-textarea" id={replyId} name="text" rows={3} required maxLength={4000}
              defaultValue={suggestedReply ?? ""} dir="auto"
              aria-describedby={suggestedReply || c.channel !== "testlab" ? `${replyId}-hint` : undefined}
            />
            {suggestedReply || c.channel !== "testlab" ? (
              <span id={`${replyId}-hint`} className="sas-small">
                {[suggestedReply ? t("conv.suggested") : null, c.channel !== "testlab" ? t("conv.not_sent_hint") : null].filter(Boolean).join(" ")}
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
  slug, view, me, buyerName, leadOptedOut, notice,
}: {
  slug: string;
  view: ConversationView;
  me: Person;
  buyerName: string;
  leadOptedOut: boolean;
  notice?: string;
}) {
  const { conversation: c, thread, authors } = view;
  return (
    <section id="conversation" aria-labelledby="conv-h" style={{ borderBlockEnd: "1px solid var(--line)" }}>
      <div className="sas-page-head" style={{ padding: "16px 16px 8px", gap: 8 }}>
        <h2 id="conv-h" className="sas-label" style={{ margin: 0 }}>{t("conv.label")}</h2>
        <span className="sas-chip">{maybe(`conv.channel.${c.channel}`) ?? c.channel}</span>
      </div>
      <ChatThread label={t("conv.label")}>
        {thread.length === 0 ? <p className="sas-small" style={{ margin: 0 }}>{t("conv.empty")}</p> : null}
        {thread.map(({ message: m, calls }) => {
          const actor = m.actor === "buyer" ? "buyer" : m.actor === "agent" ? "agent" : m.actor === "human" ? "human" : "system";
          const author = m.actorUserId ? authors[m.actorUserId] : undefined;
          const who = actor === "buyer" ? buyerName : actor === "agent" ? t("conv.who.agent") : actor === "human" ? (author ? displayName(author) : t("conv.who.team")) : t("conv.who.system");
          return (
            <ChatMessage
              key={m.id} actor={actor} who={who} time={exactTime(m.createdAt)}
              locale={m.language && isLocale(m.language) ? m.language : "en"}
              trace={actor === "agent" ? traceChips(calls) : undefined}
            >
              {m.body}
            </ChatMessage>
          );
        })}
      </ChatThread>
      <ConversationControls slug={slug} from="lead" view={view} me={me} buyerName={buyerName} leadOptedOut={leadOptedOut} notice={notice} />
    </section>
  );
}

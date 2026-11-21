/**
 * One icon per lead event type, shared by the lead page timeline and the
 * Overview "Recent activity" panel so the same event looks the same in both
 * (W6: "Chat taken over" is the person icon everywhere, never the gear).
 * Pure (no I/O); "conversation.started_sim" is the simulator start and
 * "conversation.started_chat" the real web-chat start, picked from the event's
 * channel by `leadEventKey`.
 */
import type { IconName } from "@/components/sas/icon";
import type { MessageKey } from "@/lib/i18n";
import { SIMULATOR_CHANNEL, WEB_CHAT_CHANNEL } from "@/lib/simulator/rules";
import { CHAT_OPENED_EVENT } from "@/lib/agent/thread-markers";
import { SMS_EVENTS, isSmsKind } from "@/lib/sms/rules";

export const LEAD_EVENT_ICON: Readonly<Record<string, IconName>> = {
  "lead.created": "user-plus",
  "lead.updated": "file-text",
  "consent.recorded": "shield-check",
  "lead.opted_out": "x-circle",
  "lead.market_changed": "layers",
  "quote.created": "file-text",
  "quote.versioned": "file-text",
  "quote.approved": "check-circle",
  "quote.cancelled": "file-x",
  "quote.declined": "x-circle",
  "handoff.requested": "user",
  "handoff.spend_cap": "user",
  "deal.verified": "shield-check",
  "order_form.sent": "send",
  "order_form.opened": "eye",
  "order_form.signed": "pen",
  "payment.bank_transfer": "clock",
  "payment.failed": "x-circle",
  "order.paid": "credit-card",
  "conversation.taken_over": "user",
  "conversation.handed_back": "sparkles",
  "conversation.human_reply": "message-square",
  "conversation.started": "send",
  "conversation.started_sim": "flask-conical",
  "conversation.started_chat": "message-circle",
  "follow_up.scheduled": "clock",
  "follow_up.sent": "send",
  "follow_up.cancelled": "alarm-clock-off",
  "follow_up.failed": "x-circle",
  "callback.requested": "phone-call",
  "callback.confirmed": "check-circle",
  "callback.changed": "calendar",
  "callback.cancelled": "phone-off",
  "callback.after_agent": "sparkles",
  "callback.after_seller": "user",
  "team_question.asked": "book-open",
  "team_question.answered": "check-circle",
  "team_question.delivered": "send",
  // Reach: SMS nudges and the chat opened from an SMS link.
  [CHAT_OPENED_EVENT]: "message-circle",
  [SMS_EVENTS.sent]: "send",
  [SMS_EVENTS.mocked]: "flask-conical",
  [SMS_EVENTS.refused]: "circle-slash",
  [SMS_EVENTS.failed]: "x-circle",
  [SMS_EVENTS.stopped]: "circle-slash",
  [SMS_EVENTS.resumed]: "refresh-cw",
};

/**
 * Internal lead events that never show in the seller's timeline (lead page and
 * Overview Recent activity): `sms.status` is a delivery update of an SMS that
 * is already on the timeline (its card in the thread shows the state).
 */
export const HIDDEN_LEAD_EVENTS: readonly string[] = [SMS_EVENTS.status];

/** True when an event belongs in the seller's timeline. */
export const isTimelineEvent = (type: string) => !HIDDEN_LEAD_EVENTS.includes(type);

/** SMS events whose title names what the text was about ("SMS sent: order form ready"). */
const SMS_WITH_KIND: ReadonlySet<string> = new Set([SMS_EVENTS.sent, SMS_EVENTS.mocked, SMS_EVENTS.refused, SMS_EVENTS.failed]);

/**
 * One event's timeline title, through the given translator. Most types are one
 * key (`lead.event.<leadEventKey>`); an SMS names its kind ("SMS sent: order
 * form ready"), or a plain "text message" when the kind is unknown.
 */
export function leadEventTitle(
  type: string, data: unknown, tr: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const key = `lead.event.${leadEventKey(type, data)}` as MessageKey;
  if (!SMS_WITH_KIND.has(type)) return tr(key);
  const kind = (data as { kind?: unknown } | null | undefined)?.kind;
  return tr(key, { what: tr((isSmsKind(kind) ? `lead.event.sms_kind.${kind}` : "lead.event.sms_kind.other") as MessageKey) });
}

/**
 * The message/icon key of one event: a conversation start says where it started
 * (simulated buyers: "started_sim"; the real web chat: "started_chat"; otherwise WhatsApp).
 */
export function leadEventKey(type: string, data?: unknown): string {
  if (type !== "conversation.started") return type;
  const channel = (data as { channel?: string } | null | undefined)?.channel;
  return channel === SIMULATOR_CHANNEL ? "conversation.started_sim" : channel === WEB_CHAT_CHANNEL ? "conversation.started_chat" : type;
}

/** The icon of one event; `simulator` marks a conversation started on the buyer simulator, `data` is the event's data (its channel). Unknown types fall back to the gear. */
export function leadEventIcon(type: string, opts: { simulator?: boolean; data?: unknown } = {}): IconName {
  const key = type === "conversation.started" && opts.simulator ? "conversation.started_sim" : leadEventKey(type, opts.data);
  return LEAD_EVENT_ICON[key] ?? "cog";
}

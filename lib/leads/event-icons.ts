/**
 * One icon per lead event type, shared by the lead page timeline and the
 * Overview "Recent activity" panel so the same event looks the same in both
 * (W6: "Chat taken over" is the person icon everywhere, never the gear).
 * Pure (no I/O); "conversation.started_sim" is the simulator start, which the
 * callers pick from the event's channel.
 */
import type { IconName } from "@/components/sas/icon";

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
};

/** The icon of one event; `simulator` marks a conversation started on the buyer simulator. Unknown types fall back to the gear. */
export function leadEventIcon(type: string, opts: { simulator?: boolean } = {}): IconName {
  const key = type === "conversation.started" && opts.simulator ? "conversation.started_sim" : type;
  return LEAD_EVENT_ICON[key] ?? "cog";
}

/**
 * The one place status pills get their tone and icon.
 *
 * Mirrors the "Status language" table in the design system (Trust Blue).
 * Words live in lib/i18n/messages/en.json under `status.<object>.<state>`;
 * tests/unit/status.test.ts checks them against the design system word for word.
 */
import type { IconName } from "@/components/sas/icon";

export type Tone = "neutral" | "agent" | "human" | "success" | "warning" | "danger";

type StatusDef = { tone: Tone; icon: IconName };

export const STATUS = {
  lead: {
    new: { tone: "neutral", icon: "circle-dot" },
    waiting_for_reply: { tone: "neutral", icon: "clock" },
    agent_handling: { tone: "agent", icon: "sparkles" },
    human_handling: { tone: "human", icon: "user" },
    meeting_booked: { tone: "success", icon: "calendar" },
    won: { tone: "success", icon: "check-circle" },
    lost: { tone: "neutral", icon: "circle-slash" },
    opted_out: { tone: "danger", icon: "x-circle" },
  },
  quote: {
    draft: { tone: "neutral", icon: "file-text" },
    awaiting_approval: { tone: "warning", icon: "alert-triangle" },
    sent: { tone: "neutral", icon: "send" },
    expires_today: { tone: "warning", icon: "clock" },
    expired: { tone: "neutral", icon: "calendar-x" },
    replaced: { tone: "neutral", icon: "file-text" },
  },
  order_form: {
    sent: { tone: "neutral", icon: "send" },
    opened: { tone: "neutral", icon: "eye" },
    signed: { tone: "success", icon: "pen" },
    link_expired: { tone: "neutral", icon: "calendar-x" },
  },
  payment: {
    not_started: { tone: "neutral", icon: "credit-card" },
    pending: { tone: "warning", icon: "clock" },
    paid: { tone: "success", icon: "credit-card" },
    failed: { tone: "danger", icon: "x-circle" },
    refunded: { tone: "neutral", icon: "credit-card" },
    bank_transfer_expected: { tone: "warning", icon: "clock" },
  },
  agent_version: {
    draft: { tone: "neutral", icon: "file-text" },
    testing: { tone: "warning", icon: "flask-conical" },
    live: { tone: "success", icon: "sparkles" },
    retired: { tone: "neutral", icon: "archive" },
  },
  channel: {
    connected: { tone: "success", icon: "message-circle" },
    template_pending: { tone: "warning", icon: "clock" },
    template_rejected: { tone: "danger", icon: "x-circle" },
    disconnected: { tone: "danger", icon: "x-circle" },
  },
} as const satisfies Record<string, Record<string, StatusDef>>;

export type StatusObject = keyof typeof STATUS;
export type StatusState<O extends StatusObject> = keyof (typeof STATUS)[O] & string;

export function statusDef<O extends StatusObject>(object: O, state: StatusState<O>): StatusDef {
  return (STATUS[object] as Record<string, StatusDef>)[state];
}

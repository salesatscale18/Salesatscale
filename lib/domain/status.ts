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
    won: { tone: "success", icon: "trophy" },
    lost: { tone: "neutral", icon: "circle-slash" },
    opted_out: { tone: "danger", icon: "x-circle" },
  },
  quote: {
    draft: { tone: "neutral", icon: "file-pen" },
    awaiting_approval: { tone: "warning", icon: "alert-triangle" },
    sent: { tone: "neutral", icon: "send" },
    expires_today: { tone: "warning", icon: "clock" },
    expired: { tone: "neutral", icon: "calendar-x" },
    replaced: { tone: "neutral", icon: "file-text" },
    cancelled: { tone: "neutral", icon: "file-x" },
    // Shown only (no stored status): a signed or paid order came from this quote.
    ordered: { tone: "success", icon: "check-circle" },
  },
  // Quotes and orders V2 (Q-1): "Where it is", one pill per quote row (lib/quotes/where.ts).
  quote_where: {
    awaiting_approval: { tone: "warning", icon: "hourglass" },
    quote_sent: { tone: "neutral", icon: "send" },
    form_sent: { tone: "neutral", icon: "file-signature" },
    ordered: { tone: "success", icon: "check-circle" },
    expired: { tone: "neutral", icon: "calendar-x" },
    declined: { tone: "neutral", icon: "x-circle" },
    draft: { tone: "neutral", icon: "file-pen" },
    replaced: { tone: "neutral", icon: "file-text" },
    cancelled: { tone: "neutral", icon: "file-x" },
  },
  // Offers (board OfferTool, 23 Nov): the state of an offer the agent made, on the seller's offer card.
  offer: {
    offered: { tone: "neutral", icon: "clock" },
    accepted: { tone: "success", icon: "check-circle" },
    not_taken: { tone: "neutral", icon: "x" },
    expired: { tone: "neutral", icon: "calendar-x" },
    needs_approval: { tone: "warning", icon: "alert-triangle" },
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
    draft: { tone: "neutral", icon: "file-pen" },
    testing: { tone: "warning", icon: "flask-conical" },
    live: { tone: "success", icon: "check-circle" },
    retired: { tone: "neutral", icon: "archive" },
  },
  account: {
    setting_up: { tone: "warning", icon: "list-checks" },
    live: { tone: "success", icon: "check-circle" },
    paused: { tone: "neutral", icon: "pause" },
  },
  // Trace only (lead card and test lab): a refusal is the rules working, never an error.
  tool_call: {
    refused: { tone: "warning", icon: "shield-alert" },
    failed: { tone: "danger", icon: "x-circle" },
  },
  catalog_version: {
    draft: { tone: "neutral", icon: "file-pen" },
    live: { tone: "success", icon: "check-circle" },
  },
  // Active is neutral: green is only for wins and verified data.
  catalog_item: {
    active: { tone: "neutral", icon: "check" },
    inactive: { tone: "neutral", icon: "pause" },
    price_missing: { tone: "warning", icon: "alert-triangle" },
  },
  intake_result: {
    created: { tone: "success", icon: "plus" },
    updated: { tone: "neutral", icon: "refresh-cw" },
    rejected: { tone: "danger", icon: "x-circle" },
  },
  channel: {
    connected: { tone: "success", icon: "message-circle" },
    template_pending: { tone: "warning", icon: "clock" },
    template_rejected: { tone: "danger", icon: "x-circle" },
    disconnected: { tone: "danger", icon: "x-circle" },
  },
  price_list: {
    draft: { tone: "neutral", icon: "file-pen" },
    live: { tone: "success", icon: "check-circle" },
  },
  market: {
    setting_up: { tone: "warning", icon: "list-checks" },
    live: { tone: "success", icon: "check-circle" },
    paused: { tone: "neutral", icon: "pause" },
  },
  // Knowledge sources (P8): reading a website, file, note or call transcript.
  source: {
    processing: { tone: "agent", icon: "sparkles" },
    // Read, but no analysis has looked at its current text and it has no facts (computed on read, no column).
    not_analyzed: { tone: "neutral", icon: "circle-dot" },
    ready: { tone: "neutral", icon: "scan-search" },
    // Every fact found in it is reviewed and at least one approved (computed on read, no column).
    approved: { tone: "success", icon: "check-circle" },
    needs_input: { tone: "warning", icon: "alert-triangle" },
    partly_failed: { tone: "danger", icon: "circle-alert" },
    failed: { tone: "danger", icon: "x-circle" },
  },
  // One "Analyze sources" run (knowledge pipeline).
  analysis_run: {
    running: { tone: "agent", icon: "sparkles" },
    completed: { tone: "neutral", icon: "check" },
    stopped_cap: { tone: "warning", icon: "pause" },
    failed: { tone: "danger", icon: "x-circle" },
  },
  // Knowledge suggested from sources and recorded calls (P8), waiting for the admin.
  generated_suggestion: {
    suggested: { tone: "agent", icon: "sparkles" },
    accepted: { tone: "success", icon: "check-circle" },
    rejected: { tone: "neutral", icon: "x-circle" },
  },
  // Lead pages (lib/lead-pages): a paused page's form tells buyers it is closed.
  lead_page: {
    draft: { tone: "neutral", icon: "file-pen" },
    live: { tone: "success", icon: "check-circle" },
    paused: { tone: "warning", icon: "clock" },
    /** Display only: `options.archivedAt` on a page stored as paused (lib/lead-pages/archive.ts); not a DB enum value. */
    archived: { tone: "neutral", icon: "archive" },
  },
} as const satisfies Record<string, Record<string, StatusDef>>;

export type StatusObject = keyof typeof STATUS;
export type StatusState<O extends StatusObject> = keyof (typeof STATUS)[O] & string;

export function statusDef<O extends StatusObject>(object: O, state: StatusState<O>): StatusDef {
  return (STATUS[object] as Record<string, StatusDef>)[state];
}

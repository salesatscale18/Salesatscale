/**
 * WhatsApp channel rules (P6.3, P6.4). Pure: no database, no network.
 */
import { isWithinContactHours } from "@/lib/accounts/contact-hours";
import type { ContactHours } from "@/db/schema";

/** WhatsApp's customer service window: free text only within 24 hours of the buyer's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type WindowState = { open: boolean; closesAt: Date | null };

export function windowState(lastBuyerMessageAt: Date | null, now: Date): WindowState {
  if (!lastBuyerMessageAt) return { open: false, closesAt: null };
  const closesAt = new Date(lastBuyerMessageAt.getTime() + WINDOW_MS);
  return { open: now < closesAt, closesAt };
}

/** The lead's first name for template variable {{1}}. */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}

/** Template variables: {{1}} = lead first name, {{2}} = seller trade name. */
export function templateVariables(lead: { fullName: string }, account: { tradeName: string }): Record<string, string> {
  return { "1": firstNameOf(lead.fullName), "2": account.tradeName };
}

/** The template text with its variables filled in, as stored on the sent message. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => vars[n] ?? m);
}

export type OpenerRefusal =
  | "not_configured" | "test_lead" | "opted_out" | "no_consent" | "account_not_live" | "account_paused"
  | "outside_contact_hours" | "no_connection" | "no_template" | "no_agent" | "already_started" | "spend_cap";

export type OpenerFacts = {
  twilioConfigured: boolean;
  lead: { isTest: boolean; status: string };
  hasConsent: boolean;
  account: { status: string; contactHours: ContactHours | null; timezone: string };
  hasConnection: boolean;
  hasApprovedOpener: boolean;
  hasLiveAgent: boolean;
  hasActiveWhatsappConversation: boolean;
  /** The account reached its monthly spend cap (lib/ai/usage.ts): no new conversations. */
  spendCapped?: boolean;
  now: Date;
};

/**
 * Whether the agent may open a WhatsApp conversation with this lead (P6.4).
 * Every gate is checked on the server before anything is sent. First failing
 * gate wins, in the order a seller would fix them.
 */
export function openerRefusal(f: OpenerFacts): OpenerRefusal | null {
  if (f.lead.isTest) return "test_lead";
  if (f.lead.status === "opted_out") return "opted_out";
  if (!f.hasConsent) return "no_consent";
  if (f.hasActiveWhatsappConversation) return "already_started";
  if (f.account.status === "paused") return "account_paused";
  if (f.account.status !== "live") return "account_not_live";
  if (f.spendCapped) return "spend_cap";
  if (!f.twilioConfigured) return "not_configured";
  if (!f.hasConnection) return "no_connection";
  if (!f.hasApprovedOpener) return "no_template";
  if (!f.hasLiveAgent) return "no_agent";
  if (!isWithinContactHours(f.account.contactHours, f.account.timezone, f.now)) return "outside_contact_hours";
  return null;
}

const RANK: Record<string, number> = { not_sent: 0, accepted: 0, queued: 0, sending: 0, sent: 1, delivered: 2, read: 3 };
const FAILED = new Set(["failed", "undelivered"]);

/**
 * The delivery status to keep when a status callback arrives. Twilio may
 * deliver callbacks out of order: a status never moves backwards, a failure
 * overrides anything short of `read`, and unknown statuses are ignored.
 */
export function nextDeliveryStatus(current: string | null, incoming: string): string | null {
  const s = incoming.toLowerCase();
  if (FAILED.has(s)) return current === "read" || (current && FAILED.has(current)) ? null : s;
  if (!(s in RANK)) return null;
  if (current && FAILED.has(current)) return null;
  return RANK[s] > (current ? (RANK[current] ?? -1) : -1) ? s : null;
}

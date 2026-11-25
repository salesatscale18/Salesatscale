/**
 * SMS entries in the seller's thread (board ReachSeller): a dashed card
 * "SMS to +972 50-•••-4567", the text, and a state on the right:
 * - Delivered (muted check)
 * - Sent (on its way; muted)
 * - Not sent: test mode (amber flask): mock mode, or a non-tester in test mode
 * - Not delivered: reason (red alert): Twilio refused it or the network could not deliver it
 * - Not sent: reason (red alert): a rule held it back (SMS stopped, daily cap…)
 * Built from the append-only lead events of lib/sms/rules SMS_EVENTS (no new
 * columns). Refusals that are the normal case for a lead that never gets SMS
 * (test, simulated or demo leads) are not shown.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents, messages } from "@/db/schema";
import { maskPhone } from "@/lib/leads/rules";
import { isSmsKind, SMS_EVENTS, type SmsKind } from "./rules";

export type SmsEntryState = "delivered" | "sent" | "test_mode" | "not_delivered" | "not_sent";

export type SmsEntry = {
  at: Date;
  kind: SmsKind;
  /** The SMS text as sent (null for a refusal: nothing was written). */
  text: string | null;
  /** The number, masked ("+972 50-•••-4567"): the full number shows only on the Deal tab card. */
  to: string;
  state: SmsEntryState;
  /** Why it was not sent or not delivered: a refusal reason, or Twilio's error code and message. */
  reason: string | null;
  conversationId: string | null;
  messageId: string | null;
};

/** Refusals that are the normal case for a lead that never gets SMS: not shown in the thread. */
const QUIET_REFUSALS: ReadonlySet<string> = new Set(["test_lead", "simulated_lead", "no_phone", "demo_number", "not_found", "message_not_found"]);
const DELIVERED: ReadonlySet<string> = new Set(["delivered", "read"]);
const FAILED: ReadonlySet<string> = new Set(["failed", "undelivered"]);

/** "+972 50-•••-4567": the board's mask (lib/leads/rules maskPhone with dots). */
export const maskSmsPhone = (phone: string) => maskPhone(phone).replace("***", "•••");

type EventRow = { type: string; createdAt: Date; data: Record<string, unknown> | null };
type MessageStatus = { deliveryStatus: string | null; deliveryError: string | null };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * The thread entries from a lead's SMS events (pure). `messageStatus`: the chat
 * message each real SMS nudged, by SID (its delivery follows the SMS through
 * the status webhook); `statusEvents`: sms.status updates for an SMS that
 * nudged no message (hand-back).
 */
export function smsEntries(
  events: readonly EventRow[], phone: string, messageStatus: ReadonlyMap<string, MessageStatus>,
): SmsEntry[] {
  const latestStatus = new Map<string, { status: string; error: string | null; at: number }>();
  for (const e of events) {
    if (e.type !== SMS_EVENTS.status) continue;
    const sid = str(e.data?.sid);
    if (!sid) continue;
    const cur = latestStatus.get(sid);
    if (!cur || e.createdAt.getTime() >= cur.at) latestStatus.set(sid, { status: String(e.data?.status ?? ""), error: str(e.data?.error), at: e.createdAt.getTime() });
  }
  const to = maskSmsPhone(phone);
  const out: SmsEntry[] = [];
  for (const e of events) {
    const d = e.data ?? {};
    const kind = d.kind;
    if (!isSmsKind(kind)) continue;
    const base = { at: e.createdAt, kind, to, text: str(d.text), conversationId: str(d.conversationId), messageId: str(d.messageId) };
    if (e.type === SMS_EVENTS.mocked) out.push({ ...base, state: "test_mode", reason: null });
    else if (e.type === SMS_EVENTS.failed) out.push({ ...base, state: "not_delivered", reason: [str(d.code), str(d.message)].filter(Boolean).join(": ") || null });
    else if (e.type === SMS_EVENTS.refused) {
      const reason = str(d.reason) ?? "unknown";
      if (!QUIET_REFUSALS.has(reason)) out.push({ ...base, text: null, state: "not_sent", reason });
    } else if (e.type === SMS_EVENTS.sent) {
      const sid = str(d.sid);
      const onMessage = sid && d.onMessage === true ? messageStatus.get(sid) : undefined;
      const update = sid ? latestStatus.get(sid) : undefined;
      const status = onMessage?.deliveryStatus ?? update?.status ?? str(d.status) ?? "sent";
      const error = onMessage?.deliveryError ?? update?.error ?? null;
      out.push({
        ...base,
        state: DELIVERED.has(status) ? "delivered" : FAILED.has(status) ? "not_delivered" : "sent",
        reason: FAILED.has(status) ? error : null,
      });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const ENTRY_EVENTS = [SMS_EVENTS.sent, SMS_EVENTS.mocked, SMS_EVENTS.refused, SMS_EVENTS.failed, SMS_EVENTS.status];

/** The lead's SMS entries since `since` (a conversation's start). Scoped by account. */
export async function loadSmsEntries(db: Db, accountId: string, leadId: string, phone: string, since: Date): Promise<SmsEntry[]> {
  const events = await db.select({ type: leadEvents.type, createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, ENTRY_EVENTS), gte(leadEvents.createdAt, since)));
  const sids = [...new Set(events.filter((e) => e.type === SMS_EVENTS.sent && e.data?.onMessage === true).map((e) => str(e.data?.sid)).filter((s): s is string => !!s))];
  const rows = sids.length
    ? await db.select({ sid: messages.channelMessageId, deliveryStatus: messages.deliveryStatus, deliveryError: messages.deliveryError }).from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.channelMessageId, sids)))
    : [];
  return smsEntries(events, phone, new Map(rows.filter((r) => r.sid).map((r) => [r.sid!, r])));
}

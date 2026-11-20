/**
 * SMS service (reach plan §3): one SMS nudge with the chat link, the buyer's
 * stop link, and the lead's SMS state. Scoped by account id everywhere except
 * the stop link, whose signed token is the buyer's only credential.
 *
 * Every attempt is a lead event (lib/sms/rules SMS_EVENTS): sent, mocked
 * ("not sent: mock"), refused with the rule's reason, or failed at Twilio.
 * A real SMS that nudges a chat message stores its Twilio SID on that message
 * (`messages.channel_message_id`), so the existing status webhook
 * (/api/webhooks/whatsapp/status → applyStatusCallback, matched by SID)
 * updates its delivery.
 *
 * No callers yet: later lanes call `nudgeBuyer` from the opener, follow-ups,
 * hand-back and the team-call card.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { consentRecords, conversations, leadEvents, leads, messages, sellerAccounts } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { twilioConfig } from "@/lib/channels/twilio";
import { publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { publicUrl } from "@/lib/orders/token";
import { rateLimit } from "@/lib/security/rate-limit";
import { ensureChatLink } from "@/lib/simulator/service";
import { chatPath } from "@/lib/simulator/token";
import {
  SMS_EVENTS, SMS_NUDGE_EVENTS, SMS_VALIDITY_SECONDS, smsConfig, smsRefusal, smsRoute, smsSegments, smsStoppedOf,
  type SmsKind, type SmsMode, type SmsRefusal,
} from "./rules";
import { smsText } from "./texts";
import { leadIdFromStopToken, stopPath, stopTokenFor } from "./token";
import { defaultSmsTransport, type SmsTransport } from "./transport";

type Env = Record<string, string | undefined>;

/** Key of the platform-wide daily counter of real SMS (lib/security/rate-limit, one-day window). */
export const SMS_DAILY_KEY = "sms:daily:platform";

export type NudgeInput = {
  accountId: string;
  leadId: string;
  kind: SmsKind;
  /** The chat message this SMS points the buyer to; a real SMS stores its SID there for delivery updates. */
  messageId?: string | null;
  now?: Date;
};

export type NudgeResult =
  | { outcome: "sent"; sid: string; mode: SmsMode }
  | { outcome: "mocked"; reason: "mock" | "not_a_tester" }
  | { outcome: "refused"; reason: SmsRefusal | "not_found" | "message_not_found" | "no_chat_link" | "not_configured" | "daily_cap" }
  | { outcome: "failed"; code: string };

export type NudgeDeps = { transport?: SmsTransport | null; env?: Env };

const DAY_MS = 24 * 3600_000;

/**
 * Sends (or mocks, or refuses) one SMS to the lead with its chat link and stop
 * link. Every rule is checked here, server-side, before any transport call.
 */
export async function nudgeBuyer(db: Db, actor: Actor, input: NudgeInput, deps: NudgeDeps = {}): Promise<NudgeResult> {
  const now = input.now ?? new Date();
  const env = deps.env ?? process.env;
  const { accountId, leadId, kind } = input;
  const messageId = input.messageId ?? null;

  const [row] = await db.select({ lead: leads, account: sellerAccounts }).from(leads)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, leads.accountId))
    .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!row) return { outcome: "refused", reason: "not_found" };
  const { lead, account } = row;

  const record = async (type: string, data: Record<string, unknown>) => {
    await db.insert(leadEvents).values({
      accountId, leadId, type, actor: actor.userId ? "human" : "system", actorUserId: actor.userId,
      data: { kind, messageId, ...data },
    });
  };
  const refuse = async (reason: Extract<NudgeResult, { outcome: "refused" }>["reason"]): Promise<NudgeResult> => {
    await record(SMS_EVENTS.refused, { reason });
    return { outcome: "refused", reason };
  };

  let message: { id: string; channelMessageId: string | null; deliveryStatus: string | null } | null = null;
  if (messageId) {
    const [m] = await db.select({ id: messages.id, channelMessageId: messages.channelMessageId, deliveryStatus: messages.deliveryStatus }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId), eq(conversations.accountId, accountId), eq(conversations.leadId, leadId)));
    if (!m) return refuse("message_not_found");
    message = m;
  }

  const [[consent], events, contact] = await Promise.all([
    db.select({ id: consentRecords.id }).from(consentRecords)
      .where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId))).limit(1),
    db.select({ type: leadEvents.type, createdAt: leadEvents.createdAt }).from(leadEvents)
      .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId),
        inArray(leadEvents.type, [SMS_EVENTS.stopped, SMS_EVENTS.resumed, ...SMS_NUDGE_EVENTS]))),
    leadContactSettings(db, account, lead.marketId),
  ]);
  const refusal = smsRefusal({
    lead, kind, now,
    stopped: smsStoppedOf(events).stopped,
    hasConsent: !!consent,
    contactHours: contact.contactHours,
    timezone: contact.timezone,
    recent: events.filter((e) => SMS_NUDGE_EVENTS.includes(e.type) && now.getTime() - e.createdAt.getTime() < DAY_MS).map((e) => e.createdAt),
  });
  if (refusal) return refuse(refusal);

  const link = await ensureChatLink(db, actor, accountId, leadId);
  if (!link) return refuse("no_chat_link");
  const lang = lead.language === "he" ? "he" : "en";
  const seller = account.tradeNameLocal?.[lang]?.replace(/\s+/g, " ").trim() || account.tradeName;
  const body = smsText(kind, lang, {
    seller,
    chat: publicUrl(chatPath(link.token), env),
    stop: publicUrl(stopPath(stopTokenFor(leadId)), env),
  });
  const segments = smsSegments(body);

  const config = smsConfig(env);
  const route = smsRoute(config, !!twilioConfig(env), lead.phone);
  if (route.action === "mock") {
    // Counts only: never the number or the text.
    console.info(`[sms] mock kind=${kind} segments=${segments} reason=${route.reason}`);
    await record(SMS_EVENTS.mocked, { mode: config.mode, notSent: route.reason, segments });
    return { outcome: "mocked", reason: route.reason };
  }
  if (route.action === "refuse") return refuse(route.reason);

  const transport = deps.transport !== undefined ? deps.transport : defaultSmsTransport(config);
  if (!transport) return refuse("not_configured");
  // The platform's hard stop on real SMS per day (one-day window): counted only for real sends.
  if (!(await rateLimit(db, SMS_DAILY_KEY, { limit: config.dailyCap, windowSeconds: 86_400 }, now)).ok) return refuse("daily_cap");

  const r = await transport.send({
    to: lead.phone, body,
    statusCallback: statusCallbackUrl(publicBaseUrl(env)),
    validityPeriodSeconds: SMS_VALIDITY_SECONDS[kind] ?? null,
  });
  if (!r.ok) {
    await record(SMS_EVENTS.failed, { mode: config.mode, code: r.code, message: r.message.slice(0, 300) });
    return { outcome: "failed", code: r.code };
  }
  const status = r.status === "accepted" ? "queued" : r.status;
  // The chat message's delivery now follows the SMS (status webhook, matched by SID), unless the buyer already read it in the chat.
  const attached = !!message && !message.channelMessageId;
  if (message && attached) {
    await db.update(messages).set({ channelMessageId: r.sid, ...(message.deliveryStatus === "read" ? {} : { deliveryStatus: status, deliveryError: null }) })
      .where(and(eq(messages.id, message.id), eq(messages.accountId, accountId)));
  }
  await record(SMS_EVENTS.sent, { mode: config.mode, sid: r.sid, status, segments, onMessage: attached });
  if (actor.actingAs) await writeAudit(db, actor, { accountId, action: "sms.sent", targetType: "lead", targetId: leadId, details: { kind } });
  return { outcome: "sent", sid: r.sid, mode: config.mode };
}

// ---------------------------------------------------------------------------
// Stop link (/chat/stop/<token>)
// ---------------------------------------------------------------------------

export type StopPageInfo = { leadId: string; accountId: string; lang: "en" | "he"; seller: string; stopped: boolean };

/** What the stop page shows for a token, or null for a wrong or forged token or a deleted lead. */
export async function stopPageInfo(db: Db, token: string): Promise<StopPageInfo | null> {
  const leadId = leadIdFromStopToken(token);
  if (!leadId) return null;
  const [row] = await db.select({ lead: leads, account: sellerAccounts }).from(leads)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, leads.accountId))
    .where(eq(leads.id, leadId));
  if (!row) return null;
  const lang = row.lead.language === "he" ? "he" : "en";
  const state = await smsState(db, row.account.id, leadId);
  return {
    leadId, accountId: row.account.id, lang,
    seller: row.account.tradeNameLocal?.[lang]?.replace(/\s+/g, " ").trim() || row.account.tradeName,
    stopped: state.stopped,
  };
}

/**
 * The buyer stops SMS from this seller: an `sms.stopped` lead event (actor
 * buyer). It stops SMS only; the chat still answers if the buyer writes.
 * Idempotent: a second stop writes nothing.
 */
export async function stopSms(db: Db, token: string): Promise<{ ok: true; info: StopPageInfo } | { ok: false }> {
  const info = await stopPageInfo(db, token);
  if (!info) return { ok: false };
  if (!info.stopped) {
    await db.insert(leadEvents).values({ accountId: info.accountId, leadId: info.leadId, type: SMS_EVENTS.stopped, actor: "buyer", data: { via: "stop_link" } });
  }
  return { ok: true, info: { ...info, stopped: true } };
}

export type SmsState = { stopped: boolean; stoppedAt: Date | null; lastSentAt: Date | null };

/** The lead's SMS state for the seller side: stopped or not, and the last SMS (sent or mocked). */
export async function smsState(db: Db, accountId: string, leadId: string): Promise<SmsState> {
  const [stops, [last]] = await Promise.all([
    db.select({ type: leadEvents.type, createdAt: leadEvents.createdAt }).from(leadEvents)
      .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [SMS_EVENTS.stopped, SMS_EVENTS.resumed]))),
    db.select({ at: leadEvents.createdAt }).from(leadEvents)
      .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...SMS_NUDGE_EVENTS])))
      .orderBy(desc(leadEvents.createdAt)).limit(1),
  ]);
  const s = smsStoppedOf(stops);
  return { stopped: s.stopped, stoppedAt: s.at, lastSentAt: last?.at ?? null };
}

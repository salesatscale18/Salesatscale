/**
 * SMS service (reach plan §3): one SMS nudge with the short chat link
 * (/c/<code>), the buyer's stop link (reached from the chat), and the lead's SMS state. Scoped by account id everywhere except
 * the stop link, whose signed token is the buyer's only credential.
 *
 * Every attempt is a lead event (lib/sms/rules SMS_EVENTS): sent, mocked
 * ("not sent: mock"), refused with the rule's reason, or failed at Twilio.
 * A real SMS that nudges a chat message stores its Twilio SID on that message
 * (`messages.channel_message_id`), so the existing status webhook
 * (/api/webhooks/whatsapp/status → applyStatusCallback, matched by SID)
 * updates its delivery.
 *
 * Callers: lib/sms/outbound.ts (order form, quote ready, chat link, opener).
 * Agent-started kinds (opener, follow-up) are off unless SMS_AGENT_NUDGES=1:
 * then nothing is sent or recorded.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { consentRecords, conversations, leadEvents, leads, messages, orderFormSettings, sellerAccounts } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { twilioConfig } from "@/lib/channels/twilio";
import { publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { currentBuyerLanguage } from "@/lib/conversations/current-language";
import { publicUrl } from "@/lib/orders/token";
import { rateLimit } from "@/lib/security/rate-limit";
import { activeChatToken, chatNames, ensureChatLink } from "@/lib/simulator/service";
import { chatPath, linkIdFromChatToken, shortCodeFor, shortPath } from "@/lib/simulator/token";
import {
  agentSmsEnabled, SMS_COMMERCIAL_KINDS, SMS_EVENTS, SMS_NUDGE_EVENTS, SMS_VALIDITY_SECONDS, smsConfig, smsRefusal, smsRoute, smsSegments, smsStoppedOf,
  type SmsKind, type SmsMode, type SmsRefusal,
} from "./rules";
import { accountSmsTestNumbers } from "./settings";
import { smsLink, smsText } from "./texts";
import { leadIdFromStopToken } from "./token";
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
  /** team_call: the slot in the buyer's zone, formatted ("Mon 23 Nov 15:30"). */
  time?: string;
  now?: Date;
};

export type NudgeResult =
  /** An agent-started kind while SMS_AGENT_NUDGES is off: nothing sent, nothing recorded. */
  | { outcome: "off" }
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
  // The follow-up and the opener wait for the owner's decision on a reply-capable number.
  if (SMS_COMMERCIAL_KINDS.has(kind) && !agentSmsEnabled(env)) return { outcome: "off" };

  const [row] = await db.select({ lead: leads, account: sellerAccounts }).from(leads)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, leads.accountId))
    .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!row) return { outcome: "refused", reason: "not_found" };
  const { lead, account } = row;

  let conversationId: string | null = null;
  const record = async (type: string, data: Record<string, unknown>) => {
    await db.insert(leadEvents).values({
      accountId, leadId, type, actor: actor.userId ? "human" : "system", actorUserId: actor.userId,
      data: { kind, messageId, ...(conversationId ? { conversationId } : {}), ...data },
    });
  };
  const refuse = async (reason: Extract<NudgeResult, { outcome: "refused" }>["reason"]): Promise<NudgeResult> => {
    await record(SMS_EVENTS.refused, { reason });
    return { outcome: "refused", reason };
  };

  let message: { id: string; channelMessageId: string | null; deliveryStatus: string | null; conversationId: string } | null = null;
  if (messageId) {
    const [m] = await db.select({ id: messages.id, channelMessageId: messages.channelMessageId, deliveryStatus: messages.deliveryStatus, conversationId: messages.conversationId }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId), eq(conversations.accountId, accountId), eq(conversations.leadId, leadId)));
    if (!m) return refuse("message_not_found");
    message = m;
    conversationId = m.conversationId;
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
  const linkId = link ? linkIdFromChatToken(link.token) : null;
  if (!link || !linkId) return refuse("no_chat_link");
  // The conversation's current language (the buyer's latest message), else the lead's.
  const lang = await currentBuyerLanguage(db, accountId, lead, conversationId);
  const seller = account.tradeNameLocal?.[lang]?.replace(/\s+/g, " ").trim() || account.tradeName;
  // One link per SMS: the short chat link (/c/<code>), shown without its scheme.
  const body = smsText(kind, lang, {
    seller,
    chat: smsLink(publicUrl(shortPath(shortCodeFor(linkId)), env)),
    agent: SMS_COMMERCIAL_KINDS.has(kind) ? (await chatNames(db, account, lang)).agent : undefined,
    time: input.time,
  });
  const segments = smsSegments(body);

  const config = smsConfig(env, await accountSmsTestNumbers(db, accountId));
  const route = smsRoute(config, !!twilioConfig(env), lead.phone);
  if (route.action === "mock") {
    // Counts only: never the number or the text.
    console.info(`[sms] mock kind=${kind} segments=${segments} reason=${route.reason}`);
    await record(SMS_EVENTS.mocked, { mode: config.mode, notSent: route.reason, segments, text: body });
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
    await record(SMS_EVENTS.failed, { mode: config.mode, code: r.code, message: r.message.slice(0, 300), text: body });
    return { outcome: "failed", code: r.code };
  }
  const status = r.status === "accepted" ? "queued" : r.status;
  // The chat message's delivery now follows the SMS (status webhook, matched by SID), unless the buyer already read it in the chat.
  const attached = !!message && !message.channelMessageId;
  if (message && attached) {
    await db.update(messages).set({ channelMessageId: r.sid, ...(message.deliveryStatus === "read" ? {} : { deliveryStatus: status, deliveryError: null }) })
      .where(and(eq(messages.id, message.id), eq(messages.accountId, accountId)));
  }
  await record(SMS_EVENTS.sent, { mode: config.mode, sid: r.sid, status, segments, onMessage: attached, text: body });
  if (actor.actingAs) await writeAudit(db, actor, { accountId, action: "sms.sent", targetType: "lead", targetId: leadId, details: { kind } });
  return { outcome: "sent", sid: r.sid, mode: config.mode };
}

// ---------------------------------------------------------------------------
// Stop link (/chat/stop/<token>)
// ---------------------------------------------------------------------------

export type StopPageInfo = {
  leadId: string; accountId: string; lang: "en" | "he"; seller: string; stopped: boolean;
  /** The lead's chat (/chat/<token>) for "Keep them" and "Open the chat", or null when it has no active link. */
  chatPath: string | null;
  /** The seller's brand colour (#rrggbb) for the page's avatar and button. */
  brandColor: string | null;
};

/** What the stop page shows for a token, or null for a wrong or forged token or a deleted lead. */
export async function stopPageInfo(db: Db, token: string): Promise<StopPageInfo | null> {
  const leadId = leadIdFromStopToken(token);
  if (!leadId) return null;
  const [row] = await db.select({ lead: leads, account: sellerAccounts }).from(leads)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, leads.accountId))
    .where(eq(leads.id, leadId));
  if (!row) return null;
  const [lang, state, chatToken, [brand]] = await Promise.all([
    // The language the buyer last wrote in, else the lead's.
    currentBuyerLanguage(db, row.account.id, row.lead),
    smsState(db, row.account.id, leadId),
    activeChatToken(db, row.account.id, leadId),
    db.select({ color: orderFormSettings.brandColor }).from(orderFormSettings).where(eq(orderFormSettings.accountId, row.account.id)),
  ]);
  return {
    leadId, accountId: row.account.id, lang,
    seller: row.account.tradeNameLocal?.[lang]?.replace(/\s+/g, " ").trim() || row.account.tradeName,
    stopped: state.stopped,
    chatPath: chatToken ? chatPath(chatToken) : null,
    brandColor: brand?.color ?? null,
  };
}

/**
 * The buyer turns SMS back on from the chat menu: an `sms.resumed` lead event
 * (actor buyer). The caller resolved the chat token (the buyer's credential).
 * Idempotent: nothing is written when SMS are not stopped.
 */
export async function resumeSms(db: Db, accountId: string, leadId: string): Promise<{ resumed: boolean }> {
  const state = await smsState(db, accountId, leadId);
  if (!state.stopped) return { resumed: false };
  await db.insert(leadEvents).values({ accountId, leadId, type: SMS_EVENTS.resumed, actor: "buyer", data: { via: "chat_menu" } });
  return { resumed: true };
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

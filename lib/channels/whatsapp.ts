/**
 * WhatsApp channel service (implementation plan P6.2–P6.5, P6.8), Twilio as
 * the provider. Scoped by account id everywhere; the only lookups that are not
 * are the two webhooks, which find the account from the number Twilio
 * delivered to (inbound) or from the message SID (status callbacks).
 *
 * Rules enforced here, not in the UI:
 * - free text only inside the 24-hour window; outside it, approved templates only
 * - nothing is sent to an opted-out lead (except the one opt-out confirmation)
 * - the opener runs every gate in `openerRefusal` before sending
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, max, ne, or } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { agentVersions, channelConnections, consentRecords, conversations, leadEvents, leads, messages, sellerAccounts } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { approvedTemplate, connectionForMarket, connectionForTester } from "./connections";
import { startTestConversation } from "@/lib/agent/service";
import { maskCardNumbers } from "@/lib/agent/safety";
import { runBuyerTurn } from "@/lib/agent/turn";
import type { LlmClient } from "@/lib/agent/llm";
import { nextDeliveryStatus, openerRefusal, renderTemplate, templateVariables, windowState, type OpenerRefusal, type WindowState } from "./rules";
import { whatsappAddressToE164, type TwilioTransport } from "./twilio";

export type Delivery = { delivered: true } | { delivered: false; reason: string };

/**
 * Public base URL for Twilio status callbacks: APP_URL, else Vercel's
 * production URL. Null locally, where Twilio could not reach us anyway.
 */
export function publicBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const app = env.APP_URL?.trim().replace(/\/+$/, "");
  if (app) return app;
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel}` : null;
}

export const statusCallbackUrl = (base: string | null) => (base ? `${base}/api/webhooks/whatsapp/status` : null);

// ---------------------------------------------------------------------------
// Window and sending
// ---------------------------------------------------------------------------

export async function conversationWindow(db: Db, accountId: string, conversationId: string, now = new Date()): Promise<WindowState> {
  const [row] = await db.select({ last: max(messages.createdAt) }).from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId), eq(messages.actor, "buyer")));
  return windowState(row?.last ?? null, now);
}

async function markNotSent(db: Db, accountId: string, messageId: string, reason: string) {
  await db.update(messages).set({ deliveryStatus: "not_sent", deliveryError: reason.slice(0, 300) })
    .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId)));
}

/**
 * Sends a stored agent or human message as WhatsApp free text. Refused
 * outside the 24-hour window and for opted-out leads (unless `optOutConfirmation`).
 * The outcome is written on the message: channel id and status, or not_sent and why.
 */
export async function deliverText(
  db: Db,
  transport: TwilioTransport | null,
  m: { accountId: string; conversationId: string; messageId: string; body: string },
  opts: { statusCallback?: string | null; optOutConfirmation?: boolean; now?: Date } = {},
): Promise<Delivery> {
  const now = opts.now ?? new Date();
  const fail = async (reason: string): Promise<Delivery> => {
    await markNotSent(db, m.accountId, m.messageId, reason);
    return { delivered: false, reason };
  };
  const [row] = await db.select({ conv: conversations, lead: leads }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.id, m.conversationId), eq(conversations.accountId, m.accountId), eq(leads.accountId, m.accountId)));
  if (!row || row.conv.channel !== "whatsapp") return { delivered: false, reason: "not_whatsapp" };
  // Test-lab chats only ever reach a tester's phone, re-checked against the number's tester list at send time.
  const tester = row.conv.isTest;
  if (tester ? !row.conv.channelAddress : row.lead.isTest) return fail("test_lead");
  if (row.lead.status === "opted_out" && !opts.optOutConfirmation) return fail("opted_out");
  if (!transport) return fail("not_configured");
  const window = await conversationWindow(db, m.accountId, m.conversationId, now);
  if (!window.open) return fail("window_closed");
  const to = tester ? row.conv.channelAddress! : row.lead.phone;
  const connection = tester ? await connectionForTester(db, m.accountId, to) : await connectionForMarket(db, m.accountId, row.lead.marketId);
  if (!connection) return fail(tester ? "not_a_tester" : "no_connection");

  const r = await transport.send({
    to, from: connection.senderNumber, messagingServiceSid: connection.messagingServiceSid,
    statusCallback: opts.statusCallback ?? null, body: m.body,
  });
  if (!r.ok) {
    await db.update(channelConnections).set({ lastError: `${r.code}: ${r.message}`.slice(0, 300) }).where(eq(channelConnections.id, connection.id));
    return fail(`provider: ${r.code} ${r.message}`);
  }
  await Promise.all([
    db.update(messages).set({ channelMessageId: r.sid, deliveryStatus: r.status === "accepted" ? "queued" : r.status, deliveryError: null })
      .where(and(eq(messages.id, m.messageId), eq(messages.accountId, m.accountId))),
    db.update(channelConnections).set({ lastOutboundAt: now, lastError: null }).where(eq(channelConnections.id, connection.id)),
  ]);
  return { delivered: true };
}

// ---------------------------------------------------------------------------
// Opener (P6.4)
// ---------------------------------------------------------------------------

export type OpenerResult =
  | { ok: true; conversationId: string; messageId: string }
  | { ok: false; reason: OpenerRefusal | "not_found" | "provider_error"; detail?: string };

/** The facts every opener gate reads, from real data. Shared by the lead card (to show why not) and the send itself. */
export async function openerFacts(db: Db, transport: TwilioTransport | null, accountId: string, leadId: string, now = new Date()) {
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  if (!lead) return null;
  const [[account], [consent], connection, [live], [activeConv]] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    db.select({ id: consentRecords.id }).from(consentRecords).where(and(eq(consentRecords.accountId, accountId), eq(consentRecords.leadId, leadId))).limit(1),
    connectionForMarket(db, accountId, lead.marketId),
    db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live"))),
    db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), eq(conversations.channel, "whatsapp"), ne(conversations.status, "closed")))
      .limit(1),
  ]);
  const template = await approvedTemplate(db, accountId, "opener", lead.language, account.languages);
  const refusal = openerRefusal({
    twilioConfigured: !!transport,
    lead: { isTest: lead.isTest, status: lead.status },
    hasConsent: !!consent,
    account: { status: account.status, contactHours: account.contactHours, timezone: account.timezone },
    hasConnection: !!connection,
    hasApprovedOpener: !!template,
    hasLiveAgent: !!live,
    hasActiveWhatsappConversation: !!activeConv,
    now,
  });
  return { lead, account, connection, live: live ?? null, template, refusal };
}

/** Sends the approved opening template and starts the WhatsApp conversation. The agent takes over when the buyer replies. */
export async function startWhatsAppConversation(
  db: Db, transport: TwilioTransport | null, actor: Actor, accountId: string, leadId: string,
  opts: { statusCallback?: string | null; now?: Date } = {},
): Promise<OpenerResult> {
  const now = opts.now ?? new Date();
  const facts = await openerFacts(db, transport, accountId, leadId, now);
  if (!facts) return { ok: false, reason: "not_found" };
  if (facts.refusal) return { ok: false, reason: facts.refusal };
  const { lead, account, connection, live, template } = facts;
  // openerRefusal guarantees these.
  if (!transport || !connection || !live || !template) return { ok: false, reason: "not_configured" };

  const vars = templateVariables(lead, account);
  const r = await transport.send({
    to: lead.phone, from: connection.senderNumber, messagingServiceSid: connection.messagingServiceSid,
    statusCallback: opts.statusCallback ?? null, contentSid: template.contentSid, contentVariables: vars,
  });
  if (!r.ok) {
    await db.update(channelConnections).set({ lastError: `${r.code}: ${r.message}`.slice(0, 300) }).where(eq(channelConnections.id, connection.id));
    return { ok: false, reason: "provider_error", detail: `${r.code}: ${r.message}` };
  }
  const conversationId = randomUUID();
  const messageId = randomUUID();
  await atomic(db, (q) => [
    q.insert(conversations).values({
      id: conversationId, accountId, leadId, channel: "whatsapp", agentVersionId: live.id, language: lead.language, createdByUserId: actor.userId,
    }),
    q.insert(messages).values({
      id: messageId, accountId, conversationId, actor: "agent", body: renderTemplate(template.body, vars), language: lead.language,
      agentVersionId: live.id, channelMessageId: r.sid, deliveryStatus: r.status === "accepted" ? "queued" : r.status, templateId: template.id,
    }),
    q.update(leads).set({ status: "waiting_for_reply", lastActivityAt: now })
      .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId), eq(leads.status, "new"))),
    q.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, leadId), eq(leads.accountId, accountId))),
    q.insert(leadEvents).values({
      id: randomUUID(), accountId, leadId, type: "conversation.started", actor: actor.userId ? "human" : "system", actorUserId: actor.userId,
      data: { conversationId, channel: "whatsapp", template: template.name },
    }),
    q.update(channelConnections).set({ lastOutboundAt: now, lastError: null }).where(eq(channelConnections.id, connection.id)),
  ]);
  if (actor.actingAs) await writeAudit(db, actor, { accountId, action: "conversation.started", targetType: "lead", targetId: leadId, details: { conversationId } });
  return { ok: true, conversationId, messageId };
}

// ---------------------------------------------------------------------------
// Inbound (webhook)
// ---------------------------------------------------------------------------

export type InboundResult =
  | { kind: "stored"; accountId: string; conversationId: string; leadId: string; text: string }
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: "malformed" | "unknown_number" | "unknown_sender" | "opted_out" | "account_not_live" | "no_agent" };

/** The text the agent sees for one inbound WhatsApp message, attachments described. */
export function inboundText(params: Record<string, string>): string {
  const body = (params.Body ?? "").trim();
  const media = Number(params.NumMedia ?? 0);
  const types = Array.from({ length: Math.min(Number.isFinite(media) ? media : 0, 10) }, (_, i) => params[`MediaContentType${i}`]).filter(Boolean);
  const note = media > 0 ? `[The buyer sent ${media === 1 ? "an attachment" : `${media} attachments`}${types.length ? ` (${types.join(", ")})` : ""} that cannot be viewed here]` : "";
  return [body, note].filter(Boolean).join("\n").slice(0, 4000) || "[empty message]";
}

/**
 * Stores one inbound WhatsApp message (signature already checked by the route).
 * Deduplicated on Twilio's MessageSid. The agent's reply runs separately
 * (`replyToBuyer`) so the webhook answers Twilio quickly.
 */
export async function receiveInbound(db: Db, params: Record<string, string>, now = new Date()): Promise<InboundResult> {
  const from = whatsappAddressToE164(params.From);
  const to = whatsappAddressToE164(params.To);
  const sid = params.MessageSid ?? params.SmsMessageSid ?? "";
  if (!from || !to || !/^(SM|MM)[0-9a-f]{32}$/i.test(sid)) return { kind: "ignored", reason: "malformed" };

  const [connection] = await db.select().from(channelConnections)
    .where(and(eq(channelConnections.channel, "whatsapp"), eq(channelConnections.senderNumber, to), eq(channelConnections.status, "active")));
  if (!connection) return { kind: "ignored", reason: "unknown_number" };
  const accountId = connection.accountId;
  await db.update(channelConnections).set({ lastInboundAt: now }).where(eq(channelConnections.id, connection.id));

  // A tester's phone: a test-lab chat on the draft agent, whatever leads exist for that phone.
  if (connection.testerNumbers.includes(from)) {
    const conv = await testerConversation(db, accountId, from);
    return storeBuyerMessage(db, conv, sid, params, now, { accountId, conversationId: conv.id, leadId: conv.leadId });
  }

  // Only leads the seller handed us (with consent) are talked to; strangers are ignored.
  const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, accountId), eq(leads.phone, from), eq(leads.isTest, false)));
  if (!lead) return { kind: "ignored", reason: "unknown_sender" };
  if (lead.status === "opted_out") return { kind: "ignored", reason: "opted_out" };
  // Before go-live nothing reaches real leads (testers above are the way to try it). A paused account
  // still stores the message; runBuyerTurn then sends nothing automated.
  const [account] = await db.select({ status: sellerAccounts.status }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (account?.status === "setting_up") return { kind: "ignored", reason: "account_not_live" };

  let [conv] = await db.select().from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, lead.id), eq(conversations.channel, "whatsapp"), eq(conversations.isTest, false), inArray(conversations.status, ["open", "human"])))
    .orderBy(desc(conversations.createdAt)).limit(1);
  if (!conv) {
    // The buyer wrote first (or after a closed conversation): a new conversation on the live agent.
    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live")));
    if (!live) return { kind: "ignored", reason: "no_agent" };
    [conv] = await db.insert(conversations).values({ accountId, leadId: lead.id, channel: "whatsapp", agentVersionId: live.id, language: lead.language }).returning();
  }

  const result = await storeBuyerMessage(db, conv, sid, params, now, { accountId, conversationId: conv.id, leadId: lead.id });
  if (result.kind === "stored" && conv.status === "open") {
    // The buyer answered: the agent handles the lead (unless a person already does).
    await db.update(leads).set({ status: "agent_handling" })
      .where(and(eq(leads.id, lead.id), eq(leads.accountId, accountId), or(eq(leads.status, "new"), eq(leads.status, "waiting_for_reply"))));
  }
  return result;
}

/** Stores the buyer's message once (deduplicated on the Twilio SID), card numbers masked. */
async function storeBuyerMessage(
  db: Db, conv: { id: string; language: string }, sid: string, params: Record<string, string>, now: Date,
  ids: { accountId: string; conversationId: string; leadId: string },
): Promise<InboundResult> {
  const text = inboundText(params);
  const masked = maskCardNumbers(text);
  const [stored] = await db.insert(messages).values({
    accountId: ids.accountId, conversationId: conv.id, actor: "buyer", body: masked.text, language: conv.language, channelMessageId: sid,
  }).onConflictDoNothing().returning({ id: messages.id });
  if (!stored) return { kind: "duplicate" };
  await Promise.all([
    db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conv.id)),
    db.update(leads).set({ lastActivityAt: now }).where(and(eq(leads.id, ids.leadId), eq(leads.accountId, ids.accountId))),
  ]);
  return { kind: "stored", ...ids, text };
}

/**
 * The tester's open WhatsApp test-lab chat, or a new one on the draft agent
 * with a hidden test lead (fake number; the tester's phone lives on the conversation).
 */
async function testerConversation(db: Db, accountId: string, phone: string) {
  const [open] = await db.select().from(conversations)
    .where(and(
      eq(conversations.accountId, accountId), eq(conversations.channel, "whatsapp"), eq(conversations.isTest, true),
      eq(conversations.channelAddress, phone), inArray(conversations.status, ["open", "human"]),
    ))
    .orderBy(desc(conversations.createdAt)).limit(1);
  if (open) return open;
  const [account] = await db.select({ languages: sellerAccounts.languages }).from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const started = await startTestConversation(db, accountId, null, { language: account?.languages[0] ?? "en", channel: "whatsapp", channelAddress: phone });
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, started!.conversationId));
  return conv;
}

/**
 * Runs the agent on the stored buyer message and sends its reply. A taken-over
 * or paused conversation gets no automated reply (runBuyerTurn decides).
 */
export async function replyToBuyer(
  db: Db, llm: LlmClient, transport: TwilioTransport | null,
  m: { accountId: string; conversationId: string; leadId: string; text: string },
  opts: { statusCallback?: string | null } = {},
) {
  const turn = await runBuyerTurn(db, llm, { accountId: m.accountId, conversationId: m.conversationId, text: m.text, buyerMessageStored: true });
  if (turn.status !== "replied") return { turn, delivery: null };
  // The lead was not opted out when the message arrived (receiveInbound), so an
  // opted-out lead now means this reply is the opt-out confirmation.
  const [lead] = await db.select({ status: leads.status }).from(leads).where(and(eq(leads.id, m.leadId), eq(leads.accountId, m.accountId)));
  const delivery = await deliverText(db, transport, { accountId: m.accountId, conversationId: m.conversationId, messageId: turn.messageId, body: turn.text }, {
    statusCallback: opts.statusCallback, optOutConfirmation: lead?.status === "opted_out",
  });
  return { turn, delivery };
}

// ---------------------------------------------------------------------------
// Delivery status callbacks
// ---------------------------------------------------------------------------

/** Applies one Twilio status callback to the message it belongs to. Returns false for unknown messages. */
export async function applyStatusCallback(db: Db, params: Record<string, string>): Promise<boolean> {
  const sid = params.MessageSid ?? params.SmsSid ?? "";
  const incoming = params.MessageStatus ?? params.SmsStatus ?? "";
  if (!sid || !incoming) return false;
  const [msg] = await db.select({ id: messages.id, status: messages.deliveryStatus }).from(messages).where(eq(messages.channelMessageId, sid));
  if (!msg) return false;
  const next = nextDeliveryStatus(msg.status, incoming);
  if (!next) return true;
  const error = params.ErrorCode ? `${params.ErrorCode}${params.ErrorMessage ? `: ${params.ErrorMessage}` : ""}`.slice(0, 300) : null;
  await db.update(messages).set({ deliveryStatus: next, ...(error ? { deliveryError: error } : {}) })
    .where(and(eq(messages.id, msg.id), msg.status === null ? isNull(messages.deliveryStatus) : eq(messages.deliveryStatus, msg.status)));
  return true;
}

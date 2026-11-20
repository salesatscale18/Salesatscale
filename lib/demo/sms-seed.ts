/**
 * Demo seed: two recorded SMS, so the seller's thread shows the SMS card
 * (board ReachSeller) on demo leads. Demo numbers are fictional and never get
 * a real SMS (lib/sms/rules refuses them quietly), so the events are written
 * here the way lib/sms/service.ts nudgeBuyer records them. No Twilio call.
 *
 * - The voice call lead (Gal Demo, web chat): "chat link", Not sent: test mode
 *   (`sms.mocked`, mock mode), right after the chat started.
 * - The lead waiting at the pay step (Avi Demo, the lead with an order form):
 *   the order form goes into the web chat through offerOrderFormInChat (the same
 *   path as "Send order form": the continuation line and the form card), then
 *   "order form ready", Delivered (`sms.sent`, status delivered, a fake SID).
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, leadEvents, orderForms, sellerAccounts } from "@/db/schema";
import type { Actor } from "@/lib/accounts/audit";
import { linkFor } from "@/lib/orders/service";
import { publicUrl } from "@/lib/orders/token";
import { activeChatToken } from "@/lib/simulator/service";
import { linkIdFromChatToken, shortCodeFor, shortPath } from "@/lib/simulator/token";
import { offerOrderFormInChat } from "@/lib/sms/outbound";
import { SMS_EVENTS, smsSegments, type SmsKind } from "@/lib/sms/rules";
import { smsLink, smsText } from "@/lib/sms/texts";

/** The fake Twilio SID of the delivered demo SMS (SM + 32 hex characters, as Twilio's). */
export const DEMO_SMS_SID = "SM0000000000000000000000000000de00";

/** The SMS text with the lead's short chat link, as nudgeBuyer writes it (null without a chat link). */
async function textFor(db: Db, accountId: string, leadId: string, kind: SmsKind): Promise<string | null> {
  const [[account], token] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    activeChatToken(db, accountId, leadId),
  ]);
  const linkId = token ? linkIdFromChatToken(token) : null;
  if (!account || !linkId) return null;
  const seller = account.tradeNameLocal?.en?.replace(/\s+/g, " ").trim() || account.tradeName;
  return smsText(kind, "en", { seller, chat: smsLink(publicUrl(shortPath(shortCodeFor(linkId)))) });
}

export async function seedDemoSms(
  db: Db, actor: Actor & { userId: string }, accountId: string,
  opts: { chatLinkLeadId: string; chatLinkConversationId: string; orderFormLeadId: string; now: Date },
): Promise<{ orderFormConversationId: string; orderFormMessageId: string }> {
  const { now } = opts;
  const record = (leadId: string, type: string, at: Date, data: Record<string, unknown>) =>
    db.insert(leadEvents).values({ accountId, leadId, type, actor: "human", actorUserId: actor.userId, data, createdAt: at });

  // 1. Chat link, not sent: test mode (mock mode records the text it would have sent).
  const [chat] = await db.select({ createdAt: conversations.createdAt }).from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.id, opts.chatLinkConversationId), eq(conversations.leadId, opts.chatLinkLeadId)));
  if (!chat) throw new Error("Demo seed: chat link conversation not found");
  const linkText = await textFor(db, accountId, opts.chatLinkLeadId, "chat_link");
  if (!linkText) throw new Error("Demo seed: chat link lead has no chat link");
  await record(opts.chatLinkLeadId, SMS_EVENTS.mocked, new Date(chat.createdAt.getTime() + 30_000), {
    kind: "chat_link", messageId: null, mode: "mock", notSent: "mock", segments: smsSegments(linkText), text: linkText,
  });

  // 2. Order form ready, delivered: the form goes into the web chat the way "Send order form" posts it.
  const [form] = await db.select({ id: orderForms.id }).from(orderForms)
    .where(and(eq(orderForms.accountId, accountId), eq(orderForms.leadId, opts.orderFormLeadId))).orderBy(desc(orderForms.createdAt)).limit(1);
  if (!form) throw new Error("Demo seed: the pay-step lead has no order form");
  const offer = await offerOrderFormInChat(db, actor, accountId, opts.orderFormLeadId, linkFor(form).url, { now, transport: null });
  if (!offer.posted) throw new Error(`Demo seed: order form not posted in the chat: ${offer.reason}`);
  // A demo number never gets a real SMS: the quiet refusal is replaced by the recorded delivered SMS.
  await db.delete(leadEvents).where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, opts.orderFormLeadId), eq(leadEvents.type, SMS_EVENTS.refused)));
  const formText = await textFor(db, accountId, opts.orderFormLeadId, "order_form");
  if (!formText) throw new Error("Demo seed: the pay-step lead has no chat link");
  await record(opts.orderFormLeadId, SMS_EVENTS.sent, new Date(now.getTime() + 1), {
    kind: "order_form", messageId: offer.messageId, conversationId: offer.conversationId,
    mode: "live", sid: DEMO_SMS_SID, status: "delivered", segments: smsSegments(formText), onMessage: false, text: formText,
  });
  return { orderFormConversationId: offer.conversationId, orderFormMessageId: offer.messageId };
}


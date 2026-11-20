/**
 * The continuation line (UX, MVP): a lead the agent already talked to on
 * another channel (WhatsApp, an earlier chat) opens its first web chat with a
 * fixed line that picks up from the lead's latest state, instead of the
 * generic intro, and the card that state needs right under it:
 * - quote sent, no order yet: the quote line, then the quote card again;
 * - order form sent, not signed: the form line, then the form card;
 * - signed, waiting for payment: the thanks line, then the pay card (the
 *   signed form's link, which opens at the payment step);
 * - anything else: "How can I help?".
 * Fixed templates (lib/i18n buyer.chat.continue.*): no model call.
 * Everything is scoped by account id.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, ne, notInArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, leads, messages, orderForms, orders, quotes, quoteVersions, sellerAccounts, toolCalls } from "@/db/schema";
import { APP_MESSAGE_CALL } from "@/lib/agent/app-message";
import { quoteMessageBody } from "@/lib/agent/tools";
import { formatDayMonthIn } from "@/lib/format";
import { t, type Locale } from "@/lib/i18n";
import { leadContactSettings } from "@/lib/markets/lead-settings";
import { linkFor, payLinkOpen } from "@/lib/orders/service";
import { WEB_CHAT_CHANNELS } from "@/lib/simulator/rules";

/** What the continuation line says and which card follows it. */
export type ContinuationState =
  | { kind: "quote"; ref: string; at: Date; quoteId: string; number: number; version: number }
  | { kind: "form"; ref: string; formId: string }
  | { kind: "pay"; formId: string }
  | { kind: "other" };

export type ContinuationNames = { name: string; agent: string; seller: string };

/** "Q-2041", or "Q-2041 v2" from the second version on (as the buyer's cards show it). */
export const quoteRef = (number: number, version: number) => (version > 1 ? `Q-${number} v${version}` : `Q-${number}`);

/** The line in the lead's language (pure). `date`: the quote's day, short ("15 Nov"), in the lead's zone. */
export function continuationText(state: ContinuationState, names: ContinuationNames, lang: Locale, date = ""): string {
  const base = { name: names.name, agent: names.agent, seller: names.seller };
  if (state.kind === "quote") return t("buyer.chat.continue.quote", { ...base, ref: state.ref, date }, lang);
  if (state.kind === "form") return t("buyer.chat.continue.form", { ...base, ref: state.ref }, lang);
  if (state.kind === "pay") return t("buyer.chat.continue.pay", base, lang);
  return t("buyer.chat.continue.other", base, lang);
}

/** Whether the lead talked with the seller before on another channel: a conversation that is not a web chat and not the test lab. */
export async function hasEarlierConversation(db: Db, accountId: string, leadId: string): Promise<boolean> {
  const [c] = await db.select({ id: conversations.id }).from(conversations)
    .where(and(
      eq(conversations.accountId, accountId), eq(conversations.leadId, leadId), eq(conversations.isTest, false),
      notInArray(conversations.channel, [...WEB_CHAT_CHANNELS, "testlab"]),
    )).limit(1);
  return !!c;
}

/** The lead's latest state, newest step first: signed and waiting for payment, an open order form, a sent quote with no order. */
export async function continuationState(db: Db, accountId: string, leadId: string, now = new Date()): Promise<ContinuationState> {
  const [order] = await db.select({ formId: orders.orderFormId, paymentStatus: orders.paymentStatus, quoteStatus: quotes.status }).from(orders)
    .innerJoin(quotes, eq(quotes.id, orders.quoteId))
    .where(and(eq(orders.accountId, accountId), eq(orders.leadId, leadId), eq(quotes.accountId, accountId)))
    .orderBy(desc(orders.createdAt)).limit(1);
  if (order && payLinkOpen(order.paymentStatus, order.quoteStatus)) return { kind: "pay", formId: order.formId };

  const [form] = await db.select({ id: orderForms.id, snapshot: orderForms.snapshot }).from(orderForms)
    .innerJoin(quotes, eq(quotes.id, orderForms.quoteId))
    .where(and(
      eq(orderForms.accountId, accountId), eq(orderForms.leadId, leadId), inArray(orderForms.status, ["sent", "opened"]),
      gt(orderForms.expiresAt, now), isNull(orderForms.supersededById), ne(quotes.status, "cancelled"),
    ))
    .orderBy(desc(orderForms.createdAt)).limit(1);
  if (form) return { kind: "form", formId: form.id, ref: quoteRef(form.snapshot.quote.number, form.snapshot.quote.version) };

  const sent = await db.select({ id: quotes.id, number: quotes.number, version: quotes.currentVersion }).from(quotes)
    .where(and(eq(quotes.accountId, accountId), eq(quotes.leadId, leadId), eq(quotes.status, "sent")))
    .orderBy(desc(quotes.createdAt));
  if (sent.length) {
    const ordered = new Set((await db.select({ quoteId: orders.quoteId }).from(orders)
      .where(and(eq(orders.accountId, accountId), eq(orders.leadId, leadId)))).map((o) => o.quoteId));
    const q = sent.find((x) => !ordered.has(x.id));
    if (q) {
      const [v] = await db.select({ createdAt: quoteVersions.createdAt }).from(quoteVersions)
        .where(and(eq(quoteVersions.accountId, accountId), eq(quoteVersions.quoteId, q.id), eq(quoteVersions.version, q.version)));
      if (v) return { kind: "quote", quoteId: q.id, number: q.number, version: q.version, ref: quoteRef(q.number, q.version), at: v.createdAt };
    }
  }
  return { kind: "other" };
}

/** The continuation for a lead with an earlier conversation, or null (the lead gets the normal intro). */
export async function leadContinuation(db: Db, accountId: string, leadId: string, now = new Date()): Promise<{ state: ContinuationState; date: string } | null> {
  if (!(await hasEarlierConversation(db, accountId, leadId))) return null;
  const state = await continuationState(db, accountId, leadId, now);
  if (state.kind !== "quote") return { state, date: "" };
  const [row] = await db.select({ lead: leads, account: sellerAccounts }).from(leads)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, leads.accountId))
    .where(and(eq(leads.id, leadId), eq(leads.accountId, accountId)));
  const zone = row ? (await leadContactSettings(db, row.account, row.lead.marketId)).timezone : "UTC";
  return { state, date: formatDayMonthIn(state.at, zone, row?.lead.language) };
}

/**
 * Posts the card the continuation line promises, right under it (`at`): the
 * quote card as the app posts one (an app_message "quote" row, so every web
 * chat renders the designed card), or the order form's link, which every chat
 * shows as the form card (and, once signed, opens at the payment step).
 * Returns the message id and, for a form, its link.
 */
export async function postContinuationCard(
  db: Db, accountId: string, conversationId: string, state: ContinuationState, language: string, at: Date,
): Promise<{ messageId: string; formUrl: string | null } | null> {
  if (state.kind === "other") return null;
  const id = randomUUID();
  if (state.kind === "quote") {
    const [[version], [row]] = await Promise.all([
      db.select().from(quoteVersions).where(and(eq(quoteVersions.accountId, accountId), eq(quoteVersions.quoteId, state.quoteId), eq(quoteVersions.version, state.version))),
      db.select({ lead: leads, account: sellerAccounts }).from(conversations)
        .innerJoin(leads, eq(leads.id, conversations.leadId)).innerJoin(sellerAccounts, eq(sellerAccounts.id, conversations.accountId))
        .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId))),
    ]);
    if (!version || !row) return null;
    const zone = (await leadContactSettings(db, row.account, row.lead.marketId)).timezone;
    const body = await quoteMessageBody(db, accountId, state.number, version, zone, language);
    await atomic(db, (q) => [
      q.insert(messages).values({ id, accountId, conversationId, actor: "agent", body, language, deliveryStatus: "delivered", createdAt: at }),
      q.insert(toolCalls).values({
        accountId, conversationId, messageId: id, sequence: 0, name: APP_MESSAGE_CALL, input: {},
        result: { message_id: id, kind: "quote", quote: `Q-${state.number} v${state.version}`, quote_id: state.quoteId, quote_version: state.version, continued: true },
        outcome: "ok", createdAt: at,
      }),
    ]);
    return { messageId: id, formUrl: null };
  }
  const url = linkFor({ id: state.formId }).url;
  await db.insert(messages).values({ id, accountId, conversationId, actor: "agent", body: url, language, deliveryStatus: "delivered", createdAt: at });
  return { messageId: id, formUrl: url };
}

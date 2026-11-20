/**
 * The approval panel under a held quote in the seller's thread (board
 * QuoteSeller). Only existing quote services: approveQuote ("Approve and
 * send") and createQuoteVersion at the account's discount limit ("Send N%
 * instead", offered only when the discount is the only reason). The card
 * itself is replaced in place, since it reads the quote's current version.
 * Account admins only, checked here (server-side).
 *
 * After an approval the buyer gets the next step without a model turn
 * (followUpApprovedQuote): the app writes a fixed close in the buyer's
 * language ("If this looks right, I'll send the order form now…"); after
 * "Send N% instead" it first says the team can offer N% and sends the new
 * card. These are app messages (lib/agent/app-message.ts), stored in the
 * conversation so the agent sees them in its history. An approval as is also
 * tells the buyer the team approved it, in the close (O1 part 5).
 *
 * "Decline" (O1 part 5, declineHeldQuote): the held quote is withdrawn (status
 * cancelled, a "quote.declined" event), the buyer gets an app message ("We
 * couldn't approve that price…", with the best in-limit offer when the
 * discount was the only reason), and the agent reads the decline in its turn
 * context ("Price approval", lib/agent/price-approval.ts) to continue the price ladder.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, leadEvents, leads, messages, quotes, quoteVersions, sellerAccounts, toolCalls, type ApprovalReason } from "@/db/schema";
import { writeAudit } from "@/lib/accounts/audit";
import { approvalReasonText } from "@/lib/catalog/pricing";
import type { AccountAccess } from "@/lib/accounts/service";
import { marketTimezone } from "@/lib/markets/settings";
import { conversationWindow, deliverText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { defaultTransport, type TwilioTransport } from "@/lib/channels/twilio";
import { isLocale, t } from "@/lib/i18n";
import { resolveMarket } from "@/lib/markets/service";
import { SIMULATOR_CHANNEL } from "@/lib/simulator/rules";
import { APP_MESSAGE_CALL, type AppMessageKind } from "./app-message";
import { deliveryByPhrase, percentText } from "./quote-message";
import { loadQuoteCards } from "./quote-card-data";
import { quoteMessageBody } from "./tools";
import { approveQuote, createQuoteVersion, getQuote, markQuoteSent, type QuoteResult } from "@/lib/quotes/service";
import { customPricesOf, requestLinesOf } from "@/lib/quotes/pricing";

type Access = Pick<AccountAccess, "account" | "user" | "actingAs" | "role">;
type Refused = { ok: false; reason: "forbidden" | "quote_not_found" | "quote_closed" | "not_discount_only" };
type Conv = typeof conversations.$inferSelect;

/** Every member of a seller account is its admin today; a platform admin acting as one may approve too. */
export const mayApproveQuotes = (a: Pick<Access, "role">) => a.role === "seller_admin" || a.role === "platform_admin";

export async function approveHeldQuote(db: Db, a: Access, quoteId: string, transport?: TwilioTransport | null): Promise<QuoteResult | Refused> {
  if (!mayApproveQuotes(a)) return { ok: false, reason: "forbidden" };
  const r = await approveQuote(db, a.account.id, { userId: a.user.id, actingAs: a.actingAs }, quoteId, {});
  if (r.ok) await safeFollowUp(db, a.account.id, quoteId, {}, transport);
  return r;
}

export async function sendHeldQuoteInLimit(db: Db, a: Access, quoteId: string, transport?: TwilioTransport | null): Promise<QuoteResult | Refused> {
  if (!mayApproveQuotes(a)) return { ok: false, reason: "forbidden" };
  const q = await getQuote(db, a.account.id, quoteId);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (q.quote.status !== "awaiting_approval") return { ok: false, reason: "quote_closed" };
  const current = q.versions.find((v) => v.version.version === q.quote.currentVersion);
  if (!current) return { ok: false, reason: "quote_not_found" };
  const reasons = current.version.approvalReasons;
  const over = reasons.find((r) => r.kind === "discount_over_limit");
  if (!over || over.kind !== "discount_over_limit" || reasons.some((r) => r.kind !== "discount_over_limit")) return { ok: false, reason: "not_discount_only" };
  const r = await createQuoteVersion(
    db, a.account.id, { kind: "human", userId: a.user.id, actingAs: a.actingAs }, quoteId,
    { lines: requestLinesOf(current.lines), discountBp: over.limitBp, changeNote: `Sent with a ${percentText(over.limitBp)} discount, the limit` },
    new Date(), customPricesOf(current.lines),
  );
  if (r.ok) await safeFollowUp(db, a.account.id, quoteId, { offerBp: over.limitBp }, transport);
  return r;
}

// ---------------------------------------------------------------------------
// The next step after an approval (no model turn)
// ---------------------------------------------------------------------------

export type ApprovalFollowUp =
  | { sent: true; channel: string; messages: { id: string; kind: AppMessageKind; body: string }[] }
  | { sent: false; reason: "no_conversation" | "closed" | "opted_out" | "window_closed" | "quote_not_found" };

/** The Quotes and orders screen approved a quote: the same follow-up as the thread's "Approve and send". */
export const followUpAfterApproval = (db: Db, accountId: string, quoteId: string, transport?: TwilioTransport | null) => safeFollowUp(db, accountId, quoteId, {}, transport);

/** The approval itself already succeeded: a failed follow-up is logged, never undoes it. */
async function safeFollowUp(db: Db, accountId: string, quoteId: string, opts: { offerBp?: number }, transport?: TwilioTransport | null) {
  try {
    return await followUpApprovedQuote(db, accountId, quoteId, opts, transport === undefined ? defaultTransport() : transport);
  } catch (e) {
    console.error("quote approval follow-up failed", e);
    return null;
  }
}

/**
 * Writes the next step into the conversation where the agent made the held
 * quote (its create_quote call):
 * - web chats with the placeholder card, approved as is: the close only, starting "The team approved
 *   your quote." (the card is replaced in place);
 * - "Send N% instead" (`offerBp`): "The team can offer N%…", the new card, then the close;
 * - WhatsApp (no placeholder there): the quote as text, then the close, through the
 *   existing send path and its rules; nothing is written when the 24-hour window is closed.
 * Also used when a quote is approved on the Quotes and orders screen.
 */
export async function followUpApprovedQuote(
  db: Db, accountId: string, quoteId: string, opts: { offerBp?: number } = {}, transport: TwilioTransport | null = null, now = new Date(),
): Promise<ApprovalFollowUp> {
  const found = await heldQuoteConversation(db, accountId, quoteId, now);
  if (!found.ok) return { sent: false, reason: found.reason };
  const { conv, call } = found;

  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, quoteId), eq(quotes.accountId, accountId)));
  const [version] = quote
    ? await db.select().from(quoteVersions).where(and(eq(quoteVersions.accountId, accountId), eq(quoteVersions.quoteId, quote.id), eq(quoteVersions.version, quote.currentVersion)))
    : [];
  if (!quote || !version) return { sent: false, reason: "quote_not_found" };

  const language = isLocale(conv.language) ? conv.language : "en";
  const result = call.result ?? {};
  const placeholderId = result.quote_held === true && typeof result.quote_message_id === "string" ? result.quote_message_id : null;
  const out: { id: string; kind: AppMessageKind; body: string }[] = [];
  let at = now.getTime();
  // Each app message one millisecond after the last, so they always show in this order.
  const write = (q: Db, kind: AppMessageKind, body: string, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const createdAt = new Date(at++);
    out.push({ id, kind, body });
    return [
      q.insert(messages).values({ id, accountId, conversationId: conv.id, actor: "agent", body, language, createdAt }),
      q.insert(toolCalls).values({
        accountId, conversationId: conv.id, messageId: id, sequence: 0, name: APP_MESSAGE_CALL, input: {},
        result: { message_id: id, kind, ...extra }, outcome: "ok", createdAt,
      }),
    ];
  };

  // The quote goes out as a new card when the version changed (Send N% instead) or there is no placeholder (WhatsApp).
  let cardId = placeholderId;
  if (opts.offerBp !== undefined || !placeholderId) {
    const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
    const body = await quoteMessageBody(db, accountId, quote.number, version, account ? marketTimezone(account, await resolveMarket(db, accountId, quote.marketId)) : "UTC", language);
    const offer = opts.offerBp !== undefined ? t("buyer.app.offer", { n: percentText(opts.offerBp) }, language) : null;
    await atomic(db, (q) => [
      ...(offer ? write(q, "quote_offer", offer) : []),
      ...write(q, "quote", body, {
        quote: `Q-${quote.number} v${version.version}`, quote_id: quote.id, quote_version: version.version,
        ...(typeof result.headline === "string" ? { headline: result.headline } : {}),
      }),
    ]);
    cardId = out.at(-1)!.id;
  }
  // The close says the card's delivery date, as the agent's close does.
  const card = (await loadQuoteCards(db, accountId, [conv.id], { audience: "buyer", now }))[cardId!];
  const date = card?.state === "sent" ? card.deliveryDate : null;
  const closeOnly = date
    ? t("buyer.app.close_by", { by: deliveryByPhrase(date, language) }, language)
    : t("buyer.app.close", undefined, language);
  // Approved as is (O1 part 5): the close first says the team approved it ("Send N% instead" already says what the team offers).
  const close = opts.offerBp === undefined ? `${t("buyer.app.approved", undefined, language)} ${closeOnly}` : closeOnly;
  await atomic(db, (q) => [
    ...write(q, "quote_close", close),
    q.update(conversations).set({ updatedAt: new Date(at) }).where(and(eq(conversations.id, conv.id), eq(conversations.accountId, accountId))),
  ]);
  // The buyer has the approved quote now (the placeholder card shows it in place, or the new card / WhatsApp text): Draft → Sent.
  await markQuoteSent(db, accountId, quote.id);

  // Real channels: through the existing send path and its rules (text only on WhatsApp; the simulator marks them delivered).
  if (conv.channel === "whatsapp" || conv.channel === SIMULATOR_CHANNEL) {
    const statusCallback = statusCallbackUrl(publicBaseUrl());
    for (const m of out) await deliverText(db, transport, { accountId, conversationId: conv.id, messageId: m.id, body: m.body }, { statusCallback, now });
  }
  return { sent: true, channel: conv.channel, messages: out };
}

/**
 * The conversation where the agent made this quote (its create_quote call),
 * if the buyer can still be written to there: not opted out, not closed, and
 * on WhatsApp inside the 24-hour window.
 */
async function heldQuoteConversation(db: Db, accountId: string, quoteId: string, now: Date): Promise<
  { ok: true; conv: Conv; call: { conversationId: string; result: Record<string, unknown> | null } } | { ok: false; reason: "no_conversation" | "closed" | "opted_out" | "window_closed" }
> {
  const [call] = await db.select({ conversationId: toolCalls.conversationId, result: toolCalls.result }).from(toolCalls)
    .where(and(
      eq(toolCalls.accountId, accountId), eq(toolCalls.name, "create_quote"), eq(toolCalls.outcome, "ok"),
      sql`${toolCalls.result} ->> 'quote_id' = ${quoteId}`,
    ))
    .orderBy(desc(toolCalls.createdAt)).limit(1);
  if (!call) return { ok: false, reason: "no_conversation" };
  const [row] = await db.select({ conv: conversations, lead: leads }).from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(and(eq(conversations.id, call.conversationId), eq(conversations.accountId, accountId), eq(leads.accountId, accountId)));
  if (!row) return { ok: false, reason: "no_conversation" };
  const { conv, lead } = row;
  if (lead.status === "opted_out") return { ok: false, reason: "opted_out" };
  if (conv.status === "closed") return { ok: false, reason: "closed" };
  if (conv.channel === "whatsapp" && !(await conversationWindow(db, accountId, conv.id, now)).open) return { ok: false, reason: "window_closed" };

  return { ok: true, conv, call: { conversationId: call.conversationId, result: (call.result ?? null) as Record<string, unknown> | null } };
}

// ---------------------------------------------------------------------------
// Decline (O1 part 5): the buyer is told, the agent continues the price ladder
// ---------------------------------------------------------------------------

export type DeclineResult =
  | { ok: true; quoteId: string; followUp: ApprovalFollowUp }
  | Refused;

/** The best in-limit offer a decline can name: only when the discount over the limit was the only reason, and the limit is above 0. */
export function declineOfferBp(reasons: readonly ApprovalReason[]): number | null {
  const over = reasons.find((r) => r.kind === "discount_over_limit");
  if (!over || over.kind !== "discount_over_limit" || reasons.some((r) => r.kind !== "discount_over_limit")) return null;
  return over.limitBp > 0 ? over.limitBp : null;
}

/**
 * "Decline" on a held quote (the thread's approval panel or the Quotes and
 * orders screen). Account admins only. The quote is withdrawn (cancelled: no
 * order form can be sent for it, the buyer's placeholder card shows it
 * withdrawn), a "quote.declined" event keeps what was declined and what the
 * buyer was told, and the buyer gets an app message in their language in the
 * conversation where the agent made the quote. The agent reads the decline in
 * its next turn ("Price approval", priceApprovalContext). No model turn.
 */
export async function declineHeldQuote(db: Db, a: Access, quoteId: string, transport?: TwilioTransport | null, now = new Date()): Promise<DeclineResult> {
  if (!mayApproveQuotes(a)) return { ok: false, reason: "forbidden" };
  const accountId = a.account.id;
  const q = await getQuote(db, accountId, quoteId);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (q.quote.status !== "awaiting_approval") return { ok: false, reason: "quote_closed" };
  const current = q.versions.find((v) => v.version.version === q.quote.currentVersion);
  if (!current) return { ok: false, reason: "quote_not_found" };
  const reasons = current.version.approvalReasons;
  const offerBp = declineOfferBp(reasons);

  const found = await heldQuoteConversation(db, accountId, quoteId, now);
  const language = found.ok && isLocale(found.conv.language) ? found.conv.language : "en";
  const body = offerBp !== null
    ? t("buyer.app.declined_offer", { n: percentText(offerBp) }, language)
    : t("buyer.app.declined", undefined, language);
  const messageId = found.ok ? randomUUID() : null;
  await atomic(db, (tx) => [
    tx.update(quotes).set({ status: "cancelled" }).where(and(eq(quotes.id, quoteId), eq(quotes.accountId, accountId), eq(quotes.status, "awaiting_approval"))),
    tx.insert(leadEvents).values({
      accountId, leadId: q.quote.leadId, type: "quote.declined", actor: "human", actorUserId: a.user.id, createdAt: now,
      data: {
        quoteId, number: q.quote.number, version: current.version.version, discountBp: current.version.discountBp,
        reasons: reasons.map(approvalReasonText), offerBp, toldBuyer: found.ok ? body : null,
      },
    }),
    ...(found.ok && messageId ? [
      tx.insert(messages).values({ id: messageId, accountId, conversationId: found.conv.id, actor: "agent", body, language, createdAt: now }),
      tx.insert(toolCalls).values({
        accountId, conversationId: found.conv.id, messageId, sequence: 0, name: APP_MESSAGE_CALL, input: {},
        result: { message_id: messageId, kind: "quote_declined", quote_id: quoteId }, outcome: "ok", createdAt: now,
      }),
      tx.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, found.conv.id), eq(conversations.accountId, accountId))),
    ] : []),
  ]);
  await writeAudit(db, { userId: a.user.id, actingAs: a.actingAs }, { accountId, action: "quote.declined", targetType: "quote", targetId: quoteId, details: { version: current.version.version } });

  if (!found.ok || !messageId) return { ok: true, quoteId, followUp: { sent: false, reason: found.ok ? "no_conversation" : found.reason } };
  const conv = found.conv;
  if (conv.channel === "whatsapp" || conv.channel === SIMULATOR_CHANNEL) {
    try {
      await deliverText(db, transport === undefined ? defaultTransport() : transport, { accountId, conversationId: conv.id, messageId, body }, { statusCallback: statusCallbackUrl(publicBaseUrl()), now });
    } catch (e) {
      // The decline itself succeeded: a failed delivery is logged, never undoes it.
      console.error("quote decline message failed", e);
    }
  }
  return { ok: true, quoteId, followUp: { sent: true, channel: conv.channel, messages: [{ id: messageId, kind: "quote_declined", body }] } };
}

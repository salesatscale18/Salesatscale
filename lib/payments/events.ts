/**
 * Payment provider events (P5.5). The only code that marks a card payment as
 * paid. An event counts only when its signature verifies, it has not been seen
 * before, and amount, currency, account and order all match the attempt.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { conversations, leadEvents, leads, messages, orders, paymentAttempts, providerEvents, sellerAccounts } from "@/db/schema";
import { serverSecret } from "@/lib/orders/token";
import { orderLabel } from "@/lib/orders/service";
import { formatMoney } from "@/lib/domain/money";

export type ProviderEvent = {
  id: string;
  type: "payment.succeeded" | "payment.failed";
  provider_ref: string;
  account_id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
  reason?: string;
  card_last4?: string;
};

export function signFake(raw: string) {
  return createHmac("sha256", serverSecret("FAKE_PAYMENT_SECRET")).update(raw).digest("hex");
}

function verifyFake(raw: string, signature: string) {
  const want = Buffer.from(signFake(raw), "hex");
  const got = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  return got.length === want.length && timingSafeEqual(got, want);
}

export type EventResult = "paid" | "failed" | "duplicate" | `rejected: ${string}`;

export async function handleProviderEvent(db: Db, provider: "fake", raw: string, signature: string, now = new Date()): Promise<EventResult> {
  let event: ProviderEvent | null = null;
  try { event = JSON.parse(raw) as ProviderEvent; } catch { event = null; }
  const record = async (result: EventResult, dedupeKey = `rejected:${randomUUID()}`, valid = false) => {
    await db.insert(providerEvents).values({ provider, dedupeKey, signatureValid: valid, raw: (event ?? { raw: raw.slice(0, 2000) }) as Record<string, unknown>, result, accountId: null, receivedAt: now });
    return result;
  };
  if (!verifyFake(raw, signature)) return record("rejected: bad signature");
  if (!event || typeof event.id !== "string" || typeof event.provider_ref !== "string") return record("rejected: malformed", undefined, true);

  // Claim the event id first: a second delivery of the same event is a no-op.
  const claimed = await db.insert(providerEvents)
    .values({ provider, dedupeKey: event.id, signatureValid: true, raw: event as unknown as Record<string, unknown>, result: "received", receivedAt: now })
    .onConflictDoNothing().returning({ id: providerEvents.id });
  if (!claimed.length) return "duplicate";
  const finish = async (result: EventResult, accountId: string | null = null) => {
    await db.update(providerEvents).set({ result, accountId }).where(eq(providerEvents.id, claimed[0].id));
    return result;
  };

  const [attempt] = await db.select().from(paymentAttempts).where(and(eq(paymentAttempts.provider, provider), eq(paymentAttempts.providerRef, event.provider_ref)));
  if (!attempt) return finish("rejected: unknown payment");
  const [order] = await db.select().from(orders).where(eq(orders.id, attempt.orderId));
  if (event.account_id !== attempt.accountId || event.order_id !== order.id) return finish("rejected: account or order mismatch", attempt.accountId);
  if (event.currency !== attempt.currency || event.currency !== order.currency) return finish("rejected: currency mismatch", attempt.accountId);
  if (event.amount_minor !== attempt.amountMinor || event.amount_minor !== order.amountDueMinor) return finish("rejected: amount mismatch", attempt.accountId);
  if (attempt.status !== "pending") return finish("rejected: attempt already settled", attempt.accountId);
  if (order.paymentStatus === "paid") return finish("rejected: order already paid", attempt.accountId);

  if (event.type === "payment.failed") {
    const reason = (event.reason ?? "declined").slice(0, 200);
    await atomic(db, (tx) => [
      tx.update(paymentAttempts).set({ status: "failed", failureReason: reason }).where(eq(paymentAttempts.id, attempt.id)),
      tx.update(orders).set({ paymentStatus: "failed" }).where(eq(orders.id, order.id)),
      tx.insert(leadEvents).values({ accountId: order.accountId, leadId: order.leadId, type: "payment.failed", actor: "system", data: { orderId: order.id, number: order.number, reason } }),
    ]);
    return finish("failed", order.accountId);
  }
  if (event.type !== "payment.succeeded") return finish("rejected: unknown event type", order.accountId);

  await atomic(db, (tx) => [
    tx.update(paymentAttempts).set({ status: "succeeded" }).where(eq(paymentAttempts.id, attempt.id)),
    tx.update(orders).set({ paymentStatus: "paid", paidAt: now }).where(and(eq(orders.id, order.id))),
    tx.update(leads).set({ status: "won", lastActivityAt: now }).where(eq(leads.id, order.leadId)),
    tx.insert(leadEvents).values({ accountId: order.accountId, leadId: order.leadId, type: "order.paid", actor: "system", data: { orderId: order.id, number: order.number, method: "card", last4: event.card_last4 ?? null } }),
  ]);
  await confirm(db, order.accountId, order.leadId, order.number, order.amountDueMinor, order.currency, now);
  return finish("paid", order.accountId);
}

/**
 * P5.8 confirmations. Buyer: a message in the lead's latest conversation (the
 * test lab today, WhatsApp in P6). Seller: an email stub until D8 picks a provider.
 */
async function confirm(db: Db, accountId: string, leadId: string, number: number, amountMinor: number, currency: string, now: Date) {
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  const label = orderLabel(account.tradeName, number);
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.leadId, leadId))).orderBy(desc(conversations.updatedAt)).limit(1);
  if (conv) {
    const body = conv.language === "he"
      ? `התשלום התקבל. הזמנה ${label} אושרה. תודה!`
      : `Payment received. Order ${label} is confirmed. Thank you!`;
    await db.insert(messages).values({ accountId, conversationId: conv.id, actor: "system", body, language: conv.language, createdAt: now });
  }
  console.info(`[email stub] To the seller of ${account.tradeName}: order ${label} paid, ${formatMoney(amountMinor, currency)}.`);
}

/** Test provider: what the provider would send after the buyer pays. Paid is still set only by handleProviderEvent. */
export async function simulateFakePayment(db: Db, providerRef: string, outcome: "succeeded" | "failed", now = new Date()) {
  const [attempt] = await db.select().from(paymentAttempts).where(and(eq(paymentAttempts.provider, "fake"), eq(paymentAttempts.providerRef, providerRef)));
  if (!attempt) return "rejected: unknown payment" as EventResult;
  const event: ProviderEvent = {
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    type: outcome === "succeeded" ? "payment.succeeded" : "payment.failed",
    provider_ref: providerRef, account_id: attempt.accountId, order_id: attempt.orderId,
    amount_minor: attempt.amountMinor, currency: attempt.currency,
    ...(outcome === "failed" ? { reason: "Insufficient credit limit (test)" } : { card_last4: "4242" }),
  };
  const raw = JSON.stringify(event);
  return handleProviderEvent(db, "fake", raw, signFake(raw), now);
}

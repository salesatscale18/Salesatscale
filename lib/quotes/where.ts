/**
 * "Where it is" on the Quotes list (Quotes and orders V2, Q-1): one state per
 * quote instead of the Status and Order form columns, plus the facts its
 * muted detail line is built from. Read from the quote, its latest order form
 * and its latest order; nothing is stored. Account-scoped.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { orderForms, orders, type QuoteStatus } from "@/db/schema";

/**
 * The states, in chip order. The last three are not on the board (no chip):
 * a quote that never went out, one replaced by a newer quote, and one the
 * seller cancelled or declined. They still show their own pill under All.
 */
export const QUOTE_WHERE = ["awaiting_approval", "quote_sent", "form_sent", "ordered", "expired", "draft", "replaced", "cancelled"] as const;
export type QuoteWhere = (typeof QUOTE_WHERE)[number];
/** The filter chips after All. */
export const QUOTE_WHERE_CHIPS = ["awaiting_approval", "quote_sent", "form_sent", "ordered", "expired"] as const satisfies readonly QuoteWhere[];
export type QuoteWhereChip = (typeof QUOTE_WHERE_CHIPS)[number];

export type LatestForm = { status: "sent" | "opened" | "signed" | "link_expired"; createdAt: Date; openedAt: Date | null; expiresAt: Date };
export type LatestOrder = { id: string; number: number; paymentStatus: (typeof orders.$inferSelect)["paymentStatus"] };

/** The form's status as shown: an unsigned form past its end date is "link_expired". */
export function shownFormStatus(f: LatestForm, now = new Date()): LatestForm["status"] {
  return f.status !== "signed" && f.expiresAt.getTime() <= now.getTime() ? "link_expired" : f.status;
}

/**
 * Where a quote is. An order (signed) wins over everything, as the old
 * "Ordered" status did; then a held quote, a replaced or cancelled one, an
 * expired one (past its valid-until), one with an order form out, and last a
 * quote sent in the chat. A draft is a quote the buyer never had. Pure.
 */
export function quoteWhere(
  q: { status: QuoteStatus; validUntil: Date },
  form: LatestForm | null | undefined,
  order: LatestOrder | null | undefined,
  now = new Date(),
): QuoteWhere {
  if (order) return "ordered";
  if (q.status === "awaiting_approval" || q.status === "replaced" || q.status === "cancelled") return q.status;
  if (q.validUntil.getTime() <= now.getTime()) return "expired";
  if (form) return "form_sent";
  return q.status === "draft" ? "draft" : "quote_sent";
}

/** Valid until in amber: a quote still open whose validity ends within 2 days. Pure. */
export function endsSoon(where: QuoteWhere, validUntil: Date, now = new Date()): boolean {
  if (where !== "awaiting_approval" && where !== "quote_sent" && where !== "form_sent" && where !== "draft") return false;
  const left = validUntil.getTime() - now.getTime();
  return left > 0 && left <= 2 * 86_400_000;
}

/** The orders-tab chips: waiting for payment (anything not paid or refunded) and paid. Pure. */
export const ORDER_PAY_CHIPS = ["waiting", "paid"] as const;
export type OrderPayChip = (typeof ORDER_PAY_CHIPS)[number];
export function orderPayChip(paymentStatus: LatestOrder["paymentStatus"]): OrderPayChip | null {
  if (paymentStatus === "paid") return "paid";
  if (paymentStatus === "refunded") return null;
  return "waiting";
}

/** The latest order form and the latest order of each quote, in two queries. Scoped by account. */
export async function quoteDocs(db: Db, accountId: string, quoteIds: string[]) {
  const forms = new Map<string, LatestForm>();
  const ords = new Map<string, LatestOrder>();
  if (!quoteIds.length) return { forms, orders: ords };
  const [f, o] = await Promise.all([
    db.select({ quoteId: orderForms.quoteId, status: orderForms.status, createdAt: orderForms.createdAt, openedAt: orderForms.openedAt, expiresAt: orderForms.expiresAt })
      .from(orderForms).where(and(eq(orderForms.accountId, accountId), inArray(orderForms.quoteId, quoteIds))).orderBy(desc(orderForms.createdAt)),
    db.select({ quoteId: orders.quoteId, id: orders.id, number: orders.number, paymentStatus: orders.paymentStatus })
      .from(orders).where(and(eq(orders.accountId, accountId), inArray(orders.quoteId, quoteIds))).orderBy(desc(orders.createdAt)),
  ]);
  for (const r of f) if (!forms.has(r.quoteId)) forms.set(r.quoteId, { status: r.status, createdAt: r.createdAt, openedAt: r.openedAt, expiresAt: r.expiresAt });
  for (const r of o) if (!ords.has(r.quoteId)) ords.set(r.quoteId, { id: r.id, number: r.number, paymentStatus: r.paymentStatus });
  return { forms, orders: ords };
}

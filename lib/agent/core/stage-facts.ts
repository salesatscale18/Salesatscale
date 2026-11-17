/**
 * The facts the stage derivation reads from the database (P11): the lead's
 * latest live quote, whether the order form was sent for it, and whether the
 * order is signed and paid. Three small reads, run in parallel.
 */
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { orderForms, orders, quoteVersions, quotes } from "@/db/schema";
import type { StageFacts } from "./stage";

export async function loadStageFacts(db: Db, accountId: string, leadId: string): Promise<StageFacts> {
  const [[quote], [form], [order]] = await Promise.all([
    db.select({ id: quotes.id, status: quotes.status, currentVersion: quotes.currentVersion }).from(quotes)
      .where(and(eq(quotes.accountId, accountId), eq(quotes.leadId, leadId), notInArray(quotes.status, ["cancelled", "replaced"])))
      .orderBy(desc(quotes.createdAt)).limit(1),
    db.select({ quoteId: orderForms.quoteId, status: orderForms.status, supersededById: orderForms.supersededById, version: quoteVersions.version })
      .from(orderForms).innerJoin(quoteVersions, eq(quoteVersions.id, orderForms.quoteVersionId))
      .where(and(eq(orderForms.accountId, accountId), eq(orderForms.leadId, leadId)))
      .orderBy(desc(orderForms.createdAt)).limit(1),
    db.select({ paymentStatus: orders.paymentStatus }).from(orders)
      .where(and(eq(orders.accountId, accountId), eq(orders.leadId, leadId)))
      .orderBy(desc(orders.createdAt)).limit(1),
  ]);
  const live = form && form.status !== "link_expired" && !form.supersededById;
  return {
    quote: !quote ? "none" : quote.status === "awaiting_approval" ? "awaiting_approval" : "ready",
    orderForm: !live ? "none" : quote && form.quoteId === quote.id && form.version === quote.currentVersion ? "sent" : "outdated",
    signed: !!order,
    paid: order?.paymentStatus === "paid",
  };
}

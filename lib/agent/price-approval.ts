/**
 * "Price approval" in the agent's turn context (O1 part 5): the team declined
 * a special price (lib/agent/quote-approval.ts declineHeldQuote, a
 * "quote.declined" lead event), so the agent continues the price ladder from
 * it. Read every chat turn (lib/agent/turn.ts). Scoped by account.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents } from "@/db/schema";
import { percentText } from "./quote-message";

/**
 * "Price approval" in the agent's turn context: the team's latest decline on
 * this lead, until the agent makes a new quote after it. Says what was
 * declined, what the buyer was told, and to continue the price ladder without
 * asking for the same approval again. Empty when there is none. Scoped by account.
 */
export async function priceApprovalContext(db: Db, accountId: string, leadId: string): Promise<string> {
  const [declined] = await db.select().from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), eq(leadEvents.type, "quote.declined")))
    .orderBy(desc(leadEvents.createdAt)).limit(1);
  if (!declined) return "";
  const [newer] = await db.select({ id: leadEvents.id }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, ["quote.created", "quote.versioned"]), gt(leadEvents.createdAt, declined.createdAt)))
    .limit(1);
  if (newer) return "";
  return priceApprovalText(declined.data ?? {});
}

/** The "Price approval" block from a "quote.declined" event's data (pure). */
export function priceApprovalText(d: Record<string, unknown>): string {
  const ref = typeof d.number === "number" ? `Q-${d.number}` : "the quote";
  const discount = typeof d.discountBp === "number" && d.discountBp > 0 ? ` with a ${percentText(d.discountBp)} discount` : "";
  const reasons = Array.isArray(d.reasons) ? d.reasons.filter((r): r is string => typeof r === "string") : [];
  const told = typeof d.toldBuyer === "string" ? d.toldBuyer : null;
  return [
    "## Price approval",
    `The team declined ${ref}${discount}${reasons.length ? ` (${reasons.join(" ")})` : ""}. That quote is withdrawn.`,
    told ? `The app told the buyer: "${told}"` : "The buyer has not been told yet: tell them in one short line that the team could not approve that price.",
    "Continue the price ladder from the next step not yet used: a smaller first step, a discount within your limit only as a trade (for deciding now, more units, or paying yearly), or a time to come back. Never ask the team to approve the same price again.",
  ].join("\n");
}

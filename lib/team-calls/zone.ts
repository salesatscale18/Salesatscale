/**
 * The buyer's own time zone (RB3, one zone on the buyer page): the browser's,
 * stored per buyer on the chat's "chat.opened" event (rememberBuyerZone, from
 * the buyer page) and on a booking (buyerTimezone, bookCall). storedBuyerZone
 * reads the latest. No schema change: lead event data.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents } from "@/db/schema";
import { CALLBACK_EVENTS } from "@/lib/callbacks/rules";
import { CHAT_OPENED_EVENT } from "@/lib/agent/thread-markers";
import { validTimezone } from "./slots";

/** The events that carry the buyer's browser zone (data.buyerTimezone). */
const ZONE_EVENTS = [CHAT_OPENED_EVENT, CALLBACK_EVENTS.requested, CALLBACK_EVENTS.changed] as const;

/** The buyer's own zone as last stored (chat opened, or a booking), or null when it was never stored. */
export async function storedBuyerZone(db: Db, accountId: string, leadId: string): Promise<string | null> {
  const [row] = await db.select({ zone: sql<string | null>`${leadEvents.data}->>'buyerTimezone'` }).from(leadEvents)
    .where(and(
      eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), inArray(leadEvents.type, [...ZONE_EVENTS]),
      sql`${leadEvents.data}->>'buyerTimezone' is not null`,
    ))
    .orderBy(desc(leadEvents.createdAt)).limit(1);
  return validTimezone(row?.zone);
}

/**
 * Stores the buyer's browser zone on the lead's latest "chat.opened" event (the
 * page records one when a real buyer opens the chat): no new event, nothing new
 * in the seller's thread. False when the zone is not valid, there is no open to
 * store it on, or it is stored already.
 */
export async function rememberBuyerZone(db: Db, accountId: string, leadId: string, zone: unknown): Promise<boolean> {
  const tz = validTimezone(zone);
  if (!tz) return false;
  const [open] = await db.select({ id: leadEvents.id, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), eq(leadEvents.leadId, leadId), eq(leadEvents.type, CHAT_OPENED_EVENT)))
    .orderBy(desc(leadEvents.createdAt)).limit(1);
  if (!open || open.data?.buyerTimezone === tz) return false;
  await db.update(leadEvents).set({ data: { ...(open.data ?? {}), buyerTimezone: tz } })
    .where(and(eq(leadEvents.id, open.id), eq(leadEvents.accountId, accountId)));
  return true;
}

/**
 * What the buyer page adds for reaching the buyer (board ReachChat): the
 * booking card's state and the "SMS sent · Sat 21:00" chips for the SMS that
 * led the buyer to the chat. Read on the page and on every poll (the messages
 * route), so a booking the team moves or cancels shows without a reload.
 * The talk-now and new-time cards come from lib/follow-ups/named-time.ts
 * (page load only: they follow the SMS the buyer opened). Real leads only.
 *
 * The buyer's own time zone (RB3, one zone on the buyer page): the browser's,
 * stored per buyer (lib/team-calls/zone.ts); the page uses the stored one, else
 * the market's zone, until the browser's is known.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents, type Lead, type SellerAccount } from "@/db/schema";
import { isSimulatedLead } from "@/lib/simulator/rules";
import { SMS_NUDGE_EVENTS } from "@/lib/sms/rules";
import { bookingView, type BookingView } from "@/lib/team-calls/service";

/** An SMS the buyer got (sent, or recorded in mock mode): placed before the chat message it points to, else by time. */
export type ChatSmsChip = { at: string; messageId: string | null };

export type ChatReach = { booking: BookingView | null; sms: ChatSmsChip[] };

export const NO_REACH: ChatReach = { booking: null, sms: [] };

export async function chatReach(db: Db, ctx: { lead: Lead; account: SellerAccount }, now = new Date()): Promise<ChatReach> {
  const [booking, rows] = await Promise.all([
    bookingView(db, ctx, now),
    isSimulatedLead(ctx.lead)
      ? Promise.resolve([])
      : db.select({ createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
        .where(and(eq(leadEvents.accountId, ctx.account.id), eq(leadEvents.leadId, ctx.lead.id), inArray(leadEvents.type, [...SMS_NUDGE_EVENTS]))),
  ]);
  const sms = rows
    .map((r) => ({ at: r.createdAt.toISOString(), messageId: typeof r.data?.messageId === "string" ? r.data.messageId : null }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { booking, sms };
}

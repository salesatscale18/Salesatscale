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
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents, type Lead, type SellerAccount } from "@/db/schema";
import { isSimulatedLead } from "@/lib/simulator/rules";
import { SMS_EVENTS } from "@/lib/sms/rules";
import { bookingView, type BookingView } from "@/lib/team-calls/service";

/**
 * An SMS the buyer really got (outcome `sent` only: never a mocked, test-mode, refused or failed one, which
 * reached no phone), placed before the chat message it points to, else by time. The lead page's page_link
 * SMS is left out: it goes while the buyer is already on the hand-over, which says so itself
 * ("We also sent this link to your phone.", only when sent). The seller's timeline keeps every true outcome.
 */
export type ChatSmsChip = { at: string; messageId: string | null };

export type ChatReach = { booking: BookingView | null; sms: ChatSmsChip[] };

export const NO_REACH: ChatReach = { booking: null, sms: [] };

/** SMS kinds never shown as a chip in the buyer chat. */
const BUYER_CHIP_SKIP: ReadonlySet<string> = new Set(["page_link"]);

export async function chatReach(db: Db, ctx: { lead: Lead; account: SellerAccount }, now = new Date()): Promise<ChatReach> {
  const [booking, rows] = await Promise.all([
    bookingView(db, ctx, now),
    isSimulatedLead(ctx.lead)
      ? Promise.resolve([])
      : db.select({ createdAt: leadEvents.createdAt, data: leadEvents.data }).from(leadEvents)
        .where(and(eq(leadEvents.accountId, ctx.account.id), eq(leadEvents.leadId, ctx.lead.id), eq(leadEvents.type, SMS_EVENTS.sent))),
  ]);
  const sms = rows
    .filter((r) => !BUYER_CHIP_SKIP.has(String(r.data?.kind ?? "")))
    .map((r) => ({ at: r.createdAt.toISOString(), messageId: typeof r.data?.messageId === "string" ? r.data.messageId : null }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { booking, sms };
}

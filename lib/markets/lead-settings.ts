/**
 * The run-time contact settings for one lead (time zone, contact hours,
 * selling languages): its market's own values, else the account's. Used by
 * every gate that acts for a specific lead (opener, simulator opener,
 * follow-ups, the agent's clock). Scoped by account.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { markets, type Market } from "@/db/schema";
import { marketContactSettings, sanitizeOverrides, type ContactSettings } from "./settings";

/**
 * Where "Fix hours" goes when an opener is refused outside contact hours: the
 * lead's market's own contact hours on the Markets page (its row form open)
 * when the market sets them, or its time zone when only that is its own;
 * else the account's hours in Settings. A lead with no market uses the account's.
 */
export function contactHoursFixHref(slug: string, market: Pick<Market, "id" | "overrides"> | null | undefined): string {
  const o = sanitizeOverrides(market?.overrides);
  const key = o.contactHours ? "contactHours" : o.timezone ? "timezone" : null;
  if (!market || !key) return `/app/${slug}/settings?section=hours`;
  return `/app/${slug}/markets?m=${market.id}&override=${key}#set-${key}`;
}

/** The lead's market, only when it belongs to the account; null for a lead with no market. */
export async function marketOfLead(db: Db, accountId: string, marketId: string | null | undefined): Promise<Market | null> {
  if (!marketId) return null;
  const [m] = await db.select().from(markets).where(and(eq(markets.id, marketId), eq(markets.accountId, accountId)));
  return m ?? null;
}

/** The effective contact settings for a lead in `marketId` (null: the account's own). */
export async function leadContactSettings(
  db: Db,
  account: { id: string } & Parameters<typeof marketContactSettings>[0],
  marketId: string | null | undefined,
): Promise<ContactSettings> {
  return marketContactSettings(account, await marketOfLead(db, account.id, marketId));
}

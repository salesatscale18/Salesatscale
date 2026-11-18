/**
 * The run-time contact settings for one lead (time zone, contact hours,
 * selling languages): its market's own values, else the account's. Used by
 * every gate that acts for a specific lead (opener, simulator opener,
 * follow-ups, the agent's clock). Scoped by account.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { markets, type Market } from "@/db/schema";
import { marketContactSettings, type ContactSettings } from "./settings";

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

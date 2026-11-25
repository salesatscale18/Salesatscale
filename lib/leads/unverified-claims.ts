/**
 * Seller-side reads for unverified returning leads (lib/leads/unverified.ts): the claimed
 * number and the lead with that number, for the lead card, the Leads list and the
 * Conversations list, and the phone search that finds both leads. Account-scoped.
 */
import { and, eq, ilike, inArray, notLike, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/types";
import { leadEvents, leads } from "@/db/schema";
import { UNVERIFIED_EVENTS, UNVERIFIED_PHONE_PREFIX } from "./unverified";

export type UnverifiedClaim = {
  /** The number the buyer typed (E.164), never verified. */
  claimedPhone: string;
  /** The lead that has this number (null when it was deleted since). */
  sameAs: { id: string; fullName: string } | null;
  pageName: string;
};

/** The claims of the given leads (only unverified returning leads have one), by lead id. */
export async function unverifiedClaims(db: Db, accountId: string, leadIds: readonly string[]): Promise<Map<string, UnverifiedClaim>> {
  const out = new Map<string, UnverifiedClaim>();
  if (leadIds.length === 0) return out;
  const rows = await db.select({ leadId: leadEvents.leadId, data: leadEvents.data }).from(leadEvents)
    .where(and(eq(leadEvents.accountId, accountId), inArray(leadEvents.leadId, [...leadIds]), eq(leadEvents.type, UNVERIFIED_EVENTS.claim)));
  if (rows.length === 0) return out;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const otherIds = [...new Set(rows.map((r) => str(r.data?.sameAsLeadId)).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  const others = otherIds.length
    ? await db.select({ id: leads.id, fullName: leads.fullName }).from(leads).where(and(eq(leads.accountId, accountId), inArray(leads.id, otherIds)))
    : [];
  const byId = new Map(others.map((o) => [o.id, o]));
  for (const r of rows) {
    if (out.has(r.leadId)) continue;
    out.set(r.leadId, { claimedPhone: str(r.data?.claimedPhone), sameAs: byId.get(str(r.data?.sameAsLeadId)) ?? null, pageName: str(r.data?.page) });
  }
  return out;
}

/** Names of the given leads in the account (the other lead an unverified-returning event names). */
export async function leadNames(db: Db, accountId: string, ids: readonly string[]): Promise<{ id: string; fullName: string }[]> {
  if (ids.length === 0) return [];
  return db.select({ id: leads.id, fullName: leads.fullName }).from(leads).where(and(eq(leads.accountId, accountId), inArray(leads.id, [...new Set(ids)])));
}

/**
 * The phone part of a search (3+ digits): a lead's own phone (never a placeholder's random
 * digits), or the number an unverified returning lead claimed, so both leads are found.
 */
export function phoneSearchSql(digits: string): SQL {
  const like = `%${digits}%`;
  return or(
    and(notLike(leads.phone, `${UNVERIFIED_PHONE_PREFIX}%`), ilike(leads.phone, like)),
    sql`(${leads.phone} like ${`${UNVERIFIED_PHONE_PREFIX}%`} and exists (select 1 from lead_events e where e.account_id = ${leads.accountId} and e.lead_id = ${leads.id} and e.type = ${UNVERIFIED_EVENTS.claim} and e.data->>'claimedPhone' like ${like}))`,
  )!;
}

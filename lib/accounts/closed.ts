/**
 * "Closed" companies: accounts a super admin took out of use. They stay in the
 * database (no hard delete) but default lists leave them out.
 *
 * Closed = the account is paused AND either
 *  - it was removed with "Delete demo account" (audit `demo.removed`), or
 *  - its latest pause (audit `account.paused`) was made by a platform admin
 *    acting as the account (Super Admin › "Pause account" writes acting_as = true).
 *
 * A paused account without such a record stays listed: its pause is not
 * known to be a super admin's. Resuming an account un-closes it (it is no
 * longer paused), so closing stays reversible.
 */
import { sql, type SQL } from "drizzle-orm";

/** Same strings as DEMO_REMOVED (lib/demo/seed.ts) and pauseAccount's audit action; tests keep them in step. */
export const CLOSED_DEMO_REMOVED = "demo.removed";
export const CLOSED_PAUSED_ACTION = "account.paused";

/**
 * SQL boolean: true when the `seller_accounts` row of the outer query is closed.
 * Identifiers are written fully qualified on purpose: Drizzle leaves the table
 * name off columns in a single-table select, and an unqualified "id" inside the
 * audit subquery would bind to audit_log.id.
 */
export function accountClosedSql(): SQL<boolean> {
  return sql<boolean>`("seller_accounts"."status" = 'paused' and (
    exists (select 1 from "audit_log" "ca" where "ca"."account_id" = "seller_accounts"."id" and "ca"."action" = ${CLOSED_DEMO_REMOVED})
    or coalesce((select "cp"."acting_as" from "audit_log" "cp"
      where "cp"."account_id" = "seller_accounts"."id" and "cp"."action" = ${CLOSED_PAUSED_ACTION}
      order by "cp"."created_at" desc limit 1), false)
  ))`;
}

/** SQL condition for default lists: the account is not closed. */
export function accountOpenSql(): SQL<boolean> {
  return sql<boolean>`not ${accountClosedSql()}`;
}

import { cache } from "react";
import { notFound } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Db } from "@/db/types";
import { auditLog } from "@/db/schema";
import { ensureUser } from "@/lib/ensure-user";
import { resolveAccountAccess, type AccountAccess } from "@/lib/accounts/service";
import type { Actor } from "@/lib/accounts/audit";

/** The app's database as the shared `Db` type used by data-access functions. */
export const appDb: Db = db;

/**
 * The only way a seller page, layout or action gets an account.
 * Signed-out → Clerk sign-in (proxy.ts already enforces it); no access → 404.
 * Cached per request so layout and page share one lookup.
 */
export const requireAccount = cache(async (slug: string): Promise<AccountAccess> => {
  const user = await ensureUser();
  if (!user) return (await auth()).redirectToSignIn();
  const access = await resolveAccountAccess(appDb, user, slug);
  if (!access) notFound();
  if (access.actingAs) await recordAccountEntry(appDb, access);
  return access;
});

/** A super admin's visits to one account are audited at most once per this window. */
export const ACCOUNT_ENTRY_AUDIT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Audits a super admin entering an account they are not a member of
 * ("acting as", security finding M1): one `account.entered` entry per user,
 * per account, per 30 minutes, however the account was reached (URL or the
 * Enter button). One round trip: the insert only happens when no identical
 * entry exists in the window; the NOT EXISTS probe uses the
 * audit_log(account_id, created_at) index. Returns whether an entry was written.
 */
export async function recordAccountEntry(
  db: Db, access: Pick<AccountAccess, "account" | "user" | "actingAs">, now = new Date(),
): Promise<boolean> {
  if (!access.actingAs) return false;
  const accountId = access.account.id;
  const userId = access.user.id;
  const since = new Date(now.getTime() - ACCOUNT_ENTRY_AUDIT_WINDOW_MS).toISOString();
  const at = now.toISOString();
  const res = await db.execute(sql`
    insert into ${auditLog} (account_id, actor_user_id, acting_as, action, target_type, target_id, created_at)
    select ${accountId}::uuid, ${userId}::uuid, true, 'account.entered', 'account', ${accountId}, ${at}::timestamptz
    where not exists (
      select 1 from ${auditLog}
      where account_id = ${accountId}::uuid
        and created_at > ${since}::timestamptz
        and action = 'account.entered'
        and actor_user_id = ${userId}::uuid
    )
    returning id`);
  const rows = (res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []);
  return rows.length > 0;
}

export function actorOf(access: Pick<AccountAccess, "user" | "actingAs">): Actor {
  return { userId: access.user.id, actingAs: access.actingAs };
}

/** Super admin only; 404 for everyone else (CLAUDE.md: /sadmin stays super-admin only). */
export const requireSuperAdmin = cache(async () => {
  const me = await ensureUser();
  if (!me || me.role !== "super_admin") notFound();
  return me;
});

/** Verified email addresses of the signed-in Clerk user (for invite matching). */
export async function verifiedEmails(): Promise<string[]> {
  const clerkUser = await currentUser();
  if (!clerkUser) return [];
  return clerkUser.emailAddresses
    .filter((e) => e.verification?.status === "verified")
    .map((e) => e.emailAddress.toLowerCase());
}

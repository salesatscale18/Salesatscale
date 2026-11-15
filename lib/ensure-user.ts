import { cache } from "react";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";

function superAdminEmails(): Set<string> {
  return new Set(
    (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Profile fields (name, picture, email) are re-read from Clerk at most this often. */
export const PROFILE_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the stored row can be used as-is for this request, without asking
 * Clerk. The super-admin rule is re-checked on EVERY request against the
 * current SUPER_ADMIN_EMAILS:
 * - a super_admin whose stored email is no longer listed would be demoted, and
 * - a non-super_admin whose stored email is listed might be promoted (we don't
 *   store whether that email is verified, so only Clerk can decide).
 * Either case forces a full refresh from Clerk now, so a removal from the list
 * takes effect on the very next request. Otherwise the row is used until it
 * is PROFILE_REFRESH_MS old.
 */
export function rowIsCurrent(row: User, now: Date, admins = superAdminEmails()): boolean {
  const listed = !!row.email && admins.has(row.email.toLowerCase());
  if (row.role === "super_admin" && !listed) return false;
  if (row.role !== "super_admin" && listed) return false;
  return now.getTime() - row.updatedAt.getTime() < PROFILE_REFRESH_MS;
}

/**
 * Syncs the signed-in Clerk user into the `users` table and returns the DB row.
 * Returns null when nobody is signed in. Cached per request.
 *
 * Server-only. Call it at the top of every protected page.
 *
 * Cost: `auth()` verifies the session token locally, then one SELECT by
 * clerk_id. Clerk's `currentUser()` (an HTTP call) and the upsert run only
 * when the row is missing, older than PROFILE_REFRESH_MS, or its role would
 * change under the current SUPER_ADMIN_EMAILS (see `rowIsCurrent`).
 *
 * Role rules (applied by the upsert, with fresh data from Clerk):
 * - A user whose *verified* primary email is listed in SUPER_ADMIN_EMAILS
 *   becomes super_admin.
 * - A super_admin whose email is no longer listed is demoted to user, so the
 *   env var stays the single source of truth for super admins.
 * - Any other role (user / admin) is left untouched.
 */
export const ensureUser = cache(async (): Promise<User | null> => {
  const { userId } = await auth();
  if (!userId) return null;

  const [existing] = await db.select().from(users).where(eq(users.clerkId, userId));
  if (existing && rowIsCurrent(existing, new Date())) return existing;

  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const primary = clerkUser.primaryEmailAddress;
  const email = primary?.emailAddress?.toLowerCase() ?? null;
  const isVerified = primary?.verification?.status === "verified";
  const isSuperAdmin = !!email && isVerified && superAdminEmails().has(email);

  const profile = {
    email,
    firstName: clerkUser.firstName,
    lastName: clerkUser.lastName,
    imageUrl: clerkUser.imageUrl,
  };

  const [row] = await db
    .insert(users)
    .values({
      clerkId: clerkUser.id,
      ...profile,
      role: isSuperAdmin ? "super_admin" : "user",
    })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: {
        ...profile,
        role: isSuperAdmin
          ? sql`'super_admin'::user_role`
          : sql`CASE WHEN ${users.role} = 'super_admin' THEN 'user'::user_role ELSE ${users.role} END`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
});

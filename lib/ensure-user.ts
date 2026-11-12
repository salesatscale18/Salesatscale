import { currentUser } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";
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

/**
 * Syncs the signed-in Clerk user into the `users` table (upsert by clerk_id)
 * and returns the DB row. Returns null when nobody is signed in.
 *
 * Server-only. Call it at the top of every protected page.
 *
 * Role rules:
 * - A user whose *verified* primary email is listed in SUPER_ADMIN_EMAILS
 *   becomes super_admin.
 * - A super_admin whose email is no longer listed is demoted to user, so the
 *   env var stays the single source of truth for super admins.
 * - Any other role (user / admin) is left untouched.
 */
export async function ensureUser(): Promise<User | null> {
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
}

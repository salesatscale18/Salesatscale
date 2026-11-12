import { cache } from "react";
import { notFound } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "@/db";
import type { Db } from "@/db/types";
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
  return access;
});

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

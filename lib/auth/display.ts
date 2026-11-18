import type { User } from "@/db/schema";

export function displayName(u: Pick<User, "firstName" | "lastName" | "email">): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "Unknown user";
}

export function initials(u: Pick<User, "firstName" | "lastName" | "email">): string {
  const parts = [u.firstName, u.lastName].filter((p): p is string => !!p);
  const letters = parts.length > 0 ? parts.map((p) => p[0]) : [(u.email ?? "?")[0]];
  return letters.join("").slice(0, 2).toUpperCase();
}

/** Initials from a free-text full name ("Shira Golan" → "SG"). */
export function nameInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
}

/**
 * A person as the seller's screens name them: "You" for the viewer, else the
 * name, else the part of the email before "@" and any "+tag"
 * ("testuser+clerk_test@…" → "testuser"). Never the full email.
 */
export function personName(u: Pick<User, "id" | "firstName" | "lastName" | "email">, viewerId?: string | null, you = "You"): string {
  if (viewerId && u.id === viewerId) return you;
  const name = [u.firstName, u.lastName].filter((p) => p?.trim()).join(" ");
  if (name) return name;
  const local = (u.email ?? "").split("@")[0].split("+")[0].trim();
  return local || "Unknown user";
}

/**
 * Platform admins (a super admin, or anyone acting as) see technical details
 * sellers do not, such as an agent version's model and effort. Decided on the
 * server from the account access object.
 */
export function seesPlatformDetails(access: { actingAs: boolean; role: string; user: Pick<User, "role"> }): boolean {
  return access.actingAs || access.role === "platform_admin" || access.user.role === "super_admin";
}

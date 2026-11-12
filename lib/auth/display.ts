import type { User } from "@/db/schema";

export function displayName(u: Pick<User, "firstName" | "lastName" | "email">): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "Unknown user";
}

export function initials(u: Pick<User, "firstName" | "lastName" | "email">): string {
  const parts = [u.firstName, u.lastName].filter((p): p is string => !!p);
  const letters = parts.length > 0 ? parts.map((p) => p[0]) : [(u.email ?? "?")[0]];
  return letters.join("").slice(0, 2).toUpperCase();
}

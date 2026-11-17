/**
 * Authorization of the platform cron route: `Authorization: Bearer <CRON_SECRET>`,
 * compared in constant time. Refused when CRON_SECRET is unset or too short.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  const s = secret?.trim();
  if (!s || s.length < 16) return false;
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  // Hashing first gives equal lengths, so timingSafeEqual never leaks the secret's length.
  return timingSafeEqual(digest(m[1]), digest(s));
}

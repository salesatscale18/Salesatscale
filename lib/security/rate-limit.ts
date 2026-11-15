/**
 * Fixed-window rate limiting in our own Postgres (no extra service).
 *
 * One atomic upsert per call counts the request in the current window:
 * INSERT … ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
 * RETURNING count. Windows older than a day are deleted now and then
 * (indexed on window_start), so windows may be at most one day long.
 */
import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { rateLimits } from "@/db/schema";

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterSeconds: number };

const DAY_SECONDS = 24 * 60 * 60;
/** Share of calls that also delete expired windows. */
const CLEANUP_CHANCE = 0.01;

export async function rateLimit(
  db: Db,
  key: string,
  opts: { limit: number; windowSeconds: number },
  now = new Date(),
  random: () => number = Math.random,
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = opts;
  if (!(windowSeconds > 0 && windowSeconds <= DAY_SECONDS)) throw new Error("windowSeconds must be between 1 and 86400");
  const windowMs = windowSeconds * 1000;
  const start = Math.floor(now.getTime() / windowMs) * windowMs;

  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: new Date(start), count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });

  if (random() < CLEANUP_CHANCE) {
    await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(now.getTime() - DAY_SECONDS * 1000)));
  }

  if (row.count <= limit) return { ok: true, remaining: limit - row.count, retryAfterSeconds: 0 };
  return { ok: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now.getTime()) / 1000)) };
}

/** First address in x-forwarded-for (set by Vercel), or "unknown". */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Keys must not hold secrets such as buyer link tokens: store a hash instead. */
export function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 32);
}

/** Content-Length says the body is bigger than `max` bytes. A missing header passes; the read is still capped. */
export function declaredTooLarge(headers: Headers, max: number): boolean {
  const n = Number(headers.get("content-length"));
  return Number.isFinite(n) && n > max;
}

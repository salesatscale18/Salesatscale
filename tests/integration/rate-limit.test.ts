import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { rateLimits } from "@/db/schema";
import { rateLimit } from "@/lib/security/rate-limit";
import { createTestDb, type TestDb } from "../helpers/db";

describe("rateLimit", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
  });
  afterAll(async () => t.close());

  const opts = { limit: 3, windowSeconds: 60 };
  const at = (iso: string) => new Date(iso);

  it("counts calls in one window and refuses over the limit with Retry-After", async () => {
    const r1 = await rateLimit(db, "k1", opts, at("2026-11-15T10:00:05Z"));
    const r2 = await rateLimit(db, "k1", opts, at("2026-11-15T10:00:10Z"));
    const r3 = await rateLimit(db, "k1", opts, at("2026-11-15T10:00:20Z"));
    expect([r1, r2, r3].map((r) => [r.ok, r.remaining])).toEqual([[true, 2], [true, 1], [true, 0]]);
    const r4 = await rateLimit(db, "k1", opts, at("2026-11-15T10:00:45Z"));
    expect(r4).toEqual({ ok: false, remaining: 0, retryAfterSeconds: 15 });
    const rows = await db.select().from(rateLimits).where(eq(rateLimits.key, "k1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(4);
  });

  it("resets in the next window", async () => {
    const r = await rateLimit(db, "k1", opts, at("2026-11-15T10:01:00Z"));
    expect(r).toEqual({ ok: true, remaining: 2, retryAfterSeconds: 0 });
  });

  it("keeps keys independent", async () => {
    for (let i = 0; i < 3; i++) await rateLimit(db, "k2", opts, at("2026-11-15T10:00:30Z"));
    expect((await rateLimit(db, "k2", opts, at("2026-11-15T10:00:31Z"))).ok).toBe(false);
    expect((await rateLimit(db, "k3", opts, at("2026-11-15T10:00:31Z"))).ok).toBe(true);
  });

  it("counts every call under concurrency (atomic upsert)", async () => {
    const now = at("2026-11-15T11:00:00Z");
    const results = await Promise.all(Array.from({ length: 10 }, () => rateLimit(db, "k4", { limit: 5, windowSeconds: 60 }, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, "k4"));
    expect(row.count).toBe(10);
  });

  it("deletes windows older than a day when cleanup runs", async () => {
    await rateLimit(db, "old", opts, at("2026-11-10T10:00:00Z"));
    await rateLimit(db, "fresh", opts, at("2026-11-15T12:00:00Z"), () => 0);
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, "old"))).toHaveLength(0);
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, "fresh"))).toHaveLength(1);
  });

  it("refuses windows longer than a day", async () => {
    await expect(rateLimit(db, "x", { limit: 1, windowSeconds: 2 * 86400 })).rejects.toThrow();
  });
});

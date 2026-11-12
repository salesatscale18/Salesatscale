import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { createTestDb } from "../helpers/db";

describe("migrations", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("creates the users table with defaults", async () => {
    const [row] = await t.db.insert(users).values({ clerkId: "user_1", email: "a@example.com" }).returning();
    expect(row.role).toBe("user");
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("enforces a unique clerk_id", async () => {
    await expect(t.db.insert(users).values({ clerkId: "user_1" })).rejects.toThrow();
    const rows = await t.db.select().from(users).where(eq(users.clerkId, "user_1"));
    expect(rows).toHaveLength(1);
  });
});

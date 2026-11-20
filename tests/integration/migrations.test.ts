import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { sellerAccounts, users } from "@/db/schema";
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

describe("migration 0018/0019: buyer calls on by default", () => {
  it("new accounts default to on, and 0019 turns it on for the accounts that existed before", async () => {
    // The migrations up to 0018 only (a copy of ./drizzle with the journal cut there), then an account saved with it off.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.cpSync("drizzle", dir, { recursive: true });
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0019_voice_buyer_calls_on");
    fs.writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 18) }));
    const client = new PGlite();
    const db = drizzle({ client, schema });
    try {
      await migrate(db, { migrationsFolder: dir });
      const base = { tradeName: "T", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCapMinor: 10_000 };
      const [before] = await db.insert(sellerAccounts).values({ ...base, slug: "before-0019", voiceBuyerCalls: false }).returning();
      expect(before.voiceBuyerCalls).toBe(false);
      // The full set: 0019 runs once and sets it on for that account.
      await migrate(db, { migrationsFolder: "drizzle" });
      const [after] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, before.id));
      expect(after.voiceBuyerCalls).toBe(true);
      // The column's default (0018): a new account is on without saying so; it can still be turned off.
      const [fresh] = await db.insert(sellerAccounts).values({ ...base, slug: "after-0019" }).returning();
      expect(fresh.voiceBuyerCalls).toBe(true);
      const [off] = await db.update(sellerAccounts).set({ voiceBuyerCalls: false }).where(eq(sellerAccounts.id, fresh.id)).returning();
      expect(off.voiceBuyerCalls).toBe(false);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

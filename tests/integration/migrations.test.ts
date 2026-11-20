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

describe("migration 0018: buyer calls as an opt-out", () => {
  it("accounts saved before 0018 (even with the old switch off) and new accounts have buyer calls on; it can be turned off", async () => {
    // The migrations up to 0017 only (a copy of ./drizzle with the journal cut there), then accounts saved in that shape.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.cpSync("drizzle", dir, { recursive: true });
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0018_voice_buyer_calls_off");
    fs.writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 17) }));
    const client = new PGlite();
    const db = drizzle({ client, schema });
    try {
      await migrate(db, { migrationsFolder: dir });
      // Raw inserts in the test database: the current schema has a column that 0017 does not.
      const insert = async (slug: string, buyerCalls: boolean) =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO seller_accounts (slug, trade_name, market, languages, timezone, currency, plan, monthly_spend_cap_minor, voice_buyer_calls)
             VALUES ($1, 'T', 'IL', '{en}', 'Asia/Jerusalem', 'ILS', 'pilot', 10000, $2) RETURNING id`,
            [slug, buyerCalls],
          )
        ).rows[0].id;
      const existing = [await insert("old-off", false), await insert("old-on", true)];
      // The full set: 0018 drops the old column and adds the opt-out (default false = buyer calls on).
      await migrate(db, { migrationsFolder: "drizzle" });
      for (const id of existing) {
        const [row] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
        expect(row.voiceBuyerCallsOff).toBe(false);
      }
      const cols = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'seller_accounts' AND column_name LIKE 'voice_buyer%'",
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(["voice_buyer_calls_off"]);
      const base = { tradeName: "T", market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCapMinor: 10_000 };
      const [fresh] = await db.insert(sellerAccounts).values({ ...base, slug: "after-0018" }).returning();
      expect(fresh.voiceBuyerCallsOff).toBe(false);
      const [off] = await db.update(sellerAccounts).set({ voiceBuyerCallsOff: true }).where(eq(sellerAccounts.id, fresh.id)).returning();
      expect(off.voiceBuyerCallsOff).toBe(true);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

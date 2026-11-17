/**
 * Demo seed, P11 follow-up (decisions 1 and 2): Maya / מאיה (female), the
 * Hebrew trade name with the demo's timestamp suffix, and "How they check
 * fridges today" as a pitch question. The Hebrew opener as a buyer gets it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentVersions, leads, messages, sellerAccounts, users, type User } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

const h = vi.hoisted(() => ({ db: null as unknown, anthropic: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: h.anthropic }));
vi.mock("@/lib/auth/account", () => ({ get appDb() { return h.db; } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { createDemoAccount, demoNameHe } = await import("@/lib/demo/seed");
const { startSimulatorConversation } = await import("@/lib/simulator/service");

describe("demo seed: names in the buyer's language", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    h.db = db;
    [admin] = await db.insert(users).values({ clerkId: "c_sa", email: "sa@platform.test", role: "super_admin" }).returning();
  }, 60_000);
  afterAll(async () => { await t.close(); });

  it("keeps the timestamp suffix in the Hebrew name; a custom name gets none", () => {
    expect(demoNameHe("Polar Demo 2026-11-17 10:00:00")).toBe("פולאר דמו 2026-11-17 10:00:00");
    expect(demoNameHe("Polar Demo")).toBe("פולאר דמו");
    expect(demoNameHe("Acme")).toBeNull();
  });

  it("seeds Maya / מאיה, female, the Hebrew trade name, and the pitch question as optional; the Hebrew opener follows", async () => {
    const r = await createDemoAccount(db, admin, { ownerEmail: "owner@platform.test", now: new Date("2026-11-17T10:00:00Z") });
    if (!r.ok) throw new Error("refused");
    const id = r.summary.accountId;
    const [acc] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
    expect(acc.tradeName).toBe("Polar Demo 2026-11-17 10:00:00");
    expect(acc.tradeNameLocal).toEqual({ he: "פולאר דמו 2026-11-17 10:00:00" });

    const [live] = await db.select().from(agentVersions).where(and(eq(agentVersions.accountId, id), eq(agentVersions.status, "live")));
    expect(live.playbook).toMatchObject({ agentName: "Maya", agentNameLocal: { he: "מאיה" }, agentGender: "female" });
    const role = Object.fromEntries(live.playbook.fields.map((f) => [f.key, f.stage]));
    expect(role).toMatchObject({ sites: "before_quote", current_monitoring: "optional", company_name: "before_order_form" });

    const actor = { userId: admin.id, actingAs: true };
    const opener = async (fullName: string) => {
      const [lead] = await db.select().from(leads).where(and(eq(leads.accountId, id), eq(leads.fullName, fullName)));
      const s = await startSimulatorConversation(db, actor, id, lead.id);
      if (!s.ok) throw new Error(s.reason);
      return (await db.select().from(messages).where(eq(messages.id, s.messageId)))[0].body;
    };
    expect(await opener("יוסי לוי")).toBe("היי יוסי, כאן מאיה, העוזרת האוטומטית של פולאר דמו 2026-11-17 10:00:00. פנית אלינו בנושא ניטור הטמפרטורות במקררים שלך. איך אתם בודקים אותן היום?");
    expect(await opener("Rina Cohen")).toBe("Hi Rina, this is Maya, the automated assistant of Polar Demo 2026-11-17 10:00:00. You asked about monitoring your fridge temperatures. How do you check them today?");
  });
});

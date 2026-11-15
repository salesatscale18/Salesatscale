import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { leads, users } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createAccount } from "@/lib/accounts/service";
import { parseLead } from "@/lib/leads/rules";
import { upsertLead } from "@/lib/leads/service";
import { createTestDb } from "../helpers/db";

// Server actions read the app database and the caller's access from lib/auth/account.
const holder = vi.hoisted(() => ({ db: null as unknown, access: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return holder.db; },
  requireAccount: async () => holder.access,
  actorOf: (a: { user: { id: string }; actingAs: boolean }) => ({ userId: a.user.id, actingAs: a.actingAs }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

const { optOutLeadAction, verifyFieldAction } = await import("@/app/app/[account]/leads/actions");

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};

describe("lead actions refuse ids that are not UUIDs", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let leadId = "";

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
    const [admin] = await t.db.insert(users).values({ clerkId: "a", email: "a@p.test", role: "super_admin" }).returning();
    const p = parseCreateAccount({ tradeName: "Alpha", market: "IL", languages: ["he"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "o@x.test" });
    if (!p.ok) throw new Error("bad");
    const { account } = await createAccount(t.db, { userId: admin.id, actingAs: false }, p.value);
    holder.access = { account, user: admin, actingAs: true, role: "platform_admin" };
    const l = parseLead({ fullName: "Shira", phone: "0525550193", consent: "yes", consentSource: "Expo" }, "IL", { language: "he", now: new Date() });
    if (!l.ok) throw new Error("bad lead");
    const r = await upsertLead(t.db, account.id, { userId: admin.id, actingAs: true }, l.value, "manual");
    if (!r.ok) throw new Error(r.reason);
    leadId = r.lead.id;
  });
  afterAll(async () => t.close());

  it("opt-out with a bad id does nothing instead of failing the query", async () => {
    await expect(optOutLeadAction(form({ slug: "alpha", leadId: "1 or 1=1" }))).resolves.toBeUndefined();
    await expect(optOutLeadAction(form({ slug: "alpha", leadId: "" }))).resolves.toBeUndefined();
    const [row] = await t.db.select().from(leads).where(eq(leads.id, leadId));
    expect(row.status).toBe("new");
    await optOutLeadAction(form({ slug: "alpha", leadId }));
    expect((await t.db.select().from(leads).where(eq(leads.id, leadId)))[0].status).toBe("opted_out");
  });

  it("verify field with a bad lead id goes back to the leads list", async () => {
    await expect(verifyFieldAction(form({ slug: "alpha", leadId: "nope", key: "budget", value: "10" }))).rejects.toMatchObject({ url: "/app/alpha/leads" });
  });
});

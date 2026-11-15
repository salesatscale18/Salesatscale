import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { accountMembers, auditLog, sellerAccounts, users } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

// ensureUser talks to Clerk and the app database: mock Clerk, point "@/db" at PGlite.
const h = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  clerkUser: null as unknown,
  currentUserCalls: 0,
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: h.userId, redirectToSignIn: () => { throw new Error("redirect"); } }),
  currentUser: async () => { h.currentUserCalls++; return h.clerkUser; },
}));
vi.mock("@/db", () => ({ get db() { return h.db; } }));

const { ensureUser, PROFILE_REFRESH_MS } = await import("@/lib/ensure-user");
const { recordAccountEntry, ACCOUNT_ENTRY_AUDIT_WINDOW_MS } = await import("@/lib/auth/account");
const { resolveAccountAccess, createAccount } = await import("@/lib/accounts/service");
const { parseCreateAccount } = await import("@/lib/accounts/rules");

function clerk(id: string, email: string, verified = true, firstName = "Dana") {
  return {
    id, firstName, lastName: "Levi", imageUrl: "https://img.test/a.png",
    primaryEmailAddress: { emailAddress: email, verification: { status: verified ? "verified" : "unverified" } },
  };
}

describe("ensureUser", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  const env = process.env.SUPER_ADMIN_EMAILS;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    h.db = db;
  });
  afterAll(async () => {
    process.env.SUPER_ADMIN_EMAILS = env;
    await t.close();
  });
  beforeEach(() => {
    h.currentUserCalls = 0;
    process.env.SUPER_ADMIN_EMAILS = "boss@p.test";
  });

  it("returns null when nobody is signed in, without calling Clerk's API", async () => {
    h.userId = null;
    expect(await ensureUser()).toBeNull();
    expect(h.currentUserCalls).toBe(0);
  });

  it("creates the users row when it is missing", async () => {
    h.userId = "user_new";
    h.clerkUser = clerk("user_new", "New@X.test");
    const row = await ensureUser();
    expect(row).toMatchObject({ clerkId: "user_new", email: "new@x.test", firstName: "Dana", role: "user" });
    expect(h.currentUserCalls).toBe(1);
    expect(await db.select().from(users).where(eq(users.clerkId, "user_new"))).toHaveLength(1);
  });

  it("uses the stored row without calling Clerk while it is fresh", async () => {
    h.userId = "user_new";
    h.clerkUser = clerk("user_new", "new@x.test", true, "Changed");
    const row = await ensureUser();
    expect(row?.firstName).toBe("Dana");
    expect(h.currentUserCalls).toBe(0);
  });

  it("refreshes the profile from Clerk once the row is older than 24 h", async () => {
    await db.update(users).set({ updatedAt: new Date(Date.now() - PROFILE_REFRESH_MS - 1000) }).where(eq(users.clerkId, "user_new"));
    h.userId = "user_new";
    h.clerkUser = clerk("user_new", "new@x.test", true, "Changed");
    const row = await ensureUser();
    expect(row?.firstName).toBe("Changed");
    expect(h.currentUserCalls).toBe(1);
    expect(Date.now() - row!.updatedAt.getTime()).toBeLessThan(60_000);
  });

  it("promotes a verified listed email, but not an unverified one", async () => {
    h.userId = "user_boss";
    h.clerkUser = clerk("user_boss", "boss@p.test", false);
    expect((await ensureUser())?.role).toBe("user");
    h.clerkUser = clerk("user_boss", "boss@p.test", true);
    // The row is fresh, but its stored email is listed and its role is not super_admin: Clerk decides now.
    expect((await ensureUser())?.role).toBe("super_admin");
    expect(h.currentUserCalls).toBe(2);
    // From now on a fresh super_admin row is used as-is.
    expect((await ensureUser())?.role).toBe("super_admin");
    expect(h.currentUserCalls).toBe(2);
  });

  it("demotes a super admin on the very next request after the email leaves SUPER_ADMIN_EMAILS", async () => {
    h.userId = "user_boss";
    h.clerkUser = clerk("user_boss", "boss@p.test", true);
    const before = await ensureUser();
    expect(before?.role).toBe("super_admin");
    expect(Date.now() - before!.updatedAt.getTime()).toBeLessThan(PROFILE_REFRESH_MS); // fresh row
    process.env.SUPER_ADMIN_EMAILS = "someone-else@p.test";
    const after = await ensureUser();
    expect(after?.role).toBe("user");
    const [stored] = await db.select().from(users).where(eq(users.clerkId, "user_boss"));
    expect(stored.role).toBe("user");
  });

  it("demotes even when the list is emptied entirely", async () => {
    await db.update(users).set({ role: "super_admin" }).where(eq(users.clerkId, "user_boss"));
    process.env.SUPER_ADMIN_EMAILS = "";
    h.userId = "user_boss";
    h.clerkUser = clerk("user_boss", "boss@p.test", true);
    expect((await ensureUser())?.role).toBe("user");
  });

  it("leaves other roles untouched", async () => {
    await db.update(users).set({ role: "admin", updatedAt: new Date(0) }).where(eq(users.clerkId, "user_new"));
    h.userId = "user_new";
    h.clerkUser = clerk("user_new", "new@x.test");
    expect((await ensureUser())?.role).toBe("admin");
  });
});

describe("account access", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: typeof users.$inferSelect, member: typeof users.$inferSelect, outsider: typeof users.$inferSelect;
  let alpha: typeof sellerAccounts.$inferSelect, beta: typeof sellerAccounts.$inferSelect;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin, member, outsider] = await db.insert(users).values([
      { clerkId: "a", email: "a@p.test", role: "super_admin" },
      { clerkId: "m", email: "m@p.test" },
      { clerkId: "o", email: "o@p.test" },
    ]).returning();
    const made = [];
    for (const name of ["Alpha", "Beta"]) {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: `${name}@x.test` });
      if (!p.ok) throw new Error("bad input");
      made.push((await createAccount(db, { userId: admin.id, actingAs: false }, p.value)).account);
    }
    [alpha, beta] = made;
    await db.insert(accountMembers).values({ accountId: alpha.id, userId: member.id, role: "seller_admin", isOwner: true });
  });
  afterAll(async () => t.close());

  it("resolveAccountAccess: members get their own account only, outsiders nothing, super admins act as", async () => {
    expect(await resolveAccountAccess(db, member, "alpha")).toMatchObject({ account: { id: alpha.id }, actingAs: false, role: "seller_admin" });
    expect(await resolveAccountAccess(db, member, "beta")).toBeNull();
    expect(await resolveAccountAccess(db, outsider, "alpha")).toBeNull();
    expect(await resolveAccountAccess(db, member, "nope")).toBeNull();
    expect(await resolveAccountAccess(db, admin, "beta")).toMatchObject({ account: { id: beta.id }, actingAs: true, role: "platform_admin" });
    // The full account row comes back, not a partial one.
    const access = await resolveAccountAccess(db, member, "alpha");
    expect(access?.account).toEqual(alpha);
  });

  it("uniqueSlug only needs the base slug and its numbered variants", async () => {
    for (const name of ["Alpha", "Alpha", "Alphabet"]) {
      const p = parseCreateAccount({ tradeName: name, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS", plan: "pilot", monthlySpendCap: "100", ownerName: "O", ownerEmail: "x@x.test" });
      if (!p.ok) throw new Error("bad input");
      await createAccount(db, { userId: admin.id, actingAs: false }, p.value);
    }
    const slugs = (await db.select({ slug: sellerAccounts.slug }).from(sellerAccounts)).map((r) => r.slug).sort();
    expect(slugs).toEqual(["alpha", "alpha-2", "alpha-3", "alphabet", "beta"]);
  });

  it("acting-as entry is audited once per user, per account, per 30 minutes", async () => {
    const entries = (accountId: string, userId: string) =>
      db.select().from(auditLog).where(and(eq(auditLog.accountId, accountId), eq(auditLog.actorUserId, userId), eq(auditLog.action, "account.entered")));
    const t0 = new Date();
    const acting = { account: beta, user: admin, actingAs: true };
    expect(await recordAccountEntry(db, acting, t0)).toBe(true);
    expect(await recordAccountEntry(db, acting, new Date(t0.getTime() + 60_000))).toBe(false);
    expect(await recordAccountEntry(db, acting, new Date(t0.getTime() + ACCOUNT_ENTRY_AUDIT_WINDOW_MS - 1000))).toBe(false);
    expect(await entries(beta.id, admin.id)).toHaveLength(1);
    const [row] = await entries(beta.id, admin.id);
    expect(row).toMatchObject({ actingAs: true, targetType: "account", targetId: beta.id });
    // Another account is separate; members (not acting as) are never audited here.
    expect(await recordAccountEntry(db, { account: alpha, user: admin, actingAs: true }, t0)).toBe(true);
    expect(await recordAccountEntry(db, { account: alpha, user: member, actingAs: false }, t0)).toBe(false);
    expect(await entries(alpha.id, member.id)).toHaveLength(0);
    // After the window a new entry is written.
    expect(await recordAccountEntry(db, acting, new Date(t0.getTime() + ACCOUNT_ENTRY_AUDIT_WINDOW_MS + 1000))).toBe(true);
    expect(await entries(beta.id, admin.id)).toHaveLength(2);
  });
});

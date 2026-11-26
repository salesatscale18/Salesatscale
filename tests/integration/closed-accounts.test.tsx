/**
 * Closed companies (owner, 2026-11-26): accounts removed with "Delete demo account"
 * or paused by a super admin ("Pause account") are left out of every default list
 * (Super Admin › Accounts and its counts, the Activity account filter and counts,
 * the /app account picker), come back with "Show closed (n)", and come back for
 * good when resumed. A paused account whose pause is not a super admin's stays listed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { eq } from "drizzle-orm";
import { accountMembers, sellerAccounts, users, type User } from "@/db/schema";
import { parseCreateAccount } from "@/lib/accounts/rules";
import { createTestDb, type TestDb } from "../helpers/db";

const h = vi.hoisted(() => ({ db: null as unknown, me: null as unknown }));
vi.mock("@/lib/auth/account", () => ({
  get appDb() { return h.db; },
  requireSuperAdmin: async () => {
    const me = h.me as User | null;
    if (!me || me.role !== "super_admin") throw new Error("NEXT_NOT_FOUND");
    return me;
  },
}));
vi.mock("@/lib/ensure-user", () => ({ ensureUser: async () => h.me }));
vi.mock("@clerk/nextjs", () => ({ SignOutButton: ({ children }: { children: ReactElement }) => children }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ redirectToSignIn: () => { throw new Error("SIGN_IN"); } }) }));
vi.mock("@/components/sas/root", () => ({ SasRoot: ({ children }: { children: ReactElement }) => children }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  usePathname: () => "/sadmin",
  useRouter: () => ({ refresh: () => {} }),
}));

const { createAccount, countClosedAccounts, listAccounts, listUserAccounts, pauseAccount, resolveAccountAccess, resumeAccount } = await import("@/lib/accounts/service");
const { CLOSED_DEMO_REMOVED, CLOSED_PAUSED_ACTION } = await import("@/lib/accounts/closed");
const { DEMO_CREATED, DEMO_REMOVED, removeDemoAccount } = await import("@/lib/demo/seed");
const { writeAudit } = await import("@/lib/accounts/audit");
const { default: AccountsPage } = await import("@/app/sadmin/accounts/page");
const { default: SuperAdminPage } = await import("@/app/sadmin/page");
const { default: AppEntryPage } = await import("@/app/app/page");

function input(tradeName: string, ownerEmail: string) {
  const r = parseCreateAccount({
    tradeName, market: "IL", languages: ["en"], timezone: "Asia/Jerusalem", currency: "ILS",
    plan: "pilot", monthlySpendCap: "1500", ownerName: "Owner", ownerEmail,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) });
const html = async (el: Promise<ReactElement> | ReactElement) => renderToStaticMarkup(await el);
const redirectOf = async (p: Promise<unknown>) => p.then(() => null, (e: { url?: string }) => e.url ?? null);

describe("closed accounts are hidden from default lists", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let admin: User, seller: User, other: User;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    h.db = db;
    [admin, seller, other] = await db.insert(users).values([
      { clerkId: "c_admin", email: "admin@platform.test", role: "super_admin" },
      { clerkId: "c_seller", email: "seller@acme.test" },
      { clerkId: "c_other", email: "other@else.test" },
    ]).returning();
    const asAdmin = { userId: admin.id, actingAs: false };
    for (const name of ["Alpha Open", "Bravo Removed Demo", "Charlie Admin Paused", "Delta Other Pause", "Echo Live"]) {
      ids[name] = (await createAccount(db, asAdmin, input(name, `${name.split(" ")[0].toLowerCase()}@x.test`))).account.id;
    }
    // The seller is a member of all of them; "other" only of Echo Live.
    await db.insert(accountMembers).values([
      ...Object.values(ids).map((accountId) => ({ accountId, userId: seller.id, role: "seller_admin" as const })),
      { accountId: ids["Echo Live"], userId: other.id, role: "seller_admin" as const },
    ]);
    // "Delete demo account" (the seed's audit marker makes it a demo account).
    await writeAudit(db, { userId: admin.id, actingAs: true }, { accountId: ids["Bravo Removed Demo"], action: DEMO_CREATED });
    expect(await removeDemoAccount(db, admin, ids["Bravo Removed Demo"])).toEqual({ ok: true });
    // Super Admin › "Pause account" (pauseAccountAction pauses acting as).
    expect(await pauseAccount(db, { userId: admin.id, actingAs: true }, ids["Charlie Admin Paused"])).not.toBeNull();
    // A pause that is not a super admin's (not acting as): ambiguous, stays listed.
    expect(await pauseAccount(db, { userId: seller.id, actingAs: false }, ids["Delta Other Pause"])).not.toBeNull();
  });
  afterAll(async () => t.close());

  it("keeps the audit action strings in step with the writers", () => {
    expect(CLOSED_DEMO_REMOVED).toBe(DEMO_REMOVED);
    expect(CLOSED_PAUSED_ACTION).toBe("account.paused");
  });

  it("listAccounts leaves closed accounts out by default and includes them with the filter", async () => {
    expect((await listAccounts(db)).map((a) => a.tradeName)).toEqual(["Alpha Open", "Delta Other Pause", "Echo Live"]);
    const all = await listAccounts(db, { includeClosed: true });
    expect(all.map((a) => [a.tradeName, a.closed])).toEqual([
      ["Alpha Open", false], ["Bravo Removed Demo", true], ["Charlie Admin Paused", true], ["Delta Other Pause", false], ["Echo Live", false],
    ]);
    expect(await countClosedAccounts(db)).toBe(2);
  });

  it("the account picker (listUserAccounts) leaves closed accounts out; isolation unchanged", async () => {
    expect((await listUserAccounts(db, seller.id)).map((r) => r.account.tradeName)).toEqual(["Alpha Open", "Delta Other Pause", "Echo Live"]);
    expect((await listUserAccounts(db, seller.id, { includeClosed: true })).length).toBe(5);
    expect((await listUserAccounts(db, other.id)).map((r) => r.account.tradeName)).toEqual(["Echo Live"]);
    expect((await listUserAccounts(db, other.id, { includeClosed: true })).map((r) => r.account.tradeName)).toEqual(["Echo Live"]);
    expect(await listUserAccounts(db, admin.id)).toEqual([]);
  });

  it("direct access to a closed account is unchanged (still resolves, status paused)", async () => {
    const [bravo] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, ids["Bravo Removed Demo"]));
    const access = await resolveAccountAccess(db, seller, bravo.slug);
    expect(access?.account.status).toBe("paused");
    expect(await resolveAccountAccess(db, other, bravo.slug)).toBeNull();
    expect((await resolveAccountAccess(db, admin, bravo.slug))?.actingAs).toBe(true);
  });

  it("Super Admin › Accounts hides closed by default, with a Show closed (n) filter that lists them with their badges", async () => {
    h.me = admin;
    const def = await html(AccountsPage(sp()));
    expect(def).toContain("Alpha Open");
    expect(def).toContain("Delta Other Pause");
    expect(def).not.toContain("Bravo Removed Demo");
    expect(def).not.toContain("Charlie Admin Paused");
    expect(def).toContain("Show closed (2)");
    expect(def).toContain('href="/sadmin/accounts?closed=1"');

    const shown = await html(AccountsPage(sp({ closed: "1" })));
    expect(shown).toContain("Bravo Removed Demo");
    expect(shown).toContain("Charlie Admin Paused");
    expect(shown).toContain("Removed demo");
    expect(shown).toContain("Hide closed");
    expect(shown).toContain(`href="/sadmin/accounts/${ids["Charlie Admin Paused"]}"`);
  });

  it("Super Admin › Activity: the account filter and counts leave closed accounts out (a selected one stays)", async () => {
    h.me = admin;
    const def = await html(SuperAdminPage(sp()));
    expect(def).toContain("Alpha Open");
    expect(def).not.toContain(`value="${ids["Charlie Admin Paused"]}"`);
    expect(def).not.toContain(`value="${ids["Bravo Removed Demo"]}"`);
    const picked = await html(SuperAdminPage(sp({ account: ids["Charlie Admin Paused"] })));
    expect(picked).toContain(`value="${ids["Charlie Admin Paused"]}"`);
  });

  it("super-admin-only pages keep their role check", async () => {
    h.me = seller;
    await expect(AccountsPage(sp({ closed: "1" }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(SuperAdminPage(sp())).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the /app picker never shows closed accounts", async () => {
    h.me = seller;
    const out = await html(AppEntryPage());
    expect(out).toContain("Alpha Open");
    expect(out).toContain("Delta Other Pause");
    expect(out).not.toContain("Bravo Removed Demo");
    expect(out).not.toContain("Charlie Admin Paused");
    h.me = admin;
    const adminOut = await html(AppEntryPage());
    expect(adminOut).toContain("All accounts (platform admin)");
    expect(adminOut).not.toContain("Charlie Admin Paused");
  });

  it("a seller whose only accounts are closed still goes straight in (today's paused page)", async () => {
    const [lone] = await db.insert(users).values({ clerkId: "c_lone", email: "lone@x.test" }).returning();
    await db.insert(accountMembers).values({ accountId: ids["Charlie Admin Paused"], userId: lone.id, role: "seller_admin" });
    h.me = lone;
    const [charlie] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, ids["Charlie Admin Paused"]));
    expect(await redirectOf(AppEntryPage())).toBe(`/app/${charlie.slug}`);
  });

  it("resuming makes a closed account visible again (reversible)", async () => {
    expect(await resumeAccount(db, { userId: admin.id, actingAs: true }, ids["Charlie Admin Paused"])).not.toBeNull();
    expect((await listAccounts(db)).map((a) => a.tradeName)).toContain("Charlie Admin Paused");
    expect(await countClosedAccounts(db)).toBe(1);
    // Paused again by a super admin: closed again (the latest pause counts).
    await pauseAccount(db, { userId: admin.id, actingAs: true }, ids["Charlie Admin Paused"]);
    expect(await countClosedAccounts(db)).toBe(2);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountInvites, auditLog, users, type User } from "@/db/schema";
import { parseCreateAccount, type CreateAccountInput } from "@/lib/accounts/rules";
import {
  acceptInvite, createAccount, createInvite, listAccountAudit, listMembers, listUserAccounts, pauseAccount,
  resolveAccountAccess, resumeAccount,
} from "@/lib/accounts/service";
import { createTestDb, type TestDb } from "../helpers/db";

function input(tradeName: string, ownerEmail: string): CreateAccountInput {
  const r = parseCreateAccount({
    tradeName, market: "IL", languages: ["en", "he"], timezone: "Asia/Jerusalem", currency: "ILS",
    plan: "pilot", monthlySpendCap: "1500", ownerName: "Owner", ownerEmail,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

describe("accounts, invites and access", () => {
  let t: Awaited<ReturnType<typeof import("../helpers/db").createTestDb>>;
  let db: TestDb;
  let admin: User, alice: User, bob: User, mallory: User;
  const now = new Date("2026-11-12T10:00:00Z");

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    [admin, alice, bob, mallory] = await db
      .insert(users)
      .values([
        { clerkId: "c_admin", email: "admin@platform.test", role: "super_admin" },
        { clerkId: "c_alice", email: "alice@polar.test" },
        { clerkId: "c_bob", email: "bob@fresh.test" },
        { clerkId: "c_mallory", email: "mallory@evil.test" },
      ])
      .returning();
  });
  afterAll(async () => t.close());

  let polarToken = "";
  let polarId = "";

  it("creates an account in Setting up with an owner invite and audit entries", async () => {
    const res = await createAccount(db, { userId: admin.id, actingAs: false }, input("Polar Monitoring", "alice@polar.test"), now);
    polarToken = res.inviteToken;
    polarId = res.account.id;
    expect(res.account.slug).toBe("polar-monitoring");
    expect(res.account.status).toBe("setting_up");
    const [invite] = await db.select().from(accountInvites).where(eq(accountInvites.accountId, polarId));
    expect(invite.isOwner).toBe(true);
    expect(invite.tokenHash).not.toBe(polarToken);
    const audit = await listAccountAudit(db, polarId);
    expect(audit.map((a) => a.entry.action).sort()).toEqual(["account.created", "invite.created"]);
  });

  it("gives a second account with the same name a unique slug", async () => {
    const res = await createAccount(db, { userId: admin.id, actingAs: false }, input("Polar Monitoring", "x@y.test"), now);
    expect(res.account.slug).toBe("polar-monitoring-2");
  });

  it("refuses an invite when the verified email does not match", async () => {
    expect(await acceptInvite(db, mallory, ["mallory@evil.test"], polarToken, now)).toEqual({ ok: false, reason: "email_mismatch" });
    expect(await acceptInvite(db, mallory, [], polarToken, now)).toEqual({ ok: false, reason: "email_mismatch" });
  });

  it("refuses unknown and expired tokens", async () => {
    expect(await acceptInvite(db, alice, ["alice@polar.test"], "nope", now)).toEqual({ ok: false, reason: "not_found" });
    const later = new Date(now.getTime() + 8 * 24 * 3600 * 1000);
    expect(await acceptInvite(db, alice, ["alice@polar.test"], polarToken, later)).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts for the invited user, makes them owner, and is idempotent for them", async () => {
    const r = await acceptInvite(db, alice, ["Alice@Polar.test"], polarToken, now);
    expect(r.ok).toBe(true);
    const members = await listMembers(db, polarId);
    expect(members.map((m) => [m.user.email, m.member.isOwner])).toEqual([["alice@polar.test", true]]);
    expect((await acceptInvite(db, alice, ["alice@polar.test"], polarToken, now)).ok).toBe(true);
    expect(await acceptInvite(db, bob, ["alice@polar.test"], polarToken, now)).toEqual({ ok: false, reason: "accepted" });
  });

  it("isolates accounts: members see theirs, outsiders get nothing, super admin acts as", async () => {
    const fresh = await createAccount(db, { userId: admin.id, actingAs: false }, input("FreshTrack", "bob@fresh.test"), now);
    expect((await acceptInvite(db, bob, ["bob@fresh.test"], fresh.inviteToken, now)).ok).toBe(true);

    const aliceOwn = await resolveAccountAccess(db, alice, "polar-monitoring");
    expect(aliceOwn).toMatchObject({ actingAs: false, role: "seller_admin" });
    expect(await resolveAccountAccess(db, alice, "freshtrack")).toBeNull();
    expect(await resolveAccountAccess(db, bob, "polar-monitoring")).toBeNull();
    expect(await resolveAccountAccess(db, mallory, "polar-monitoring")).toBeNull();
    expect(await resolveAccountAccess(db, alice, "does-not-exist")).toBeNull();
    expect(await resolveAccountAccess(db, admin, "freshtrack")).toMatchObject({ actingAs: true, role: "platform_admin" });

    expect((await listUserAccounts(db, alice.id)).map((r) => r.account.slug)).toEqual(["polar-monitoring"]);
    expect(await listUserAccounts(db, mallory.id)).toEqual([]);
  });

  it("does not let a demoted super admin keep acting-as access", async () => {
    const demoted = { ...admin, role: "user" as const };
    expect(await resolveAccountAccess(db, demoted, "freshtrack")).toBeNull();
  });

  it("pauses and resumes with audit, returning to Setting up when never live", async () => {
    const actor = { userId: admin.id, actingAs: true };
    expect((await pauseAccount(db, actor, polarId, now))?.status).toBe("paused");
    expect(await pauseAccount(db, actor, polarId, now)).toBeNull();
    expect((await resumeAccount(db, actor, polarId))?.status).toBe("setting_up");
    expect(await resumeAccount(db, actor, polarId)).toBeNull();
    const rows = await db.select().from(auditLog).where(eq(auditLog.accountId, polarId));
    const paused = rows.find((r) => r.action === "account.paused");
    expect(paused?.actingAs).toBe(true);
    expect(rows.some((r) => r.action === "account.resumed")).toBe(true);
  });

  it("creates extra invites that expire after 7 days", async () => {
    const { invite } = await createInvite(db, { userId: admin.id, actingAs: false }, polarId, { email: "New@Polar.test" }, now);
    expect(invite.email).toBe("new@polar.test");
    expect(invite.expiresAt.getTime() - now.getTime()).toBe(7 * 24 * 3600 * 1000);
  });
});

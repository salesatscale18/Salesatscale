/**
 * Seller accounts, membership, invites and access (implementation plan P1).
 *
 * Every function takes a `Db`, so integration tests run them on PGlite.
 * Authorization of the *caller* (super admin, member) is checked by the page
 * or action before calling in; access to an account is decided by
 * `resolveAccountAccess`, the only way seller pages get an account.
 *
 * Note: the Neon HTTP driver has no interactive transactions, so multi-row
 * writes here are ordered so a partial failure leaves a recoverable state
 * (e.g. an account without an invite can be re-invited).
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import {
  accountInvites, accountMembers, auditLog, sellerAccounts, users,
  type AccountInvite, type SellerAccount, type User,
} from "@/db/schema";
import { writeAudit, type Actor } from "./audit";
import {
  generateInviteToken, hashInviteToken, INVITE_TTL_DAYS, inviteEmailMatches, inviteState, slugify,
  statusAfterResume, type CreateAccountInput, type InviteState,
} from "./rules";

const DAY_MS = 24 * 60 * 60 * 1000;

async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name);
  const taken = await db.select({ slug: sellerAccounts.slug }).from(sellerAccounts);
  const set = new Set(taken.map((r) => r.slug));
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!set.has(candidate)) return candidate;
  }
}

/** Creates an account in Setting up and an owner invite. Returns the one-time invite token. */
export async function createAccount(db: Db, actor: Actor, input: CreateAccountInput, now = new Date()) {
  const slug = await uniqueSlug(db, input.tradeName);
  const [account] = await db
    .insert(sellerAccounts)
    .values({
      slug,
      tradeName: input.tradeName,
      legalName: input.legalName,
      companyId: input.companyId,
      market: input.market,
      languages: input.languages,
      timezone: input.timezone,
      currency: input.currency,
      plan: input.plan,
      monthlySpendCapMinor: input.monthlySpendCapMinor,
      dailyConversationLimit: input.dailyConversationLimit,
      retentionMonths: input.retentionMonths,
      notes: input.notes,
      createdByUserId: actor.userId,
    })
    .returning();
  await writeAudit(db, actor, {
    accountId: account.id,
    action: "account.created",
    targetType: "account",
    targetId: account.id,
    details: { tradeName: account.tradeName, plan: account.plan, ownerEmail: input.ownerEmail },
  });
  const invite = await createInvite(db, actor, account.id, { email: input.ownerEmail, name: input.ownerName, isOwner: true }, now);
  return { account, inviteToken: invite.token };
}

export async function createInvite(
  db: Db,
  actor: Actor,
  accountId: string,
  who: { email: string; name?: string | null; isOwner?: boolean },
  now = new Date(),
) {
  const { token, tokenHash } = generateInviteToken();
  const email = who.email.trim().toLowerCase();
  const [invite] = await db
    .insert(accountInvites)
    .values({
      accountId,
      email,
      inviteeName: who.name ?? null,
      isOwner: who.isOwner ?? false,
      tokenHash,
      invitedByUserId: actor.userId,
      expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * DAY_MS),
    })
    .returning();
  await writeAudit(db, actor, {
    accountId,
    action: "invite.created",
    targetType: "invite",
    targetId: invite.id,
    details: { email, isOwner: invite.isOwner },
  });
  return { invite, token };
}

export async function listAccounts(db: Db) {
  return db.select().from(sellerAccounts).orderBy(asc(sellerAccounts.tradeName));
}

export async function getAccountById(db: Db, id: string) {
  const [row] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, id));
  return row ?? null;
}

export async function listMembers(db: Db, accountId: string) {
  return db
    .select({ member: accountMembers, user: users })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(eq(accountMembers.accountId, accountId))
    .orderBy(desc(accountMembers.isOwner), asc(accountMembers.createdAt));
}

export async function listPendingInvites(db: Db, accountId: string, now = new Date()) {
  const rows = await db
    .select()
    .from(accountInvites)
    .where(and(eq(accountInvites.accountId, accountId), isNull(accountInvites.acceptedAt), isNull(accountInvites.revokedAt)))
    .orderBy(desc(accountInvites.createdAt));
  return rows.map((invite) => ({ invite, state: inviteState(invite, now) }));
}

export async function listAccountAudit(db: Db, accountId: string, limit = 50) {
  return db
    .select({ entry: auditLog, actor: users })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(eq(auditLog.accountId, accountId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/** Pausing stops all outgoing work for the account at once (enforced by senders from P6). */
export async function pauseAccount(db: Db, actor: Actor, accountId: string, now = new Date()) {
  const [row] = await db
    .update(sellerAccounts)
    .set({ status: "paused", pausedAt: now })
    .where(and(eq(sellerAccounts.id, accountId), inArray(sellerAccounts.status, ["setting_up", "live"])))
    .returning();
  if (row) await writeAudit(db, actor, { accountId, action: "account.paused", targetType: "account", targetId: accountId });
  return row ?? null;
}

export async function resumeAccount(db: Db, actor: Actor, accountId: string) {
  const current = await getAccountById(db, accountId);
  if (!current || current.status !== "paused") return null;
  const status = statusAfterResume(current);
  const [row] = await db
    .update(sellerAccounts)
    .set({ status, pausedAt: null })
    .where(and(eq(sellerAccounts.id, accountId), eq(sellerAccounts.status, "paused")))
    .returning();
  if (row) await writeAudit(db, actor, { accountId, action: "account.resumed", targetType: "account", targetId: accountId, details: { status } });
  return row ?? null;
}

/** Accounts the user is a member of, with their role. */
export async function listUserAccounts(db: Db, userId: string) {
  return db
    .select({ account: sellerAccounts, member: accountMembers })
    .from(accountMembers)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, accountMembers.accountId))
    .where(eq(accountMembers.userId, userId))
    .orderBy(asc(sellerAccounts.tradeName));
}

export type AccountAccess = {
  account: SellerAccount;
  user: User;
  /** True when a platform admin is inside an account they are not a member of. */
  actingAs: boolean;
  role: "seller_admin" | "platform_admin";
};

/**
 * Decides whether `user` may enter the account with `slug`.
 * Members get their role; a super_admin who is not a member enters "acting as".
 * Everyone else gets null (the page then calls notFound()).
 */
export async function resolveAccountAccess(db: Db, user: User, slug: string): Promise<AccountAccess | null> {
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.slug, slug));
  if (!account) return null;
  const [member] = await db
    .select()
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, account.id), eq(accountMembers.userId, user.id)));
  if (member) return { account, user, actingAs: false, role: member.role };
  if (user.role === "super_admin") return { account, user, actingAs: true, role: "platform_admin" };
  return null;
}

export async function findInviteByToken(db: Db, token: string) {
  const [row] = await db
    .select({ invite: accountInvites, account: sellerAccounts, inviter: users })
    .from(accountInvites)
    .innerJoin(sellerAccounts, eq(sellerAccounts.id, accountInvites.accountId))
    .leftJoin(users, eq(users.id, accountInvites.invitedByUserId))
    .where(eq(accountInvites.tokenHash, hashInviteToken(token)));
  return row ?? null;
}

export type AcceptResult =
  | { ok: true; account: SellerAccount }
  | { ok: false; reason: InviteState | "not_found" | "email_mismatch" };

/**
 * Accepts an invite for the signed-in user. The user must hold a verified
 * email equal to the invite's. Idempotent for the same user: accepting an
 * already-accepted invite you accepted yourself just returns the account.
 */
export async function acceptInvite(
  db: Db,
  user: User,
  verifiedEmails: readonly string[],
  token: string,
  now = new Date(),
): Promise<AcceptResult> {
  const found = await findInviteByToken(db, token);
  if (!found) return { ok: false, reason: "not_found" };
  const { invite, account } = found;
  const state = inviteState(invite, now);
  if (state === "accepted" && invite.acceptedByUserId === user.id) return { ok: true, account };
  if (state !== "valid") return { ok: false, reason: state };
  if (!inviteEmailMatches(invite.email, verifiedEmails)) return { ok: false, reason: "email_mismatch" };

  // Claim the invite first, conditionally, so two concurrent accepts cannot both succeed.
  const claimed = await db
    .update(accountInvites)
    .set({ acceptedAt: now, acceptedByUserId: user.id })
    .where(and(eq(accountInvites.id, invite.id), isNull(accountInvites.acceptedAt), isNull(accountInvites.revokedAt)))
    .returning({ id: accountInvites.id });
  if (claimed.length === 0) return { ok: false, reason: "accepted" };

  await db
    .insert(accountMembers)
    .values({ accountId: account.id, userId: user.id, role: invite.role, isOwner: invite.isOwner })
    .onConflictDoNothing({ target: [accountMembers.accountId, accountMembers.userId] });
  await writeAudit(db, { userId: user.id, actingAs: false }, {
    accountId: account.id,
    action: "invite.accepted",
    targetType: "invite",
    targetId: invite.id,
    details: { email: invite.email, role: invite.role, isOwner: invite.isOwner },
  });
  return { ok: true, account };
}

export type { AccountInvite };

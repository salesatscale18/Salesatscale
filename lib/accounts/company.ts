/**
 * Seller-side account settings: Setup › Company and Settings › Users,
 * Notifications, Contact hours. Every function is scoped by account id; the
 * caller's access comes from requireAccount.
 */
import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import {
  accountMembers, orderFormSettings, sellerAccounts, users, NOTIFICATION_EVENTS,
  type ContactHours, type NotificationEvent, type NotificationPrefs,
} from "@/db/schema";
import { DEFAULT_FIELDS } from "@/lib/orders/settings";
import { writeAudit, type Actor } from "./audit";
import { createInvite } from "./service";

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

export type CompanyInput = {
  tradeName: string;
  legalName: string | null;
  companyId: string | null;
  address: string | null;
  supportContact: string | null;
  salesRepUserId: string | null;
  brandColor: string;
};

export type CompanyErrors = Partial<Record<keyof CompanyInput, string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCompany(raw: Record<string, string>): { ok: true; value: CompanyInput } | { ok: false; errors: CompanyErrors } {
  const s = (k: string, max: number) => (raw[k] ?? "").trim().slice(0, max);
  const opt = (k: string, max: number) => s(k, max) || null;
  const errors: CompanyErrors = {};
  const tradeName = s("tradeName", 120);
  if (!tradeName) errors.tradeName = "Enter the trade name buyers know you by.";
  const color = s("brandColor", 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) errors.brandColor = "Brand color must look like #0f6b5a.";
  const rep = s("salesRepUserId", 36);
  if (rep && !UUID.test(rep)) errors.salesRepUserId = "Choose a member of this account.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tradeName,
      legalName: opt("legalName", 160),
      companyId: opt("companyId", 40),
      address: opt("address", 300),
      supportContact: opt("supportContact", 200),
      salesRepUserId: rep || null,
      brandColor: color.toLowerCase(),
    },
  };
}

export async function isMember(db: Db, accountId: string, userId: string) {
  const [m] = await db.select({ id: accountMembers.id }).from(accountMembers).where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));
  return !!m;
}

export type SaveCompanyResult = { ok: true } | { ok: false; errors: CompanyErrors };

/**
 * Saves company details. The brand color lives in order_form_settings (one
 * source of truth), so it is written there in the same batch.
 */
export async function saveCompany(db: Db, actor: Actor, accountId: string, v: CompanyInput): Promise<SaveCompanyResult> {
  if (v.salesRepUserId && !(await isMember(db, accountId, v.salesRepUserId))) {
    return { ok: false, errors: { salesRepUserId: "Choose a member of this account." } };
  }
  await atomic(db, (q) => [
    q.update(sellerAccounts).set({
      tradeName: v.tradeName, legalName: v.legalName, companyId: v.companyId, address: v.address,
      supportContact: v.supportContact, salesRepUserId: v.salesRepUserId,
    }).where(eq(sellerAccounts.id, accountId)),
    q.insert(orderFormSettings).values({ accountId, fields: DEFAULT_FIELDS, brandColor: v.brandColor })
      .onConflictDoUpdate({ target: orderFormSettings.accountId, set: { brandColor: v.brandColor } }),
  ]);
  if (actor.actingAs) {
    await writeAudit(db, actor, { accountId, action: "company.saved", targetType: "account", targetId: accountId, details: { tradeName: v.tradeName, brandColor: v.brandColor } });
  }
  return { ok: true };
}

/** WCAG contrast ratio of white text on `hex` (the pay button). */
export function whiteContrast(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 1;
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => lin(parseInt(h, 16)));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (l + 0.05);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type InviteMemberResult =
  | { ok: true; invite: Awaited<ReturnType<typeof createInvite>>["invite"]; token: string }
  | { ok: false; reason: "invalid_email" | "already_member" };

/** Seller-side invite (Settings › Users): a plain seller admin, never an owner. Audited by createInvite. */
export async function inviteMember(db: Db, actor: Actor, accountId: string, who: { email: string; name?: string | null }, now = new Date()): Promise<InviteMemberResult> {
  const email = who.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { ok: false, reason: "invalid_email" };
  const [existing] = await db
    .select({ id: accountMembers.id })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(and(eq(accountMembers.accountId, accountId), sql`lower(${users.email}) = ${email}`));
  if (existing) return { ok: false, reason: "already_member" };
  const r = await createInvite(db, actor, accountId, { email, name: who.name?.trim().slice(0, 80) || null, isOwner: false }, now);
  return { ok: true, invite: r.invite, token: r.token };
}

export type RemoveMemberResult = { ok: true } | { ok: false; reason: "not_found" | "self" | "last_owner" };

/** Removes a member of this account. Never yourself, never the last owner. Audited. */
export async function removeMember(db: Db, actor: Actor, accountId: string, memberId: string): Promise<RemoveMemberResult> {
  const [m] = await db.select().from(accountMembers).where(and(eq(accountMembers.id, memberId), eq(accountMembers.accountId, accountId)));
  if (!m) return { ok: false, reason: "not_found" };
  if (actor.userId && m.userId === actor.userId) return { ok: false, reason: "self" };
  if (m.isOwner) {
    const [{ owners }] = await db.select({ owners: count() }).from(accountMembers).where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.isOwner, true)));
    if (Number(owners) <= 1) return { ok: false, reason: "last_owner" };
  }
  await atomic(db, (q) => [
    q.delete(accountMembers).where(and(eq(accountMembers.id, m.id), eq(accountMembers.accountId, accountId))),
    // A removed member can no longer take handoffs.
    q.update(sellerAccounts).set({ salesRepUserId: null }).where(and(eq(sellerAccounts.id, accountId), eq(sellerAccounts.salesRepUserId, m.userId))),
  ]);
  await writeAudit(db, actor, { accountId, action: "member.removed", targetType: "member", targetId: m.id, details: { userId: m.userId, isOwner: m.isOwner } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function notificationsOrDefault(prefs: NotificationPrefs | null | undefined): Record<NotificationEvent, { email: boolean }> {
  return Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, { email: prefs?.[e]?.email ?? true }])) as Record<NotificationEvent, { email: boolean }>;
}

/** Reads `<event>_email` checkboxes. */
export function parseNotifications(raw: Record<string, string>): NotificationPrefs {
  return Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, { email: raw[`${e}_email`] === "on" }]));
}

export async function saveNotifications(db: Db, actor: Actor, accountId: string, prefs: NotificationPrefs) {
  await db.update(sellerAccounts).set({ notifications: prefs }).where(eq(sellerAccounts.id, accountId));
  await writeAudit(db, actor, { accountId, action: "notifications.saved", targetType: "account", targetId: accountId, details: { prefs } });
}

export async function saveContactHours(db: Db, actor: Actor, accountId: string, hours: ContactHours) {
  await db.update(sellerAccounts).set({ contactHours: hours }).where(eq(sellerAccounts.id, accountId));
  await writeAudit(db, actor, { accountId, action: "contact_hours.saved", targetType: "account", targetId: accountId });
}

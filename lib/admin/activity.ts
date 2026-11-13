/**
 * Admin › Activity (P9.4): the audit log across accounts, newest first.
 * Callers must have checked super_admin already.
 */
import { and, desc, eq, like, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/types";
import { auditLog, sellerAccounts, users, type AuditEntry, type User } from "@/db/schema";

export type AuditQuery = {
  accountId?: string;
  /** e.g. "quote." matches quote.created, quote.approved… */
  actionPrefix?: string;
  limit: number;
  /** Id of the last entry of the previous page (keyset cursor). */
  before?: string;
};

export type AuditRow = { entry: AuditEntry; actor: User | null; account: { id: string; slug: string; tradeName: string } | null };

/** Escapes LIKE wildcards so a prefix matches literally. */
const likePrefix = (p: string) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listAuditLog(db: Db, q: AuditQuery): Promise<{ rows: AuditRow[]; nextBefore: string | null }> {
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit)));
  const where: SQL[] = [];
  if (q.accountId) where.push(eq(auditLog.accountId, q.accountId));
  if (q.actionPrefix) where.push(like(auditLog.action, likePrefix(q.actionPrefix)));
  if (q.before) {
    // Compare in SQL so timestamps keep full precision; id breaks ties.
    const cursor = db.select({ createdAt: auditLog.createdAt }).from(auditLog).where(eq(auditLog.id, q.before));
    where.push(
      or(
        lt(auditLog.createdAt, sql`(${cursor})`),
        and(eq(auditLog.createdAt, sql`(${cursor})`), lt(auditLog.id, q.before)),
      )!,
    );
  }
  const rows = await db
    .select({
      entry: auditLog,
      actor: users,
      account: { id: sellerAccounts.id, slug: sellerAccounts.slug, tradeName: sellerAccounts.tradeName },
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(sellerAccounts, eq(sellerAccounts.id, auditLog.accountId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { rows: page, nextBefore: rows.length > limit ? page[page.length - 1].entry.id : null };
}

/** Action filters offered on the page; the value is the prefix. */
export const ACTION_PREFIXES = [
  "account.", "invite.", "lead", "intake_key.", "deal.", "knowledge.", "catalog.", "agent.", "quote.", "order_form.", "order.",
] as const;

/** Accepts only short dotted names, so a crafted value cannot widen the query. */
export function parseActionPrefix(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim();
  return /^[a-z_]{1,40}\.?$/.test(v) ? v : undefined;
}

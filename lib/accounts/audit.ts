import type { Db } from "@/db/types";
import { auditLog } from "@/db/schema";

/** userId is null for system actions (agent, intake, opt-out by message). */
export type Actor = { userId: string | null; actingAs: boolean };

export type AuditInput = {
  accountId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
};

/** Appends one audit entry. Sensitive actions call this from day one (mvp-plan 3.8). */
export async function writeAudit(db: Db, actor: Actor | null, entry: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    accountId: entry.accountId,
    actorUserId: actor?.userId ?? null,
    actingAs: actor?.actingAs ?? false,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    details: entry.details ?? null,
  });
}

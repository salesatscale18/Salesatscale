/**
 * Setup progress (canvas: SetupSteps): which setup steps are done, derived
 * from the account's data. Used by the Overview and every setup page.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, catalogVersions, knowledgeFacts, sellerAccounts } from "@/db/schema";
import { currentLegal } from "@/lib/orders/settings";

/** Step ids of `SETUP_STEPS` in components/sas/nav.tsx. */
export type SetupStepId = "company" | "sources" | "knowledge" | "catalog" | "playbook" | "order-form" | "follow-ups" | "go-live";

/**
 * Completed step ids. Sources and follow-ups have no data yet (P6, P8), so
 * they are never complete here.
 */
export async function setupProgress(db: Db, accountId: string): Promise<Set<SetupStepId>> {
  const [[account], [fact], [catalog], [agent], legal] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    db.select({ id: knowledgeFacts.id }).from(knowledgeFacts)
      .where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "approved"))).limit(1),
    db.select({ id: catalogVersions.id }).from(catalogVersions)
      .where(and(eq(catalogVersions.accountId, accountId), eq(catalogVersions.status, "published"))).limit(1),
    db.select({ id: agentVersions.id }).from(agentVersions)
      .where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live"))).limit(1),
    currentLegal(db, accountId),
  ]);
  const done = new Set<SetupStepId>();
  if (!account) return done;
  if (account.legalName?.trim() && account.companyId?.trim()) done.add("company");
  if (fact) done.add("knowledge");
  if (catalog) done.add("catalog");
  if (agent) done.add("playbook");
  const legalLanguages = new Set(legal.map((s) => s.language));
  if (account.languages.length > 0 && account.languages.every((l) => legalLanguages.has(l))) done.add("order-form");
  if (account.status === "live") done.add("go-live");
  return done;
}

/**
 * Setup progress (canvas: SetupSteps): which setup steps are done, derived
 * from the account's data. Used by the Overview and every setup page.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, catalogVersions, knowledgeFacts, sellerAccounts, type SellerAccount } from "@/db/schema";
import { currentLegalKeys } from "@/lib/orders/settings";

/** Step ids of `SETUP_STEPS` in components/sas/nav.tsx. */
export type SetupStepId = "company" | "sources" | "knowledge" | "catalog" | "playbook" | "order-form" | "follow-ups" | "go-live";

/** The account columns setup progress reads. Pages pass the row they already loaded. */
export type ProgressAccount = Pick<SellerAccount, "id" | "legalName" | "companyId" | "languages" | "status">;

/**
 * Completed step ids. Sources and follow-ups have no data yet (P6, P8), so
 * they are never complete here. Pass the already-loaded account row to save
 * a query; an account id still works (the row is then selected here).
 */
export async function setupProgress(db: Db, accountOrId: string | ProgressAccount): Promise<Set<SetupStepId>> {
  const accountId = typeof accountOrId === "string" ? accountOrId : accountOrId.id;
  const [account, [fact], [catalog], [agent], legal] = await Promise.all([
    typeof accountOrId === "string"
      ? db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)).then(([a]) => a as ProgressAccount | undefined)
      : accountOrId,
    db.select({ id: knowledgeFacts.id }).from(knowledgeFacts)
      .where(and(eq(knowledgeFacts.accountId, accountId), eq(knowledgeFacts.status, "approved"))).limit(1),
    db.select({ id: catalogVersions.id }).from(catalogVersions)
      .where(and(eq(catalogVersions.accountId, accountId), eq(catalogVersions.status, "published"))).limit(1),
    db.select({ id: agentVersions.id }).from(agentVersions)
      .where(and(eq(agentVersions.accountId, accountId), eq(agentVersions.status, "live"))).limit(1),
    currentLegalKeys(db, accountId),
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

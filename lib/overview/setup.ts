/**
 * Setup progress (canvas: SetupSteps): which setup steps are done, derived
 * from the account's data. Used by the Overview and every setup page.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { agentVersions, catalogVersions, knowledgeFacts, markets, priceLists, sellerAccounts, sources, type SellerAccount } from "@/db/schema";
import { currentLegalKeys } from "@/lib/orders/settings";

/** Step ids of `SETUP_STEPS` in components/sas/nav.tsx. */
export type SetupStepId = "company" | "sources" | "knowledge" | "catalog" | "prices" | "playbook" | "order-form" | "follow-ups" | "go-live";

/** The account columns setup progress reads. Pages pass the row they already loaded. */
export type ProgressAccount = Pick<SellerAccount, "id" | "legalName" | "companyId" | "languages" | "status">;

/**
 * Completed step ids. Sources is done once one source is ready (P8).
 * Follow-ups have no data yet (P7), so it is never complete here. Pass the already-loaded account row to save
 * a query; an account id still works (the row is then selected here).
 */
export async function setupProgress(db: Db, accountOrId: string | ProgressAccount): Promise<Set<SetupStepId>> {
  const accountId = typeof accountOrId === "string" ? accountOrId : accountOrId.id;
  const [account, [fact], [catalog], [agent], legal, [homePrices], [readySource]] = await Promise.all([
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
    // Prices: the home market sells from a price list that has a live version.
    // Read only: an account without a home market yet is simply not done.
    db.select({ id: priceLists.id }).from(markets)
      .innerJoin(priceLists, and(eq(priceLists.accountId, markets.accountId), eq(priceLists.lineageId, markets.priceListLineageId), eq(priceLists.status, "live")))
      .where(and(eq(markets.accountId, accountId), eq(markets.isHome, true))).limit(1),
    db.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.accountId, accountId), eq(sources.status, "ready"))).limit(1),
  ]);
  const done = new Set<SetupStepId>();
  if (!account) return done;
  if (account.legalName?.trim() && account.companyId?.trim()) done.add("company");
  if (readySource) done.add("sources");
  if (fact) done.add("knowledge");
  if (catalog) done.add("catalog");
  if (homePrices) done.add("prices");
  if (agent) done.add("playbook");
  const legalLanguages = new Set(legal.map((s) => s.language));
  if (account.languages.length > 0 && account.languages.every((l) => legalLanguages.has(l))) done.add("order-form");
  if (account.status === "live") done.add("go-live");
  return done;
}

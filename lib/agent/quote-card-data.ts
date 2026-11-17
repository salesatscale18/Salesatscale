/**
 * Loads the quote cards of conversations (lib/agent/quote-card.ts): the
 * quote messages from create_quote's tool calls, then the quotes, versions,
 * lines, item names and delivery dates they show. Scoped by account id
 * everywhere: a link to another account's quote shows nothing.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { catalogItems, messages, orderFormSettings, priceLists, quoteLines, quotes, quoteVersions, sellerAccounts, toolCalls } from "@/db/schema";
import { approvalReasonText } from "@/lib/catalog/pricing";
import { estimateDelivery } from "@/lib/delivery/eta";
import { deliveryPlanFor } from "@/lib/delivery/plan";
import { resolveMarket } from "@/lib/markets/service";
import { safeBrand } from "@/lib/simulator/rules";
import type { ApprovalReason } from "@/db/schema";
import { buildQuoteCards, quoteCardLinks, type CardData, type CardLine, type CardVersion, type QuoteCardView } from "./quote-card";

export async function loadQuoteCards(
  db: Db, accountId: string, conversationIds: string[], opts: { audience: "buyer" | "seller"; now?: Date },
): Promise<Record<string, QuoteCardView>> {
  if (conversationIds.length === 0) return {};
  const calls = await db.select({ name: toolCalls.name, outcome: toolCalls.outcome, result: toolCalls.result, conversationId: toolCalls.conversationId })
    .from(toolCalls)
    .where(and(eq(toolCalls.accountId, accountId), inArray(toolCalls.conversationId, conversationIds), eq(toolCalls.name, "create_quote"), eq(toolCalls.outcome, "ok")));
  const links = quoteCardLinks(calls);
  if (links.length === 0) return {};

  const msgs = await db.select({ id: messages.id, language: messages.language, createdAt: messages.createdAt, conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), inArray(messages.id, links.map((l) => l.messageId))))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const linkOf = new Map(links.map((l) => [l.messageId, l]));
  const inputs = msgs.map((m) => ({ link: { ...linkOf.get(m.id)!, conversationId: m.conversationId }, language: m.language }));
  if (inputs.length === 0) return {};

  const ids = [...new Set(inputs.map((i) => i.link.quoteId).filter((x): x is string => !!x))];
  const numbers = [...new Set(inputs.filter((i) => !i.link.quoteId).map((i) => i.link.number))];
  const [byId, byNumber, [account], [settings]] = await Promise.all([
    ids.length ? db.select().from(quotes).where(and(eq(quotes.accountId, accountId), inArray(quotes.id, ids))) : Promise.resolve([]),
    numbers.length ? db.select().from(quotes).where(and(eq(quotes.accountId, accountId), inArray(quotes.number, numbers))) : Promise.resolve([]),
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    db.select({ brandColor: orderFormSettings.brandColor }).from(orderFormSettings).where(eq(orderFormSettings.accountId, accountId)),
  ]);
  const quoteRows = [...new Map([...byId, ...byNumber].map((q) => [q.id, q])).values()];
  if (!account || quoteRows.length === 0) return {};

  const versionRows = await db.select().from(quoteVersions)
    .where(and(eq(quoteVersions.accountId, accountId), inArray(quoteVersions.quoteId, quoteRows.map((q) => q.id))))
    .orderBy(asc(quoteVersions.version));
  const lineRows = versionRows.length
    ? await db.select().from(quoteLines)
      .where(and(eq(quoteLines.accountId, accountId), inArray(quoteLines.quoteVersionId, versionRows.map((v) => v.id))))
      .orderBy(asc(quoteLines.sortOrder))
    : [];
  const itemIds = [...new Set(lineRows.map((l) => l.catalogItemId).filter((x): x is string => !!x))];
  const listIds = [...new Set(versionRows.map((v) => v.priceListId).filter((x): x is string => !!x))];
  const [items, lists] = await Promise.all([
    itemIds.length
      ? db.select({ id: catalogItems.id, plainName: catalogItems.plainName, kind: catalogItems.kind }).from(catalogItems)
        .where(and(eq(catalogItems.accountId, accountId), inArray(catalogItems.id, itemIds)))
      : Promise.resolve([]),
    opts.audience === "seller" && listIds.length
      ? db.select({ id: priceLists.id, name: priceLists.name }).from(priceLists).where(and(eq(priceLists.accountId, accountId), inArray(priceLists.id, listIds)))
      : Promise.resolve([]),
  ]);
  const itemOf = new Map(items.map((i) => [i.id, i]));

  // Delivery: the estimate from when the version was made, in the quote's market (as the agent's close said it).
  const marketIds = [...new Set(quoteRows.map((q) => q.marketId ?? null))];
  const markets = new Map(await Promise.all(marketIds.map(async (id) => [id, await resolveMarket(db, accountId, id)] as const)));
  const marketOfQuote = new Map(quoteRows.map((q) => [q.id, markets.get(q.marketId ?? null)!]));
  const deliveryLatest = new Map<string, string | null>();
  let timezone = account.timezone;
  for (const v of versionRows) {
    const plan = deliveryPlanFor(account, marketOfQuote.get(v.quoteId)!);
    if (plan) timezone = plan.timezone;
    deliveryLatest.set(v.id, plan ? estimateDelivery({ ...plan, from: v.createdAt }).latest : null);
  }

  const lines = new Map<string, CardLine[]>();
  for (const l of lineRows) {
    const item = l.catalogItemId ? itemOf.get(l.catalogItemId) : undefined;
    const list = lines.get(l.quoteVersionId) ?? [];
    list.push({
      sku: l.sku, name: item?.plainName?.trim() || l.name, qty: l.qty, charge: l.chargeType, lineTotalMinor: l.lineTotalMinor,
      priceSource: l.priceSource, service: item?.kind === "service", sortOrder: l.sortOrder,
    });
    lines.set(l.quoteVersionId, list);
  }
  const versions = new Map<string, CardVersion[]>();
  for (const v of versionRows) versions.set(v.quoteId, [...(versions.get(v.quoteId) ?? []), v]);

  const data: CardData = {
    quotes: new Map(quoteRows.map((q) => [q.id, q])),
    versions, lines, deliveryLatest,
    priceListNames: new Map(lists.map((p) => [p.id, p.name])),
    reasonText: (r) => approvalReasonText(r as ApprovalReason),
  };
  return buildQuoteCards(inputs, data, {
    seller: account.tradeName, brand: safeBrand(settings?.brandColor), timezone, now: opts.now ?? new Date(), audience: opts.audience,
  });
}

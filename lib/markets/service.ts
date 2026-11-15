/**
 * Markets (mvp-plan 3.13). Every function is scoped by account id; every write
 * is audited.
 *
 * Accounts made before markets existed have none. Instead of a data migration,
 * ensureHomeMarket creates the home market from the account the first time it
 * is needed; the unique partial index markets_one_home_uq makes that safe
 * when several requests do it at once.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { atomic } from "@/db/atomic";
import { leadIntakeKeys, markets, sellerAccounts, type Market, type MarketOverrides, type MarketStatus } from "@/db/schema";
import { writeAudit, type Actor } from "@/lib/accounts/audit";
import { getOrderFormSettings } from "@/lib/orders/settings";
import { lineageExists, livePriceList } from "@/lib/pricing/price-lists";
import { marketLegal } from "./legal";
import { matchMarket, type MatchInput, type MatchReason } from "./match";
import { CALLING_CODES, canGoLive, countryName, marketGoLiveChecks, parseMarketPatch, statusChangeAllowed, type GoLiveCheck, type MarketErrors, type MarketInput } from "./rules";
import { accountDefaultsFrom, effectiveSettings, OVERRIDABLE, overrideProblem, sanitizeOverrides, type EffectiveSettings, type SettingKey } from "./settings";

async function homeOf(db: Db, accountId: string): Promise<Market | null> {
  const [m] = await db.select().from(markets).where(and(eq(markets.accountId, accountId), eq(markets.isHome, true)));
  return m ?? null;
}

/**
 * Returns the account's home market, creating it from the account (country,
 * phone prefix, status) when it does not exist yet. Idempotent and safe under
 * concurrent calls. Null only when the account does not exist.
 */
export async function ensureHomeMarket(db: Db, accountId: string, actor: Actor | null = null): Promise<Market | null> {
  const existing = await homeOf(db, accountId);
  if (existing) return existing;
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (!account) return null;
  const code = CALLING_CODES[account.market];
  const inserted = await db
    .insert(markets)
    .values({
      id: randomUUID(),
      accountId,
      name: countryName(account.market),
      isHome: true,
      status: account.status,
      countries: [account.market],
      phonePrefixes: code ? [code] : [],
      formCountryValues: [account.market],
      overrides: {},
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await writeAudit(db, actor, { accountId, action: "market.created", targetType: "market", targetId: inserted[0].id, details: { name: inserted[0].name, home: true } });
    return inserted[0];
  }
  return homeOf(db, accountId);
}

/** Every market of the account, home market first. Creates the home market if needed. */
export async function listMarkets(db: Db, accountId: string): Promise<Market[]> {
  await ensureHomeMarket(db, accountId);
  return db.select().from(markets).where(eq(markets.accountId, accountId)).orderBy(desc(markets.isHome), asc(markets.createdAt), asc(markets.id));
}

export async function getMarket(db: Db, accountId: string, marketId: string): Promise<Market | null> {
  const [m] = await db.select().from(markets).where(and(eq(markets.id, marketId), eq(markets.accountId, accountId)));
  return m ?? null;
}

/** The market a lead belongs to; falls back to the home market. */
export async function marketForLead(db: Db, accountId: string, input: MatchInput): Promise<{ market: Market; reason: MatchReason }> {
  const all = await listMarkets(db, accountId);
  const r = matchMarket(all, input);
  return { market: r.market ?? all[0], reason: r.reason };
}

/** A lead's (or quote's, order's) market: its market_id, or the home market when null or not this account's. */
export async function resolveMarket(db: Db, accountId: string, marketId: string | null | undefined): Promise<Market> {
  if (marketId) {
    const m = await getMarket(db, accountId, marketId);
    if (m) return m;
  }
  return (await ensureHomeMarket(db, accountId))!;
}

export type MarketWriteResult = { ok: true; market: Market } | { ok: false; errors: MarketErrors & { overrides?: string; market?: string } };

function overridesProblem(o: MarketOverrides): string | null {
  for (const key of Object.keys(o)) {
    if (!(OVERRIDABLE as readonly string[]).includes(key)) return `Unknown setting: ${key}.`;
    const p = overrideProblem(key as SettingKey, (o as Record<string, unknown>)[key]);
    if (p) return p;
  }
  return null;
}

/** Checks that every intake key belongs to the account. */
async function keysOwned(db: Db, accountId: string, keyIds: string[]): Promise<boolean> {
  if (keyIds.length === 0) return true;
  const rows = await db.select({ id: leadIntakeKeys.id }).from(leadIntakeKeys).where(and(eq(leadIntakeKeys.accountId, accountId), inArray(leadIntakeKeys.id, keyIds)));
  return rows.length === keyIds.length;
}

/**
 * Points lead_intake_keys.market_id at the market for its keys, clears it for
 * keys it no longer has, and takes the keys away from other markets. Returns
 * the statements so they run in the same transaction as the market write.
 */
function syncKeys(q: Db, accountId: string, marketId: string, keyIds: string[]) {
  const statements: PromiseLike<unknown>[] = [
    q.update(leadIntakeKeys).set({ marketId: null }).where(and(eq(leadIntakeKeys.accountId, accountId), eq(leadIntakeKeys.marketId, marketId))),
  ];
  if (keyIds.length > 0) {
    statements.push(q.update(leadIntakeKeys).set({ marketId }).where(and(eq(leadIntakeKeys.accountId, accountId), inArray(leadIntakeKeys.id, keyIds))));
    const arr = sql`ARRAY[${sql.join(keyIds.map((k) => sql`${k}::uuid`), sql`, `)}]`;
    statements.push(
      q.update(markets)
        .set({ intakeKeyIds: sql`ARRAY(SELECT k FROM unnest(${markets.intakeKeyIds}) AS k WHERE NOT (k = ANY(${arr})))` })
        .where(and(eq(markets.accountId, accountId), ne(markets.id, marketId))),
    );
  }
  return statements;
}

export type CreateMarketInput = Partial<MarketInput> & { name: string; overrides?: MarketOverrides; priceListLineageId?: string | null };

/** Adds a market (status Setting up). The home market always exists first. */
export async function createMarket(db: Db, actor: Actor, accountId: string, input: CreateMarketInput): Promise<MarketWriteResult> {
  const p = parseMarketPatch({ name: input.name, countries: input.countries ?? [], phonePrefixes: input.phonePrefixes ?? [], formCountryValues: input.formCountryValues ?? [], intakeKeyIds: input.intakeKeyIds ?? [] });
  if (!p.ok) return { ok: false, errors: p.errors };
  const overrides = input.overrides ?? {};
  const op = overridesProblem(overrides);
  if (op) return { ok: false, errors: { overrides: op } };
  const v = p.value as MarketInput;
  if (!(await keysOwned(db, accountId, v.intakeKeyIds))) return { ok: false, errors: { intakeKeyIds: "Choose intake keys from the list." } };
  if (input.priceListLineageId && !(await lineageExists(db, accountId, input.priceListLineageId))) return { ok: false, errors: { market: "Choose a price list from the list." } };
  if (!(await ensureHomeMarket(db, accountId, actor))) return { ok: false, errors: { market: "Account not found." } };
  const id = randomUUID();
  await atomic(db, (q) => [
    q.insert(markets).values({
      id,
      accountId,
      name: v.name,
      isHome: false,
      status: "setting_up",
      countries: v.countries,
      phonePrefixes: v.phonePrefixes,
      formCountryValues: v.formCountryValues,
      intakeKeyIds: v.intakeKeyIds,
      priceListLineageId: input.priceListLineageId ?? null,
      overrides: sanitizeOverrides(overrides),
    }),
    ...syncKeys(q, accountId, id, v.intakeKeyIds),
  ]);
  await writeAudit(db, actor, { accountId, action: "market.created", targetType: "market", targetId: id, details: { name: v.name } });
  return { ok: true, market: (await getMarket(db, accountId, id))! };
}

export type MarketPatch = Partial<MarketInput> & { overrides?: MarketOverrides };

/** Changes a market's name, countries, matchers (phone prefixes, form values, intake keys) or overrides. */
export async function updateMarket(db: Db, actor: Actor, accountId: string, marketId: string, patch: MarketPatch): Promise<MarketWriteResult> {
  const market = await getMarket(db, accountId, marketId);
  if (!market) return { ok: false, errors: { market: "This market was not found." } };
  const { overrides, ...fields } = patch;
  const p = parseMarketPatch(fields);
  if (!p.ok) return { ok: false, errors: p.errors };
  if (overrides !== undefined) {
    const op = overridesProblem(overrides);
    if (op) return { ok: false, errors: { overrides: op } };
  }
  const v = p.value;
  if (v.intakeKeyIds && !(await keysOwned(db, accountId, v.intakeKeyIds))) return { ok: false, errors: { intakeKeyIds: "Choose intake keys from the list." } };
  const set = { ...v, ...(overrides !== undefined ? { overrides: sanitizeOverrides(overrides) } : {}) };
  if (Object.keys(set).length === 0) return { ok: true, market };
  await atomic(db, (q) => [
    q.update(markets).set(set).where(and(eq(markets.id, marketId), eq(markets.accountId, accountId))),
    ...(v.intakeKeyIds ? syncKeys(q, accountId, marketId, v.intakeKeyIds) : []),
  ]);
  await writeAudit(db, actor, { accountId, action: "market.updated", targetType: "market", targetId: marketId, details: { changed: Object.keys(set), ...set } });
  return { ok: true, market: (await getMarket(db, accountId, marketId))! };
}

/** Chooses the price list (lineage) the market sells from; null clears it. */
export async function setMarketPriceList(db: Db, actor: Actor, accountId: string, marketId: string, lineageId: string | null): Promise<MarketWriteResult> {
  const market = await getMarket(db, accountId, marketId);
  if (!market) return { ok: false, errors: { market: "This market was not found." } };
  if (lineageId && !(await lineageExists(db, accountId, lineageId))) return { ok: false, errors: { market: "Choose a price list from the list." } };
  await db.update(markets).set({ priceListLineageId: lineageId }).where(and(eq(markets.id, marketId), eq(markets.accountId, accountId)));
  await writeAudit(db, actor, { accountId, action: "market.price_list_set", targetType: "market", targetId: marketId, details: { lineageId } });
  return { ok: true, market: (await getMarket(db, accountId, marketId))! };
}

export type MarketView = {
  market: Market;
  settings: EffectiveSettings;
  checks: GoLiveCheck[];
  livePriceList: { id: string; name: string; currency: string; version: number } | null;
};

/** Loads what the go-live checks and the settings view need, then runs the pure checks. */
export async function getMarketView(db: Db, accountId: string, marketId: string): Promise<MarketView | null> {
  const market = await getMarket(db, accountId, marketId);
  if (!market) return null;
  const [[account], orderForm, legal, live] = await Promise.all([
    db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId)),
    getOrderFormSettings(db, accountId),
    marketLegal(db, accountId, market.id),
    market.priceListLineageId ? livePriceList(db, accountId, market.priceListLineageId) : Promise.resolve(null),
  ]);
  if (!account) return null;
  const settings = effectiveSettings(accountDefaultsFrom(account, orderForm), market, live?.list ?? null);
  const checks = marketGoLiveChecks({
    market,
    settings,
    livePriceList: live ? { name: live.list.name } : null,
    legalLanguages: [...new Set(legal.map((s) => s.language))],
    whatsappNumber: null,
  });
  return {
    market,
    settings,
    checks,
    livePriceList: live ? { id: live.list.id, name: live.list.name, currency: live.list.currency, version: live.list.version } : null,
  };
}

/** Go-live checks for a market (loader around the pure marketGoLiveChecks). */
export async function getMarketGoLiveChecks(db: Db, accountId: string, marketId: string): Promise<GoLiveCheck[] | null> {
  return (await getMarketView(db, accountId, marketId))?.checks ?? null;
}

export type StatusResult = { ok: true; market: Market } | { ok: false; reason: "not_found" | "not_allowed" | "checks_failed"; checks?: GoLiveCheck[] };

/** Live needs every blocking go-live check to pass; Paused stops new contact in that market. */
export async function setMarketStatus(db: Db, actor: Actor, accountId: string, marketId: string, status: MarketStatus): Promise<StatusResult> {
  const view = await getMarketView(db, accountId, marketId);
  if (!view) return { ok: false, reason: "not_found" };
  if (!statusChangeAllowed(view.market.status, status)) return { ok: false, reason: "not_allowed" };
  if (status === "live" && !canGoLive(view.checks)) return { ok: false, reason: "checks_failed", checks: view.checks };
  await db.update(markets).set({ status }).where(and(eq(markets.id, marketId), eq(markets.accountId, accountId)));
  await writeAudit(db, actor, { accountId, action: "market.status_changed", targetType: "market", targetId: marketId, details: { from: view.market.status, to: status } });
  return { ok: true, market: (await getMarket(db, accountId, marketId))! };
}

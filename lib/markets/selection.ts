/**
 * The workspace market selection (server side), shared by Overview, Leads,
 * Conversations and Quotes and orders.
 *
 * CONTRACT
 * - URL parameter `?market=<market id>` or `?market=all` (MARKET_PARAM, MARKET_ALL).
 * - Stored preference: the cookie `marketCookieName(accountId)`
 *   ("sas_market_<account id>", value = market id or "all"), one per account
 *   in the user's browser (HttpOnly, one year). Only the switcher's route
 *   handler (GET /app/<slug>/market?market=…&next=…, app/app/[account]/market/route.ts,
 *   logic in marketSwitchTarget) writes it, then redirects to `next` with `?market=` set.
 * - Resolution (resolveMarketId, pure): a `market` URL parameter wins over the
 *   cookie. "all" means all markets. A URL id that is not one of the account's
 *   markets falls back to ALL markets (a stale link never picks a market for
 *   you); an unknown cookie value also means all. With one market or none the
 *   selection is always all.
 * - `marketSelection(db, accountId, searchParams)` loads the account's markets
 *   (home first, via listMarkets) and reads the cookie: returns the markets,
 *   the selected market (null = all) and `showSwitcher` (more than one market).
 * - Filtering: leads, quotes and orders with market_id NULL belong to the home
 *   market. Use `marketWhere(column, selected)` in SQL (undefined = no filter)
 *   and `inMarket(marketId, selected)` in memory; never compare ids directly.
 * - Links: `withMarketParam(href, selected)` keeps the choice on links between
 *   the four pages; the cookie already carries it when a link has none.
 * The control itself is components/sas/market-switcher.tsx.
 */
import { cookies } from "next/headers";
import { eq, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@/db/types";
import type { Market } from "@/db/schema";
import { listMarkets } from "./service";

export const MARKET_PARAM = "market";
export const MARKET_ALL = "all";
const COOKIE_PREFIX = "sas_market_";
/** One year: a preference, not a session. */
export const MARKET_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The cookie that stores the market choice for one account. */
export function marketCookieName(accountId: string): string {
  return `${COOKIE_PREFIX}${accountId}`;
}

/** The switcher shows only when there is something to choose. */
export function showMarketSwitcher(markets: readonly unknown[]): boolean {
  return markets.length > 1;
}

type SearchParamsLike = Record<string, string | string[] | undefined> | URLSearchParams;

function paramOf(params: SearchParamsLike, name: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined;
  const v = params[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The selected market id, or null for all markets. Pure: the URL value wins
 * over the cookie value; anything that is not one of `markets` means all.
 */
export function resolveMarketId(markets: readonly { id: string }[], urlValue: string | undefined | null, cookieValue: string | undefined | null): string | null {
  if (!showMarketSwitcher(markets)) return null;
  const valid = (v: string) => (markets.some((m) => m.id === v) ? v : null);
  if (urlValue !== undefined && urlValue !== null && urlValue !== "") return urlValue === MARKET_ALL ? null : valid(urlValue);
  if (cookieValue) return cookieValue === MARKET_ALL ? null : valid(cookieValue);
  return null;
}

export type MarketSelection = {
  /** Every market of the account, home first. */
  markets: Market[];
  /** The chosen market; null = all markets. */
  selected: Market | null;
  /** True when the account has more than one market. */
  showSwitcher: boolean;
};

/** Loads the account's markets and resolves the choice from `searchParams` and the cookie. */
export async function marketSelection(db: Db, accountId: string, searchParams: SearchParamsLike): Promise<MarketSelection> {
  const markets = await listMarkets(db, accountId);
  const showSwitcher = showMarketSwitcher(markets);
  // With one market there is nothing to choose: the cookie is not even read.
  if (!showSwitcher) return { markets, selected: null, showSwitcher };
  const stored = (await cookies()).get(marketCookieName(accountId))?.value;
  const id = resolveMarketId(markets, paramOf(searchParams, MARKET_PARAM), stored);
  return { markets, selected: markets.find((m) => m.id === id) ?? null, showSwitcher };
}

type MarketRef = Pick<Market, "id" | "isHome">;

/** SQL condition "this row is in the selected market" (null market_id = home); undefined when all markets. */
export function marketWhere(column: AnyPgColumn, selected: MarketRef | null): SQL | undefined {
  if (!selected) return undefined;
  return selected.isHome ? or(eq(column, selected.id), isNull(column)) : eq(column, selected.id);
}

/** In-memory twin of marketWhere: is a row with this market_id in the selected market? */
export function inMarket(marketId: string | null | undefined, selected: MarketRef | null): boolean {
  if (!selected) return true;
  return selected.isHome ? !marketId || marketId === selected.id : marketId === selected.id;
}

/** The market id a row counts under: its market_id, or the home market's id when null. */
export function marketKey(marketId: string | null | undefined, homeId: string): string {
  return marketId ?? homeId;
}

/** `href` with `?market=` set to the selection (or "all"), keeping its other parameters. */
export function withMarketParam(href: string, selected: Pick<Market, "id"> | null): string {
  const [path, query = ""] = href.split("?");
  const q = new URLSearchParams(query);
  q.set(MARKET_PARAM, selected ? selected.id : MARKET_ALL);
  return `${path}?${q.toString()}`;
}

/**
 * Where the switcher returns to: `path` with the current parameters minus
 * `market` (the route handler sets it) and minus `drop` (e.g. an open panel or page number).
 */
export function switcherReturnTo(path: string, params: SearchParamsLike, drop: readonly string[] = ["panel", "page"]): string {
  const q = new URLSearchParams();
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x] as const) : v === undefined ? [] : [[k, v] as const]));
  for (const [k, v] of entries) if (k !== MARKET_PARAM && !drop.includes(k)) q.append(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * What the switcher's route handler does with a submitted `market` and `next`
 * (pure): the cookie to store (a valid market id or "all") and where to
 * redirect (`next`, checked by safeReturnPath, with `?market=` set).
 */
export function marketSwitchTarget(account: { id: string; slug: string }, markets: readonly { id: string }[], query: URLSearchParams) {
  const id = resolveMarketId(markets, query.get(MARKET_PARAM) || MARKET_ALL, null);
  return {
    location: withMarketParam(safeReturnPath(account.slug, query.get("next")), id ? { id } : null),
    cookie: {
      name: marketCookieName(account.id),
      value: id ?? MARKET_ALL,
      options: { path: "/", maxAge: MARKET_COOKIE_MAX_AGE, sameSite: "lax" as const, httpOnly: true },
    },
  };
}

/**
 * The switcher's return path, checked: only a path inside this account's
 * workspace (`/app/<slug>` or below) is accepted, anything else returns to Overview.
 */
export function safeReturnPath(slug: string, next: string | null | undefined): string {
  const base = `/app/${slug}`;
  if (!next || next.startsWith("//") || next.includes("\\")) return base;
  if (next === base || next.startsWith(`${base}/`) || next.startsWith(`${base}?`)) return next;
  return base;
}

/**
 * The market of a lead at intake (mvp-plan 3.13): every lead gets one, from
 * the intake key, the form's country field or the phone prefix, else the home
 * market (lib/markets/match.ts). The market also gives the lead its language
 * when the lead came without one.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { markets, sellerAccounts, type Market } from "@/db/schema";
import { isLocale, type Locale } from "@/lib/i18n";
import { matchMarket, type MatchReason } from "@/lib/markets/match";
import { listMarkets } from "@/lib/markets/service";
import { sanitizeOverrides } from "@/lib/markets/settings";
import type { LeadInput } from "./rules";

/** What intake needs to place leads: the account's markets (home first) and its default languages. */
export type LeadMarketContext = { markets: Market[]; accountLanguages: string[] };

/** Loads the markets once (creating the home market for an older account). Null when the account does not exist. */
export async function leadMarketContext(db: Db, accountId: string): Promise<LeadMarketContext | null> {
  // One round trip for the account and its markets (a CSV import counts its queries).
  const rows = await db
    .select({ languages: sellerAccounts.languages, market: markets })
    .from(sellerAccounts)
    .leftJoin(markets, eq(markets.accountId, sellerAccounts.id))
    .where(eq(sellerAccounts.id, accountId));
  if (rows.length === 0) return null;
  let list = rows.map((r) => r.market).filter((m): m is Market => !!m);
  if (!list.some((m) => m.isHome)) list = await listMarkets(db, accountId);
  list.sort((a, b) => Number(b.isHome) - Number(a.isHome) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return list.length > 0 ? { markets: list, accountLanguages: rows[0].languages } : null;
}

/** The market's first selling language: its own override, else the account's. */
export function marketLanguage(market: Pick<Market, "overrides">, accountLanguages: string[]): Locale | null {
  const langs = sanitizeOverrides(market.overrides).languages ?? accountLanguages;
  return langs.find(isLocale) ?? null;
}

export type LeadMarketHints = {
  /** The intake key the lead came with (webhook). */
  intakeKeyId?: string | null;
  /** lead_intake_keys.market_id of that key. */
  keyMarketId?: string | null;
};

export type ChosenMarket = { market: Market; reason: MatchReason | "chosen" };

/**
 * Picks the lead's market. A market the seller chose (input.marketId) wins when
 * it belongs to the account; then the intake key's market; then matchMarket.
 */
export function chooseLeadMarket(ctx: LeadMarketContext, input: Pick<LeadInput, "phone" | "formCountry" | "marketId">, hints: LeadMarketHints = {}): ChosenMarket {
  const byId = (id: string | null | undefined) => (id ? ctx.markets.find((m) => m.id === id) ?? null : null);
  const chosen = byId(input.marketId);
  if (chosen) return { market: chosen, reason: "chosen" };
  const keyMarket = byId(hints.keyMarketId);
  if (keyMarket) return { market: keyMarket, reason: "intake_key" };
  const r = matchMarket(ctx.markets, { phone: input.phone, formCountry: input.formCountry ?? null, intakeKeyId: hints.intakeKeyId ?? null });
  return { market: r.market ?? ctx.markets[0], reason: r.reason };
}

/** The input with its market set, and the market's language when the lead had none. */
export function applyLeadMarket(ctx: LeadMarketContext, input: LeadInput, hints: LeadMarketHints = {}): LeadInput & { marketId: string } {
  const { market } = chooseLeadMarket(ctx, input, hints);
  const language = input.languageFromDefault ? marketLanguage(market, ctx.accountLanguages) ?? input.language : input.language;
  return { ...input, marketId: market.id, language, languageFromDefault: false };
}

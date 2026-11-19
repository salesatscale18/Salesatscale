/**
 * The market switcher's target (components/sas/market-switcher.tsx): a GET
 * form submits `market` (a market id or "all") and `next` (the page to return
 * to). Stores the choice in the account's market cookie and redirects to
 * `next` with `?market=` set, so it works without JavaScript.
 * Only a signed-in member of the account gets here (requireAccount), only one
 * of the account's markets is stored, and `next` must stay inside this account.
 */
import { NextResponse, type NextRequest } from "next/server";
import { appDb, requireAccount } from "@/lib/auth/account";
import { listMarkets } from "@/lib/markets/service";
import { marketSwitchTarget } from "@/lib/markets/selection";

export async function GET(request: NextRequest, { params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const { account } = await requireAccount(slug);
  const markets = await listMarkets(appDb, account.id);
  const target = marketSwitchTarget(account, markets, request.nextUrl.searchParams);
  const response = NextResponse.redirect(new URL(target.location, request.url), 303);
  response.cookies.set(target.cookie.name, target.cookie.value, { ...target.cookie.options, secure: process.env.NODE_ENV === "production" });
  return response;
}

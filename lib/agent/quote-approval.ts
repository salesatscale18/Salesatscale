/**
 * The approval panel under a held quote in the seller's thread (board
 * QuoteSeller). Only existing quote services: approveQuote ("Approve and
 * send") and createQuoteVersion at the account's discount limit ("Send N%
 * instead", offered only when the discount is the only reason). The card
 * itself is replaced in place, since it reads the quote's current version.
 * Account admins only, checked here (server-side).
 */
import type { Db } from "@/db/types";
import type { AccountAccess } from "@/lib/accounts/service";
import { percentText } from "./quote-message";
import { approveQuote, createQuoteVersion, getQuote, type QuoteResult } from "@/lib/quotes/service";
import { customPricesOf, requestLinesOf } from "@/lib/quotes/pricing";

type Access = Pick<AccountAccess, "account" | "user" | "actingAs" | "role">;
type Refused = { ok: false; reason: "forbidden" | "quote_not_found" | "quote_closed" | "not_discount_only" };

/** Every member of a seller account is its admin today; a platform admin acting as one may approve too. */
export const mayApproveQuotes = (a: Pick<Access, "role">) => a.role === "seller_admin" || a.role === "platform_admin";

export async function approveHeldQuote(db: Db, a: Access, quoteId: string): Promise<QuoteResult | Refused> {
  if (!mayApproveQuotes(a)) return { ok: false, reason: "forbidden" };
  return approveQuote(db, a.account.id, { userId: a.user.id, actingAs: a.actingAs }, quoteId, {});
}

export async function sendHeldQuoteInLimit(db: Db, a: Access, quoteId: string): Promise<QuoteResult | Refused> {
  if (!mayApproveQuotes(a)) return { ok: false, reason: "forbidden" };
  const q = await getQuote(db, a.account.id, quoteId);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (q.quote.status !== "awaiting_approval") return { ok: false, reason: "quote_closed" };
  const current = q.versions.find((v) => v.version.version === q.quote.currentVersion);
  if (!current) return { ok: false, reason: "quote_not_found" };
  const reasons = current.version.approvalReasons;
  const over = reasons.find((r) => r.kind === "discount_over_limit");
  if (!over || over.kind !== "discount_over_limit" || reasons.some((r) => r.kind !== "discount_over_limit")) return { ok: false, reason: "not_discount_only" };
  return createQuoteVersion(
    db, a.account.id, { kind: "human", userId: a.user.id, actingAs: a.actingAs }, quoteId,
    { lines: requestLinesOf(current.lines), discountBp: over.limitBp, changeNote: `Sent with a ${percentText(over.limitBp)} discount, the limit` },
    new Date(), customPricesOf(current.lines),
  );
}

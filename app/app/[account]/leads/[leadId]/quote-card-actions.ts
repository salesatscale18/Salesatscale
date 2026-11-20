"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appDb, requireAccount } from "@/lib/auth/account";
import { approveHeldQuote, declineHeldQuote, sendHeldQuoteInLimit } from "@/lib/agent/quote-approval";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Back to the thread the panel was in (lead page or inbox), never off the account. */
function backTo(form: FormData, slug: string, notice: string) {
  const raw = String(form.get("back") ?? "");
  const base = `/app/${slug}/`;
  const safe = raw.startsWith(base) && !raw.includes("//", 1) && !/[\s\\]/.test(raw) ? raw : `/app/${slug}/conversations`;
  const [path, hash] = safe.split("#");
  return `${path}${path.includes("?") ? "&" : "?"}notice=${notice}${hash ? `#${hash}` : ""}`;
}

/**
 * The approval panel in the thread (board QuoteSeller). Reuses the quotes
 * service: approveQuote ("Approve and send") and createQuoteVersion at the
 * discount limit ("Send N% instead"). Account admins only, checked here.
 */
export async function approveQuoteInThreadAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = String(form.get("quoteId") ?? "");
  const r = UUID.test(quoteId) ? await approveHeldQuote(appDb, a, quoteId) : { ok: false as const };
  revalidatePath(`/app/${a.account.slug}`, "layout");
  redirect(backTo(form, a.account.slug, r.ok ? "quote_approved" : "quote_not_approved"));
}

export async function sendInLimitAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = String(form.get("quoteId") ?? "");
  const r = UUID.test(quoteId) ? await sendHeldQuoteInLimit(appDb, a, quoteId) : { ok: false as const };
  revalidatePath(`/app/${a.account.slug}`, "layout");
  redirect(backTo(form, a.account.slug, r.ok ? "quote_in_limit" : "quote_not_approved"));
}

/** "Decline" (O1 part 5): the held quote is withdrawn and the buyer is told; the agent continues from it. Account admins only, checked in declineHeldQuote. */
export async function declineQuoteInThreadAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = String(form.get("quoteId") ?? "");
  const r = UUID.test(quoteId) ? await declineHeldQuote(appDb, a, quoteId) : { ok: false as const };
  revalidatePath(`/app/${a.account.slug}`, "layout");
  redirect(backTo(form, a.account.slug, r.ok ? "quote_declined" : "quote_not_approved"));
}

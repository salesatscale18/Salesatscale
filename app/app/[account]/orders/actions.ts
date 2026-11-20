"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appDb, requireAccount } from "@/lib/auth/account";
import { parseMajorToMinor } from "@/lib/accounts/rules";
import { approveQuote, cancelQuote, getQuote } from "@/lib/quotes/service";
import { createOrderForm, markBankTransferReceived } from "@/lib/orders/service";
import { offerOrderFormInChat } from "@/lib/sms/outbound";
import { declineHeldQuote, followUpAfterApproval } from "@/lib/agent/quote-approval";

/** Ids come from the form: refuse anything that isn't a UUID before it reaches a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Approve form field: "price:<SKU>:<charge>". */
const PRICE_KEY = /^price:([A-Za-z0-9][A-Za-z0-9._-]{0,39}):(one_time|recurring)$/;

/** The quote id from the form, or back to the list when it is not a valid id. */
function quoteIdOf(form: FormData, slug: string) {
  const quoteId = String(form.get("quoteId") ?? "");
  if (!UUID.test(quoteId)) redirect(`/app/${slug}/orders`);
  return quoteId;
}

export async function approveQuoteAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = quoteIdOf(form, a.account.slug);
  // The quote's own currency (from its price list) decides the decimals.
  const quote = await getQuote(appDb, a.account.id, quoteId);
  const currency = quote?.versions[0]?.version.currency ?? a.account.currency;
  const customs: Record<string, number> = {};
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("price:") || !String(v).trim()) continue;
    // "price:<SKU>:<one_time|recurring>": a price per charge.
    const m = k.match(PRICE_KEY);
    if (!m) redirect(`/app/${a.account.slug}/orders?quote=${quoteId}&approve=invalid`);
    const minor = parseMajorToMinor(String(v), currency);
    if (minor === null) redirect(`/app/${a.account.slug}/orders?quote=${quoteId}&approve=invalid`);
    customs[`${m[1]}:${m[2]}`] = minor;
  }
  const r = await approveQuote(appDb, a.account.id, { userId: a.user.id, actingAs: a.actingAs }, quoteId, customs);
  // A quote the agent held in a chat: the card there now shows it, and the buyer gets the app's close (as from the thread's panel).
  if (r.ok) await followUpAfterApproval(appDb, a.account.id, quoteId);
  revalidatePath(`/app/${a.account.slug}/orders`);
  redirect(`/app/${a.account.slug}/orders?quote=${quoteId}${r.ok ? "&approved=1" : "&approve=" + r.reason}`);
}

/** "Decline" on a quote awaiting approval (O1 part 5): withdrawn, and the buyer is told in the chat. Admins only (checked in declineHeldQuote). */
export async function declineQuoteAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = quoteIdOf(form, a.account.slug);
  const r = await declineHeldQuote(appDb, a, quoteId);
  revalidatePath(`/app/${a.account.slug}/orders`);
  redirect(`/app/${a.account.slug}/orders?quote=${quoteId}${r.ok ? "&declined=1" : "&approve=" + r.reason}`);
}

export async function cancelQuoteAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = quoteIdOf(form, a.account.slug);
  await cancelQuote(appDb, a.account.id, { userId: a.user.id, actingAs: a.actingAs }, quoteId);
  revalidatePath(`/app/${a.account.slug}/orders`);
  redirect(`/app/${a.account.slug}/orders?quote=${quoteId}`);
}

export async function sendOrderFormAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = quoteIdOf(form, a.account.slug);
  const r = await createOrderForm(appDb, a.account.id, { kind: "human", userId: a.user.id, actingAs: a.actingAs }, quoteId, { language: String(form.get("language") ?? "") || undefined });
  // Every order-form send posts the form card in the buyer's chat and sends the "order form ready" SMS (reach spec).
  if (r.ok) await offerOrderFormInChat(appDb, { userId: a.user.id, actingAs: a.actingAs }, a.account.id, r.form.leadId, r.url);
  revalidatePath(`/app/${a.account.slug}/orders`);
  redirect(`/app/${a.account.slug}/orders?quote=${quoteId}${r.ok ? "&sent=1" : "&send=" + r.reason}`);
}

export async function markBankPaidAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = quoteIdOf(form, a.account.slug);
  const orderId = String(form.get("orderId") ?? "");
  if (!UUID.test(orderId)) redirect(`/app/${a.account.slug}/orders?quote=${quoteId}`);
  const r = await markBankTransferReceived(appDb, { userId: a.user.id, actingAs: a.actingAs }, a.account.id, orderId);
  revalidatePath(`/app/${a.account.slug}/orders`);
  redirect(`/app/${a.account.slug}/orders?quote=${quoteId}${r.ok ? "&marked=1" : ""}`);
}

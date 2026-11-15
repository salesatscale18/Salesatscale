"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appDb, requireAccount } from "@/lib/auth/account";
import { parseMajorToMinor } from "@/lib/accounts/rules";
import { approveQuote, cancelQuote } from "@/lib/quotes/service";
import { createOrderForm, markBankTransferReceived } from "@/lib/orders/service";

/** Ids come from the form: refuse anything that isn't a UUID before it reaches a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The quote id from the form, or back to the list when it is not a valid id. */
function quoteIdOf(form: FormData, slug: string) {
  const quoteId = String(form.get("quoteId") ?? "");
  if (!UUID.test(quoteId)) redirect(`/app/${slug}/orders`);
  return quoteId;
}

export async function approveQuoteAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = quoteIdOf(form, a.account.slug);
  const customs: Record<string, number> = {};
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("price:") || !String(v).trim()) continue;
    const minor = parseMajorToMinor(String(v), a.account.currency);
    if (minor === null) redirect(`/app/${a.account.slug}/orders?quote=${quoteId}&approve=invalid`);
    customs[k.slice(6)] = minor;
  }
  const r = await approveQuote(appDb, a.account.id, { userId: a.user.id, actingAs: a.actingAs }, quoteId, customs);
  revalidatePath(`/app/${a.account.slug}/orders`);
  redirect(`/app/${a.account.slug}/orders?quote=${quoteId}${r.ok ? "&approved=1" : "&approve=" + r.reason}`);
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

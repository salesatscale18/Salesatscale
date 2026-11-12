"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appDb, requireAccount } from "@/lib/auth/account";
import { parseMajorToMinor } from "@/lib/accounts/rules";
import { approveQuote, cancelQuote } from "@/lib/quotes/service";

export async function approveQuoteAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const quoteId = String(form.get("quoteId") ?? "");
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
  const quoteId = String(form.get("quoteId") ?? "");
  await cancelQuote(appDb, a.account.id, { userId: a.user.id, actingAs: a.actingAs }, quoteId);
  revalidatePath(`/app/${a.account.slug}/orders`);
  redirect(`/app/${a.account.slug}/orders?quote=${quoteId}`);
}

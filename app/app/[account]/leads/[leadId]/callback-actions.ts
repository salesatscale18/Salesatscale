"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appDb, requireAccount } from "@/lib/auth/account";
import { answerAfterCall, cancelCallback, changeCallback, confirmCallback, type SellerCallbackResult } from "@/lib/callbacks/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Back to the lead page with what happened: confirmed / changed (and whether the buyer was told), or why not. */
function done(slug: string, leadId: string, r: SellerCallbackResult): never {
  revalidatePath(`/app/${slug}/leads/${leadId}`);
  const q = r.ok
    ? `callback=${r.request.changed ? "changed" : "confirmed"}${r.buyer.told ? "" : `&callback_not_told=${r.buyer.reason}`}`
    : `callback_error=${r.reason}`;
  redirect(`/app/${slug}/leads/${leadId}?${q}#callback`);
}

/** Lead card: confirms the time the agent took. Admins only and account-scoped, checked in confirmCallback; audited; tells the buyer. */
export async function confirmCallbackAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const callbackId = String(form.get("callbackId") ?? "");
  if (!UUID.test(leadId) || !UUID.test(callbackId)) return;
  done(access.account.slug, leadId, await confirmCallback(appDb, access, leadId, callbackId));
}

/** Lead card: sets another time (date and time in the lead's time zone). Same checks as confirm. */
export async function changeCallbackAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const callbackId = String(form.get("callbackId") ?? "");
  if (!UUID.test(leadId) || !UUID.test(callbackId)) return;
  const input = { date: String(form.get("date") ?? "").trim(), time: String(form.get("time") ?? "").trim() };
  done(access.account.slug, leadId, await changeCallback(appDb, access, leadId, callbackId, input));
}

/** Lead card: cancels the call (after the confirm step) and tells the buyer. Admins only and account-scoped, checked in cancelCallback; audited. */
export async function cancelCallbackAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const callbackId = String(form.get("callbackId") ?? "");
  if (!UUID.test(leadId) || !UUID.test(callbackId)) return;
  const slug = access.account.slug;
  const r = await cancelCallback(appDb, access, leadId, callbackId);
  revalidatePath(`/app/${slug}/leads/${leadId}`);
  redirect(`/app/${slug}/leads/${leadId}?${r.ok ? `callback=cancelled${r.buyer.told ? "" : `&callback_not_told=${r.buyer.reason}`}` : `callback_error=${r.reason}`}#callback`);
}

/** "How did the call go?": back to the agent, or the seller takes the deal over (the Take over service). Admins only, account-scoped. */
export async function afterCallAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const callbackId = String(form.get("callbackId") ?? "");
  const choice = String(form.get("choice") ?? "");
  if (!UUID.test(leadId) || !UUID.test(callbackId) || (choice !== "agent" && choice !== "seller")) return;
  const slug = access.account.slug;
  const r = await answerAfterCall(appDb, access, leadId, callbackId, choice);
  revalidatePath(`/app/${slug}/leads/${leadId}`);
  redirect(`/app/${slug}/leads/${leadId}?${r.ok ? `after_call=${r.choice}` : `after_call_error=${r.reason}`}#callback`);
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appDb, requireAccount } from "@/lib/auth/account";
import { cancelFollowUp } from "@/lib/follow-ups/schedule";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lead card: cancels the scheduled follow-up (or dismisses a failed one). Admins only, checked in cancelFollowUp; audited. */
export async function cancelFollowUpAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const id = String(form.get("followUpId") ?? "");
  if (!UUID.test(id)) return;
  const r = await cancelFollowUp(appDb, access, id);
  if (!r.ok) return;
  revalidatePath(`/app/${access.account.slug}/leads/${r.leadId}`);
  redirect(`/app/${access.account.slug}/leads/${r.leadId}?follow_up=cancelled`);
}

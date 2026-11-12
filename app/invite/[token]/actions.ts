"use server";

import { redirect } from "next/navigation";
import { ensureUser } from "@/lib/ensure-user";
import { appDb, verifiedEmails } from "@/lib/auth/account";
import { acceptInvite } from "@/lib/accounts/service";

/** Accepts the invite for the signed-in user; all checks run in acceptInvite. */
export async function acceptInviteAction(form: FormData) {
  const me = await ensureUser();
  if (!me) redirect("/");
  const token = String(form.get("token") ?? "");
  const result = await acceptInvite(appDb, me, await verifiedEmails(), token);
  if (result.ok) redirect(`/app/${result.account.slug}`);
  // The page re-derives and shows the reason (expired, mismatch, ...).
  redirect(`/invite/${encodeURIComponent(token)}`);
}

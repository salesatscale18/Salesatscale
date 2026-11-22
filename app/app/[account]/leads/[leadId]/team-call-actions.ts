"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appDb, requireAccount } from "@/lib/auth/account";
import { logTeamCall } from "@/lib/team-calls/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deal tab › Log the call: saves the log, then runs the next step (hand back,
 * take over, order form, chat link; No answer texts the buyer). Admins only and
 * account-scoped, checked in logTeamCall; audited. "Send order form" without a
 * ready quote opens the quote editor (the existing manual quote → form path).
 */
export async function logTeamCallAction(form: FormData) {
  const access = await requireAccount(String(form.get("slug") ?? ""));
  const leadId = String(form.get("leadId") ?? "");
  const callbackId = String(form.get("callbackId") ?? "");
  if (!UUID.test(leadId) || !UUID.test(callbackId)) return;
  const slug = access.account.slug;
  const r = await logTeamCall(appDb, access, leadId, callbackId, {
    outcome: String(form.get("outcome") ?? ""), started: String(form.get("started") ?? ""), lengthMin: String(form.get("lengthMin") ?? ""),
    note: String(form.get("note") ?? ""), next: String(form.get("next") ?? "save"),
  });
  revalidatePath(`/app/${slug}/leads/${leadId}`);
  if (!r.ok) redirect(`/app/${slug}/leads/${leadId}?tab=deal&team_call_error=${r.reason}#callback`);
  if (r.next === "order_form" && r.orderForm === "no_quote") redirect(`/app/${slug}/leads/${leadId}/quote`);
  const notice = r.outcome !== "spoke" ? r.outcome : r.next === "order_form" && r.orderForm !== "sent" ? "order_form_failed" : r.next;
  redirect(`/app/${slug}/leads/${leadId}?tab=deal&team_call_notice=${notice}#callback`);
}

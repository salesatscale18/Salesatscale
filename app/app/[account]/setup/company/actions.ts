"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { parseCompany, saveCompany, saveDeliveryLeadTime, type CompanyErrors } from "@/lib/accounts/company";
import { leadTimeOrNull, parseLeadTime } from "@/lib/delivery/eta";

const path = (slug: string) => `/app/${slug}/setup/company`;

/**
 * Setup › Company save. The sales rep's membership is checked in saveCompany
 * (server-side). The Delivery section's lead time is saved with it (both
 * empty = not set); it is checked first so a bad range saves nothing.
 */
export async function saveCompanyAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const fail = (errors: CompanyErrors | string): never =>
    redirect(`${path(a.account.slug)}?error=${encodeURIComponent(typeof errors === "string" ? errors : Object.values(errors).find(Boolean) ?? "")}`);
  const parsed = parseCompany(raw);
  const lead = parseLeadTime(raw);
  if (!parsed.ok) fail(parsed.errors);
  else if (!lead.ok) fail(lead.error);
  else {
    const r = await saveCompany(appDb, actorOf(a), a.account.id, parsed.value);
    if (!r.ok) fail(r.errors);
    // Written (and audited) only when it changed.
    if (JSON.stringify(leadTimeOrNull(a.account.deliveryLeadTime)) !== JSON.stringify(lead.value)) {
      await saveDeliveryLeadTime(appDb, actorOf(a), a.account.id, lead.value);
    }
  }
  revalidatePath(`/app/${a.account.slug}`, "layout");
  redirect(`${path(a.account.slug)}?saved=1`);
}

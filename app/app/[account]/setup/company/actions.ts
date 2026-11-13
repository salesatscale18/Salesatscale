"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { parseCompany, saveCompany, type CompanyErrors } from "@/lib/accounts/company";

const path = (slug: string) => `/app/${slug}/setup/company`;

/** Setup › Company save. The sales rep's membership is checked in saveCompany (server-side). */
export async function saveCompanyAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const fail = (errors: CompanyErrors): never =>
    redirect(`${path(a.account.slug)}?error=${encodeURIComponent(Object.values(errors).find(Boolean) ?? "")}`);
  const parsed = parseCompany(raw);
  if (!parsed.ok) fail(parsed.errors);
  else {
    const r = await saveCompany(appDb, actorOf(a), a.account.id, parsed.value);
    if (!r.ok) fail(r.errors);
  }
  revalidatePath(`/app/${a.account.slug}`, "layout");
  redirect(`${path(a.account.slug)}?saved=1`);
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { addFact, removeFact } from "@/lib/agent/service";

const path = (slug: string) => `/app/${slug}/setup/knowledge`;

export async function addFactAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const topic = String(form.get("topic") ?? "").trim();
  const statement = String(form.get("statement") ?? "").trim();
  if (!topic || !statement) redirect(`${path(a.account.slug)}?error=1`);
  const f = await addFact(appDb, actorOf(a), a.account.id, { topic, statement, sourceLabel: String(form.get("source") ?? "") });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_added", targetType: "knowledge_fact", targetId: f.id });
  revalidatePath(path(a.account.slug));
  redirect(`${path(a.account.slug)}?added=1`);
}

export async function removeFactAction(form: FormData) {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const id = String(form.get("factId") ?? "");
  await removeFact(appDb, a.account.id, id);
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "knowledge.fact_removed", targetType: "knowledge_fact", targetId: id });
  revalidatePath(path(a.account.slug));
  redirect(path(a.account.slug));
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { parsePlaybookForm } from "@/lib/agent/playbook";
import { saveDraftPlaybook } from "@/lib/agent/service";

export type PlaybookFormState = { status: "idle" } | { status: "error"; errors: Record<string, string> };

export async function savePlaybookAction(_prev: PlaybookFormState, form: FormData): Promise<PlaybookFormState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const raw = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const parsed = parsePlaybookForm(raw);
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  await saveDraftPlaybook(appDb, a.account.id, parsed.value);
  if (a.actingAs) await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "agent.playbook_saved" });
  revalidatePath(`/app/${a.account.slug}/setup/playbook`);
  redirect(`/app/${a.account.slug}/setup/playbook?saved=1`);
}

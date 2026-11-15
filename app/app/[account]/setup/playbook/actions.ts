"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { parsePlaybookRows, playbookRowsFromForm, type PlaybookErrors, type PlaybookRowsInput } from "@/lib/agent/playbook";
import { saveDraftPlaybook } from "@/lib/agent/service";

/**
 * On a refused save the submitted values come back, so the form shows what
 * the seller typed (React resets uncontrolled inputs to their defaultValue
 * after an action; without this, edits were lost and the next save stored
 * the old values).
 */
export type PlaybookFormState = { status: "idle" } | { status: "error"; errors: PlaybookErrors; values: PlaybookRowsInput };

/** Saves the whole playbook into the draft version. Every rule is checked here (parsePlaybookRows), not in the browser. */
export async function savePlaybookAction(_prev: PlaybookFormState, form: FormData): Promise<PlaybookFormState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const entries = [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""] as [string, string]);
  const input = playbookRowsFromForm(entries);
  const parsed = parsePlaybookRows(input);
  if (!parsed.ok) return { status: "error", errors: parsed.errors, values: input };
  await saveDraftPlaybook(appDb, a.account.id, parsed.value);
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "agent.playbook_saved" });
  revalidatePath(`/app/${a.account.slug}/setup/playbook`);
  redirect(`/app/${a.account.slug}/setup/playbook?saved=1`);
}

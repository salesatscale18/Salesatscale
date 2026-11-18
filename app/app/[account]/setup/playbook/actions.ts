"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import type { PlaybookErrors, PlaybookRowsInput } from "@/lib/agent/playbook";
import { savePlaybookForm } from "@/lib/agent/playbook-save";
import { autoNameModel } from "@/lib/agent/names-auto";

/**
 * On a refused save the submitted values come back, so the form shows what
 * the seller typed (React resets uncontrolled inputs to their defaultValue
 * after an action; without this, edits were lost and the next save stored
 * the old values).
 */
export type PlaybookFormState = { status: "idle" } | { status: "error"; errors: PlaybookErrors; values: PlaybookRowsInput };

/** Saves the whole playbook into the draft version. Every rule is checked on the server (savePlaybookForm), not in the browser. */
export async function savePlaybookAction(_prev: PlaybookFormState, form: FormData): Promise<PlaybookFormState> {
  const a = await requireAccount(String(form.get("slug") ?? ""));
  const entries = [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""] as [string, string]);
  // Automatic name versions are made here, once, when the name or the market languages changed (C2).
  const r = await savePlaybookForm(appDb, a.account.id, entries, { names: autoNameModel(), actor: actorOf(a) });
  if (!r.ok) return { status: "error", errors: r.errors, values: r.values };
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "agent.playbook_saved" });
  revalidatePath(`/app/${a.account.slug}/setup/playbook`);
  redirect(`/app/${a.account.slug}/setup/playbook?saved=1`);
}
